import { and, desc, eq, gte } from "drizzle-orm";
import { schema } from "../infra/db/index.js";
import { PLAIN_BOX, SecretBox } from "../infra/secrets.js";
import { appConfigFromEnv, installationInfo, installationRepos, userCanAccessInstallation, type GitHubAppConfig } from "../infra/github/app.js";
import type { ConnectorsView, InstallationRepo } from "../shared/types.js";
import { emit, ForbiddenError, GenerationConflictError, isTrusted, NotFoundError, type AppContext } from "./context.js";
import { listSources, upsertSource } from "./sources.js";
import { localeOf, say } from "./i18n.js";

/**
 * 커넥터: GitHub(App 설치 또는 서버 토큰), 세션 업로더. 화면 요약과 GitHub App 설치 기록.
 * App 자격 증명은 환경변수(GITHUB_APP_*)가 우선이고, 매니페스트 플로우로 만든 것은 app_state에 저장된다.
 */
export function githubAppConfig(ctx: AppContext): GitHubAppConfig | null {
  const fromEnv = appConfigFromEnv(process.env);
  if (fromEnv) return fromEnv;
  const row = ctx.db.select().from(schema.appState).where(eq(schema.appState.key, "github_app")).get();
  if (!row) return null;
  const j = JSON.parse((ctx.env.secrets ?? PLAIN_BOX).open(row.value)) as { id: number; pem: string; slug: string; webhook_secret?: string; client_id?: string; client_secret?: string };
  return { appId: String(j.id), privateKeyPem: j.pem, slug: j.slug, webhookSecret: j.webhook_secret, clientId: j.client_id, clientSecret: j.client_secret };
}

/** 평문으로 저장된 GitHub App 자격 증명을 봉인한다(키를 새로 설정한 뒤 시작할 때). */
export function resealGithubApp(ctx: AppContext): boolean {
  const box = ctx.env.secrets ?? PLAIN_BOX;
  const row = ctx.db.select().from(schema.appState).where(eq(schema.appState.key, "github_app")).get();
  if (!box.enabled || !row || SecretBox.isSealed(row.value)) return false;
  ctx.db.update(schema.appState).set({ value: box.seal(row.value), updatedAt: Date.now() }).where(eq(schema.appState.key, "github_app")).run();
  return true;
}

export function saveGithubApp(ctx: AppContext, app: { id: number; pem: string; slug: string; webhook_secret?: string; client_id?: string; client_secret?: string }): boolean {
  // 개인키가 들어 있으므로 봉인해 저장한다(SOMUN_SECRET_KEY가 있을 때).
  const value = (ctx.env.secrets ?? PLAIN_BOX).seal(JSON.stringify(app));
  return ctx.db.insert(schema.appState).values({ key: "github_app", value, updatedAt: Date.now() }).onConflictDoNothing().run().changes > 0;
}

export function listInstallations(ctx: AppContext, ownerId: string) {
  return ctx.db.select().from(schema.githubInstallations).where(eq(schema.githubInstallations.ownerId, ownerId)).all();
}

/** 설치 콜백: 설치 정보를 읽어 기록하고, 설치 저장소를 github 소스로 등록한다. */
/**
 * 설치 기록. 처음 연결할 때는 요청한 사람이 그 설치에 접근할 수 있다는 증거가 필요하다:
 * 설치 중 사용자 인증(OAuth)의 code로 확인하거나, 운영자(trustedOwners)여야 한다. installation_id만으로는 연결하지 않는다.
 * 이미 이 계정에 연결된 설치를 갱신하는 것(설정 변경 뒤 콜백, webhook)은 확인 없이 된다.
 */
export async function recordInstallation(ctx: AppContext, ownerId: string, installationId: number, proof: { code?: string } = {}): Promise<{ account: string; repos: string[] }> {
  const cfg = githubAppConfig(ctx);
  const lc = localeOf(ctx, ownerId);
  if (!cfg) throw new Error(say(lc, "GitHub App이 설정되지 않았습니다.", "The GitHub App is not configured."));
  const existingOwner = ownerOfInstallation(ctx, installationId);
  if (existingOwner && existingOwner !== ownerId) throw new GenerationConflictError(say(lc, "이미 다른 계정에 연결된 설치입니다.", "This installation is already linked to another account."));
  if (!existingOwner && !isTrusted(ctx, ownerId)) {
    if (!proof.code || !cfg.clientId || !cfg.clientSecret) throw new ForbiddenError(say(lc, "GitHub 설치를 확인할 수 없습니다. 설치 화면에서 GitHub 계정 인증까지 마쳐 주세요(운영자는 앱 설정에서 '설치 중 사용자 인증'을 켜야 합니다).", "Could not verify this GitHub installation. Finish the GitHub account authorization during install (the operator must enable user authorization during installation in the app settings)."));
    if (!await userCanAccessInstallation(cfg, proof.code, installationId)) throw new ForbiddenError(say(lc, "이 GitHub 계정으로 접근할 수 없는 설치입니다.", "This GitHub account cannot access that installation."));
  }
  const info = await installationInfo(cfg, installationId);
  const now = Date.now();
  const saved = ctx.db.insert(schema.githubInstallations).values({ installationId, ownerId, account: info.account, accountType: info.accountType, repos: info.repos, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: schema.githubInstallations.installationId, set: { account: info.account, accountType: info.accountType, repos: info.repos, updatedAt: now }, setWhere: eq(schema.githubInstallations.ownerId, ownerId) }).run();
  if (!saved.changes) throw new GenerationConflictError(say(localeOf(ctx, ownerId), "이미 다른 계정에 연결된 설치입니다.", "This installation is already linked to another account."));
  // 설치 저장소 → 소스. 이미 있는 github 소스는 대상만 갱신.
  const existing = listSources(ctx, ownerId).find((s) => s.kind === "github" && s.options?.installationId === String(installationId));
  // 처음 설치면 아무것도 지켜보지 않는다. 무엇을 볼지는 고르기 화면(/github/pick)에서 사용자가 정한다.
  // 이미 소스가 있으면 사용자가 고른 대상을 유지한다.
  upsertSource(ctx, ownerId, { id: existing?.id, kind: "github", targets: existing?.targets ?? [], options: { installationId: String(installationId), account: info.account }, enabled: true });
  emit(ctx, ownerId, { resource: "sources" });
  return { account: info.account, repos: info.repos };
}

export function removeInstallation(ctx: AppContext, installationId: number): void {
  const row = ctx.db.select().from(schema.githubInstallations).where(eq(schema.githubInstallations.installationId, installationId)).get();
  if (!row) return;
  ctx.db.delete(schema.githubInstallations).where(eq(schema.githubInstallations.installationId, installationId)).run();
  const src = listSources(ctx, row.ownerId).find((s) => s.options?.installationId === String(installationId));
  if (src) ctx.db.delete(schema.sources).where(eq(schema.sources.id, src.id)).run();
  emit(ctx, row.ownerId, { resource: "sources" });
}

/** webhook의 installation id → ownerId. */
export function ownerOfInstallation(ctx: AppContext, installationId: number): string | null {
  return ctx.db.select().from(schema.githubInstallations).where(eq(schema.githubInstallations.installationId, installationId)).get()?.ownerId ?? null;
}

export function connectorsView(ctx: AppContext, ownerId: string): ConnectorsView {
  const cfg = githubAppConfig(ctx);
  const sources = listSources(ctx, ownerId);
  const gh = sources.filter((s) => s.kind === "github");
  const inst = listInstallations(ctx, ownerId);
  const manual = gh.filter((s) => !s.options?.installationId).flatMap((s) => s.targets);
  const since = Date.now() - 14 * 86400e3;
  const sess = ctx.db.select().from(schema.signals).where(and(eq(schema.signals.ownerId, ownerId), eq(schema.signals.kind, "omp_session"), gte(schema.signals.occurredAt, since))).all();
  const lastUpload = ctx.db.select().from(schema.sources).where(and(eq(schema.sources.ownerId, ownerId), eq(schema.sources.kind, "sessions"))).orderBy(desc(schema.sources.lastPolledAt)).get()?.lastPolledAt ?? undefined;
  return {
    github: {
      mode: inst.length ? "app" : gh.length && ctx.env.githubToken ? "token" : "none",
      appConfigured: Boolean(cfg),
      appSlug: cfg?.slug,
      installUrl: cfg?.slug ? `https://github.com/apps/${cfg.slug}/installations/new` : undefined,
      installations: inst.map((i) => ({ id: i.installationId, account: i.account, repos: i.repos.length, watched: gh.find((s) => s.options?.installationId === String(i.installationId))?.targets.length ?? 0, updatedAt: i.updatedAt })),
      manualTargets: manual,
      lastPolledAt: gh.map((s) => s.lastPolledAt ?? 0).sort().at(-1) || undefined,
      lastError: gh.find((s) => s.lastError)?.lastError,
    },
    sessions: { lastUploadAt: lastUpload, sessionCount14d: sess.length, sources: [...new Set(sess.map((s) => String((s.payload as { source?: string })?.source ?? "")).filter(Boolean))] },
  };
}

function installationSource(ctx: AppContext, ownerId: string, installationId: number) {
  return listSources(ctx, ownerId).find((s) => s.kind === "github" && s.options?.installationId === String(installationId));
}

/** 고르기 화면: 설치가 볼 수 있는 저장소 + 지금 지켜보는지. */
export async function listInstallationRepos(ctx: AppContext, ownerId: string, installationId: number): Promise<InstallationRepo[]> {
  const inst = listInstallations(ctx, ownerId).find((i) => i.installationId === installationId);
  if (!inst) throw new NotFoundError("installation");
  const cfg = githubAppConfig(ctx);
  if (!cfg) throw new Error(say(localeOf(ctx, ownerId), "GitHub App이 설정되지 않았습니다.", "The GitHub App is not configured."));
  const watched = new Set(installationSource(ctx, ownerId, installationId)?.targets ?? []);
  const repos = await installationRepos(cfg, installationId);
  return repos.map((r) => ({ ...r, watched: watched.has(r.fullName) })).sort((a, b) => (b.pushedAt ?? 0) - (a.pushedAt ?? 0));
}

/** 지켜볼 저장소를 정한다. 소스의 targets를 통째로 바꾼다. */
export function setWatchedRepos(ctx: AppContext, ownerId: string, installationId: number, repos: string[]): { sourceId: number; count: number } {
  const inst = listInstallations(ctx, ownerId).find((i) => i.installationId === installationId);
  if (!inst) throw new NotFoundError("installation");
  const allowed = new Set(inst.repos);
  const targets = [...new Set(repos.filter((r) => allowed.has(r)))];
  const existing = installationSource(ctx, ownerId, installationId);
  const src = upsertSource(ctx, ownerId, { id: existing?.id, kind: "github", targets, options: { installationId: String(installationId), account: inst.account }, enabled: true });
  return { sourceId: src.id, count: targets.length };
}
