import { and, desc, eq, gte, like, lt, or, sql } from "drizzle-orm";
import { schema } from "../infra/db/index.js";
import { PLAIN_BOX, SecretBox } from "../infra/secrets.js";
import { createHash, randomBytes } from "node:crypto";
import { appConfigFromEnv, authorizedGithubUser, installationInfo, installationRepos, type GitHubAppConfig } from "../infra/github/app.js";
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
  // 매니페스트로 만든 앱에 client 정보가 없으면(이 기능 전에 만든 앱) 환경변수로 채울 수 있다.
  return { appId: String(j.id), privateKeyPem: j.pem, slug: j.slug, webhookSecret: j.webhook_secret, clientId: j.client_id ?? (process.env.GITHUB_APP_CLIENT_ID || undefined), clientSecret: j.client_secret ?? (process.env.GITHUB_APP_CLIENT_SECRET || undefined) };
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
const INSTALL_STATE_TTL_MS = 30 * 60_000;
/** 조직 설치에서 webhook(설치자)을 기다리는 시간: 1초씩 최대 10번. 테스트는 줄여 쓴다. */
export let INSTALLER_WAIT_TRIES = 10;
const INSTALLER_WAIT_MS = 1000;
export const setInstallerWaitForTests = (tries: number): void => { INSTALLER_WAIT_TRIES = tries; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stateKey = (state: string) => `install_state:${createHash("sha256").update(state).digest("hex")}`;

/**
 * 설치 링크. 이 계정에서 시작한 설치임을 콜백에서 확인할 1회용 state를 붙인다(남이 만든 code·installation_id를
 * 내 세션에 주입하는 공격을 막는다). 30분 유효.
 */
export function issueInstallLink(ctx: AppContext, ownerId: string): string | undefined {
  const cfg = githubAppConfig(ctx);
  if (!cfg?.slug) return undefined;
  pruneInstallRecords(ctx);
  const state = randomBytes(24).toString("base64url");
  const now = Date.now();
  ctx.db.insert(schema.appState).values({ key: stateKey(state), value: JSON.stringify({ ownerId, exp: now + INSTALL_STATE_TTL_MS }), updatedAt: now }).run();
  return `https://github.com/apps/${cfg.slug}/installations/new?state=${state}`;
}

function consumeInstallState(ctx: AppContext, ownerId: string, state: string): boolean {
  const key = stateKey(state);
  const row = ctx.db.select().from(schema.appState).where(eq(schema.appState.key, key)).get();
  ctx.db.delete(schema.appState).where(eq(schema.appState.key, key)).run();
  if (!row) return false;
  const v = JSON.parse(row.value) as { ownerId: string; exp: number };
  return v.ownerId === ownerId && v.exp >= Date.now();
}

/**
 * 확인을 마친 GitHub 사용자를 잠시(30분) 기억한다. 조직 설치에서 webhook(설치자 정보)이 콜백보다 늦게 오면,
 * state와 code는 이미 한 번 쓰였으므로 새로고침 때 이 기록으로 다시 확인한다.
 */
const pendingKey = (installationId: number, ownerId: string) => `pending_link:${installationId}:${createHash("sha256").update(ownerId).digest("hex").slice(0, 32)}`;
function rememberVerifiedUser(ctx: AppContext, installationId: number, ownerId: string, user: { id: number; login: string }): void {
  const value = JSON.stringify({ user, exp: Date.now() + INSTALL_STATE_TTL_MS });
  ctx.db.insert(schema.appState).values({ key: pendingKey(installationId, ownerId), value, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: schema.appState.key, set: { value, updatedAt: Date.now() } }).run();
}
function verifiedUser(ctx: AppContext, installationId: number, ownerId: string): { id: number; login: string } | undefined {
  const row = ctx.db.select().from(schema.appState).where(eq(schema.appState.key, pendingKey(installationId, ownerId))).get();
  if (!row) return undefined;
  const v = JSON.parse(row.value) as { user: { id: number; login: string }; exp: number };
  return v.exp >= Date.now() ? v.user : undefined;
}

/** 만료된 설치 state·확인 기록과, 30일 넘게 연결되지 않은 설치자 기록을 지운다. */
export function pruneInstallRecords(ctx: AppContext, now = Date.now()): number {
  const expired = ctx.db.delete(schema.appState).where(and(or(like(schema.appState.key, "install_state:%"), like(schema.appState.key, "pending_link:%")), sql`json_extract(${schema.appState.value}, '$.exp') < ${now}`)).run().changes;
  const stale = ctx.db.delete(schema.appState).where(and(like(schema.appState.key, "installer:%"), lt(schema.appState.updatedAt, now - 30 * 86_400_000))).run().changes;
  return expired + stale;
}

/** webhook installation 이벤트가 알려준 설치자(sender). 조직 설치에서 "설치한 사람"을 확인하는 데 쓴다. */
export function recordInstaller(ctx: AppContext, installationId: number, sender: { id: number; login: string }): void {
  const value = JSON.stringify({ id: sender.id, login: sender.login });
  ctx.db.insert(schema.appState).values({ key: `installer:${installationId}`, value, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: schema.appState.key, set: { value, updatedAt: Date.now() } }).run();
}
function installerOf(ctx: AppContext, installationId: number): { id: number; login: string } | undefined {
  const row = ctx.db.select().from(schema.appState).where(eq(schema.appState.key, `installer:${installationId}`)).get();
  return row ? JSON.parse(row.value) : undefined;
}

/**
 * 설치 기록. 처음 연결할 때는 요청한 사람이 그 설치를 한 본인이라는 증거가 필요하다(운영자는 예외):
 *  1. 이 계정이 만든 설치 링크의 state가 콜백에 돌아와야 한다.
 *  2. 설치 중 사용자 인증(OAuth)의 code로 GitHub 사용자를 확인한다.
 *  3. 개인 계정 설치면 그 계정 본인, 조직 설치면 webhook이 알려준 설치자와 같아야 한다.
 *     (설치를 "볼 수 있는" 사람은 저장소 하나만 읽어도 되므로 증거가 아니다.)
 * 이미 이 계정에 연결된 설치를 webhook이 갱신하는 것은 확인 없이 된다.
 */
export async function recordInstallation(ctx: AppContext, ownerId: string, installationId: number, proof: { code?: string; state?: string } = {}): Promise<{ account: string; repos: string[] }> {
  const cfg = githubAppConfig(ctx);
  const lc = localeOf(ctx, ownerId);
  if (!cfg) throw new Error(say(lc, "GitHub App이 설정되지 않았습니다.", "The GitHub App is not configured."));
  const existingOwner = ownerOfInstallation(ctx, installationId);
  if (existingOwner && existingOwner !== ownerId) throw new GenerationConflictError(say(lc, "이미 다른 계정에 연결된 설치입니다.", "This installation is already linked to another account."));
  const needsProof = !existingOwner && !isTrusted(ctx, ownerId);
  let user: { id: number; login: string } | undefined;
  if (needsProof) {
    // 새로고침으로 다시 온 경우: 30분 안에 확인을 마친 사용자가 있으면 그것을 쓴다(state·code는 한 번만 쓰인다).
    user = proof.code || proof.state ? undefined : verifiedUser(ctx, installationId, ownerId);
    if (!user) {
      if (!proof.state || !consumeInstallState(ctx, ownerId, proof.state)) throw new ForbiddenError(say(lc, "이 계정에서 시작한 설치가 아닙니다. 연결 관리 화면의 버튼으로 다시 설치해 주세요.", "This installation was not started from this account. Install again from the Connections page."));
      if (!proof.code || !cfg.clientId || !cfg.clientSecret) throw new ForbiddenError(say(lc, "GitHub 설치를 확인할 수 없습니다. 설치 화면에서 GitHub 계정 인증까지 마쳐 주세요(운영자는 앱 설정에서 '설치 중 사용자 인증'을 켜야 합니다).", "Could not verify this GitHub installation. Finish the GitHub account authorization during install (the operator must enable user authorization during installation in the app settings)."));
      user = (await authorizedGithubUser(cfg, proof.code)) ?? undefined;
      if (!user) throw new ForbiddenError(say(lc, "GitHub 계정을 확인하지 못했습니다. 다시 설치해 주세요.", "Could not verify your GitHub account. Please install again."));
      rememberVerifiedUser(ctx, installationId, ownerId, user);
    }
  }
  const info = await installationInfo(cfg, installationId);
  if (user) {
    const own = info.accountType === "User" && info.account.toLowerCase() === user.login.toLowerCase();
    // 조직 설치의 설치자는 webhook으로 온다. 브라우저가 먼저 도착하면 잠시 기다린다.
    if (!own) for (let i = 0; i < INSTALLER_WAIT_TRIES && !installerOf(ctx, installationId); i++) await sleep(INSTALLER_WAIT_MS);
    if (!own && installerOf(ctx, installationId)?.id !== user.id) throw new ForbiddenError(say(lc, "이 설치를 한 GitHub 계정만 연결할 수 있습니다. 조직 설치라면 잠시 뒤 이 페이지를 새로고침해 주세요(30분 안).", "Only the GitHub account that made this installation can link it. For an organization installation, reload this page in a moment (within 30 minutes)."));
  }
  const now = Date.now();
  const saved = ctx.db.insert(schema.githubInstallations).values({ installationId, ownerId, account: info.account, accountType: info.accountType, repos: info.repos, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: schema.githubInstallations.installationId, set: { account: info.account, accountType: info.accountType, repos: info.repos, updatedAt: now }, setWhere: eq(schema.githubInstallations.ownerId, ownerId) }).run();
  if (!saved.changes) throw new GenerationConflictError(say(localeOf(ctx, ownerId), "이미 다른 계정에 연결된 설치입니다.", "This installation is already linked to another account."));
  // 설치 저장소 → 소스. 이미 있는 github 소스는 대상만 갱신.
  const existing = listSources(ctx, ownerId).find((s) => s.kind === "github" && s.options?.installationId === String(installationId));
  // 처음 설치면 아무것도 지켜보지 않는다. 무엇을 볼지는 고르기 화면(/github/pick)에서 사용자가 정한다.
  // 이미 소스가 있으면 사용자가 고른 대상을 유지한다.
  upsertSource(ctx, ownerId, { id: existing?.id, kind: "github", targets: existing?.targets ?? [], options: { installationId: String(installationId), account: info.account }, enabled: true });
  // 연결을 마쳤으니 확인용 기록은 필요 없다.
  ctx.db.delete(schema.appState).where(or(eq(schema.appState.key, pendingKey(installationId, ownerId)), eq(schema.appState.key, `installer:${installationId}`))).run();
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
