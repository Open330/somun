import { crossedThreshold, DOWNLOAD_THRESHOLDS, STAR_THRESHOLDS } from "../core/cluster.js";
import { installationToken } from "../infra/github/app.js";
import { GitHubClient, GitHubRateLimitError, type GhPull, type GhRelease, type GhRepo } from "../infra/github/client.js";
import { githubAppConfig, ownerOfInstallation } from "./connectors.js";
import type { Evidence } from "../shared/types.js";
import { refreshEvidence } from "./candidates.js";
import { ensureProfile } from "./profiles.js";
import { getSettings } from "./settings.js";
import { lastDigestAt } from "./ledger.js";
import { collectBlogSource } from "./collect-blog.js";
import { NotFoundError, type AppContext } from "./context.js";
import { processNewCandidates } from "./pipeline.js";
import { lastSnapshot, snapshotMetrics } from "./publications.js";
import { ingestSignals, latestForRepo, type IncomingSignal } from "./signals.js";
import { listEnabledSources, markPolled } from "./sources.js";

const DAY = 24 * 3600 * 1000;

/**
 * GitHub·npm 수집기. 크론과 "지금 확인"이 같은 함수를 부른다.
 * 저장소별로: 릴리스·머지 PR·새 레포·스타/다운로드 임계 신호, 근거 갱신, 지표 스냅샷, 릴리스 후보 병합.
 */

async function expandTargets(gh: GitHubClient, targets: string[], publicOnly = false): Promise<GhRepo[]> {
  const repos: GhRepo[] = [];
  for (const t of targets) {
    if (t.includes("/")) {
      const r = await gh.get<GhRepo>(`/repos/${t}`);
      if (r) repos.push(r);
      continue;
    }
    for (let page = 1; page <= 5; page++) {
      const list = (await gh.get<GhRepo[]>(`/orgs/${t}/repos?per_page=100&page=${page}&sort=pushed`)) ?? (await gh.get<GhRepo[]>(`/users/${t}/repos?per_page=100&page=${page}&sort=pushed`));
      if (!list?.length) break;
      repos.push(...list);
      if (list.length < 100) break;
    }
  }
  // 최근에 움직인 저장소부터. 프로필 생성 예산(수집당 25개)이 활발한 저장소에 먼저 쓰인다.
  return repos.filter((r) => !r.fork && !r.archived && !(publicOnly && r.private !== false) && Date.now() - Date.parse(r.pushed_at) < 60 * DAY).sort((a, b) => Date.parse(b.pushed_at) - Date.parse(a.pushed_at));
}

/** README의 첫 데모 자산. gif/mp4/webm 우선, 없으면 로고가 아닌 이미지. */
export function firstDemoAsset(readme: string): string | undefined {
  const all = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+\.(?:gif|mp4|webm|png|jpe?g))\)/gi), ...readme.matchAll(/<(?:img|source)[^>]+src="([^"]+\.(?:gif|mp4|webm|png|jpe?g))"/gi)].map((m) => m[1]);
  return all.find((u) => /\.(gif|mp4|webm)$/i.test(u)) ?? all.find((u) => !/logo|badge|shields\.io|icon/i.test(u));
}

/** README의 한계: 경고 블록(IMPORTANT/WARNING)과 Limitations 절. */
export function limitationsFrom(readme: string): string[] {
  const notes: string[] = [];
  // 경고 블록은 운영 메모("X 바꾸면 Y 실행")인 경우가 많다. 제품의 한계를 말하는 문장일 때만 쓴다.
  const LIMIT_WORDS = /not (?:yet )?support|does ?n['’]?t|do ?n['’]?t|cannot|can['’]?t|only|yet|beta|experimental|limitation|unstable|아직|미지원|안 됩니다|안 됨|불가|제한|지원하지 않|실험/i;
  const alert = /\[!(?:IMPORTANT|WARNING|CAUTION)\]\s*\n((?:>.*\n?){1,4})/i.exec(readme);
  if (alert) {
    const text = alert[1].replace(/^>\s?/gm, "").replace(/\s+/g, " ").trim().slice(0, 240);
    if (LIMIT_WORDS.test(text)) notes.push(text);
  }
  const m = /(?:^|\n)#+\s*(?:limitations?|known issues|caveats|not (?:yet )?supported|한계|제한|아직 안 되는 것)[^\n]*\n([\s\S]{0,1200}?)(?:\n#+\s|$)/i.exec(readme);
  if (m) notes.push(...m[1].split("\n").map((l) => l.replace(/^[-*\d.\s]+/, "").trim()).filter((l) => l.length > 8));
  return notes.slice(0, 5);
}

/** 수집 한 번에 만드는 프로필 수 상한. 분석 모델 호출 1회/저장소. */
export const PROFILE_BUDGET = 25;
/** local-agent 모드의 상한. 워커가 CLI를 하나씩 돌리므로 작게 둔다. */
export const PROFILE_BUDGET_LOCAL = 5;

/**
 * 소유자가 GitHub를 읽을 토큰. 설치 토큰은 그 설치를 연결한 소유자만 쓴다.
 * 서버 토큰은 허용된 소유자(githubTokenOwners)만 비공개 저장소까지 읽고, 나머지는 공개 저장소만(publicOnly).
 */
export async function githubAccess(ctx: AppContext, ownerId: string, installationId?: number): Promise<{ gh: GitHubClient; publicOnly: boolean }> {
  if (installationId) {
    if (ownerOfInstallation(ctx, installationId) !== ownerId) throw new Error("이 계정에 연결된 GitHub 설치가 아닙니다.");
    const cfg = githubAppConfig(ctx);
    if (!cfg) throw new Error("GitHub App이 설정되지 않았습니다.");
    return { gh: new GitHubClient(await installationToken(cfg, installationId)), publicOnly: false };
  }
  if (!ctx.env.githubToken) throw new Error("GitHub 토큰이 없습니다. GitHub App을 설치하거나 GITHUB_TOKEN을 설정하세요.");
  const allowed = ctx.env.githubTokenOwners;
  return { gh: new GitHubClient(ctx.env.githubToken), publicOnly: allowed !== undefined && !allowed.includes(ownerId) };
}

/** 저장소 하나의 프로필 재료를 GitHub에서 읽는다 (재생성용). */
export async function profileMaterialFor(ctx: AppContext, ownerId: string, repoName: string) {
  const src = listEnabledSources(ctx, { ownerId, kind: "github" }).find((s) => s.targets.some((t) => t === repoName || t === repoName.split("/")[0]));
  const { gh, publicOnly } = await githubAccess(ctx, ownerId, src?.options?.installationId ? Number(src.options.installationId) : undefined);
  const repo = await gh.get<GhRepo>(`/repos/${repoName}`);
  if (!repo || (publicOnly && repo.private !== false)) throw new NotFoundError("repository");
  const [readmeRaw, releases] = await Promise.all([gh.get<{ content: string }>(`/repos/${repoName}/readme`), gh.get<GhRelease[]>(`/repos/${repoName}/releases?per_page=3`)]);
  const readme = readmeRaw ? Buffer.from(readmeRaw.content, "base64").toString("utf8") : "";
  return { repo: repoName, description: repo.description ?? undefined, readme, recentReleaseNotes: (releases ?? []).map((r) => r.body ?? "").filter(Boolean), language: repo.language ?? undefined, license: repo.license?.spdx_id, homepage: repo.homepage || undefined, stars: repo.stargazers_count };
}

export async function collectGithubSource(ctx: AppContext, sourceId: number): Promise<Record<string, number>> {
  const source = listEnabledSources(ctx).find((s) => s.id === sourceId);
  if (!source) return {};
  const ownerId = source.ownerId;
  const since = Date.now() - 14 * DAY;
  const summary: Record<string, number> = {};
  const local = getSettings(ctx, ownerId).llm.provider === "local-agent";
  let profileBudget = local ? PROFILE_BUDGET_LOCAL : PROFILE_BUDGET;
  try {
    // App 설치에서 온 소스는 설치 토큰으로, 아니면 서버 토큰으로 읽는다.
    const { gh, publicOnly } = await githubAccess(ctx, ownerId, source.options?.installationId ? Number(source.options.installationId) : undefined);
    for (const repo of await expandTargets(gh, source.targets, publicOnly)) {
      const name = repo.full_name;
      try {
      const [readmeRaw, releases, prs, traffic, referrers, pkgRaw] = await Promise.all([
        gh.get<{ content: string }>(`/repos/${name}/readme`),
        gh.get<GhRelease[]>(`/repos/${name}/releases?per_page=100`),
        gh.get<GhPull[]>(`/repos/${name}/pulls?state=closed&sort=updated&direction=desc&per_page=30`),
        gh.get<{ uniques: number }>(`/repos/${name}/traffic/views`),
        gh.get<{ referrer: string; uniques: number }[]>(`/repos/${name}/traffic/referrers`),
        gh.get<{ content: string }>(`/repos/${name}/contents/package.json`),
      ]);
      const readme = readmeRaw ? Buffer.from(readmeRaw.content, "base64").toString("utf8") : "";
      // 게시되지 않은 초안 릴리스는 published_at이 null이라 날짜 계산을 깨뜨린다.
      const allReleases = (releases ?? []).filter((r) => r.published_at && !Number.isNaN(Date.parse(r.published_at)));
      const prev = latestForRepo(ctx, ownerId, name);
      const last = lastSnapshot(ctx, ownerId, name);
      const signals: IncomingSignal[] = [];

      for (const r of allReleases) {
        const at = Date.parse(r.published_at);
        if (at >= since) signals.push({ kind: "release", repo: name, ref: `gh:release:${name}@${r.tag_name}`, title: `${name} ${r.tag_name}`, payload: { tag: r.tag_name, name: r.name, body: r.body?.slice(0, 4000), url: r.html_url }, occurredAt: at });
      }
      for (const p of prs ?? []) {
        if (!p.merged_at) continue;
        const at = Date.parse(p.merged_at);
        if (at >= since) signals.push({ kind: "pr_merged", repo: name, ref: `gh:pr:${name}#${p.number}`, title: p.title, payload: { number: p.number, url: p.html_url }, occurredAt: at });
      }
      const createdAt = Date.parse(repo.created_at);
      if (createdAt >= since) signals.push({ kind: "repo_created", repo: name, ref: `gh:repo:${name}`, title: `새 저장소 ${name}`, payload: { description: repo.description }, occurredAt: createdAt });
      const starT = crossedThreshold(prev.lastStarThreshold ?? last?.stars, repo.stargazers_count, STAR_THRESHOLDS);
      if (starT) signals.push({ kind: "star_milestone", repo: name, ref: `gh:stars:${name}#${starT}`, title: `${name} ${starT} stars`, payload: { threshold: starT, stars: repo.stargazers_count }, occurredAt: Date.now() });

      let npmPackage: string | undefined, npmMonthlyDownloads: number | undefined;
      if (pkgRaw) {
        try {
          const pkg = JSON.parse(Buffer.from(pkgRaw.content, "base64").toString("utf8")) as { name?: string; private?: boolean };
          if (pkg.name && !pkg.private) {
            const dl = await fetch(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(pkg.name)}`, { signal: AbortSignal.timeout(15_000) });
            if (dl.ok) {
              npmPackage = pkg.name;
              npmMonthlyDownloads = ((await dl.json()) as { downloads: number }).downloads;
              const dlT = crossedThreshold(prev.lastDownloadThreshold ?? last?.npmDownloadsMonth ?? undefined, npmMonthlyDownloads, DOWNLOAD_THRESHOLDS);
              if (dlT) signals.push({ kind: "download_milestone", repo: name, ref: `npm:dl:${pkg.name}#${dlT}`, title: `${pkg.name} ${dlT} downloads/month`, payload: { threshold: dlT, downloads: npmMonthlyDownloads }, occurredAt: Date.now() });
            }
          }
        } catch { /* package.json 파싱 실패는 무시 */ }
      }

      const latest = allReleases[0];
      // 커밋 창: 이 저장소를 마지막으로 다이제스트한 시각부터. 없으면 마지막 릴리스나 14일.
      const digestedAt = lastDigestAt(ctx, ownerId, name);
      const sinceIso = new Date(digestedAt ?? (latest ? Math.min(Date.parse(latest.published_at), since) : since)).toISOString();
      const commits = await gh.get<{ commit: { message: string } }[]>(`/repos/${name}/commits?since=${encodeURIComponent(sinceIso)}&per_page=100`);
      const commitSubjects = (commits ?? []).map((c) => c.commit.message.split("\n")[0].trim()).filter((m) => m && !/^(merge|chore\(deps|bump|release v?\d)/i.test(m)).slice(0, 80);

      const evidence: Evidence = {
        repo: name, repoUrl: repo.html_url, description: repo.description ?? undefined,
        version: latest?.tag_name, releaseNotes: latest?.body?.slice(0, 3000) ?? undefined,
        stars: repo.stargazers_count, forks: repo.forks_count, commitCount: await gh.commitCount(name), releaseCount: allReleases.length,
        firstReleaseAt: allReleases.at(-1)?.published_at?.slice(0, 10), language: repo.language ?? undefined, license: repo.license?.spdx_id, homepage: repo.homepage || undefined,
        npmPackage, npmMonthlyDownloads, demoAsset: firstDemoAsset(readme), limitations: limitationsFrom(readme), limitationsSource: "readme" as const,
        readmeExcerpt: readme.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 1500), commitSubjects,
      };

      snapshotMetrics(ctx, ownerId, { repo: name, stars: repo.stargazers_count, forks: repo.forks_count, viewsUniques14d: traffic?.uniques, referrers: referrers?.slice(0, 10), npmDownloadsMonth: npmMonthlyDownloads });
      // 프로필: 없거나 README가 바뀐 저장소만, 수집 한 번에 최대 PROFILE_BUDGET개. 나머지는 다음 수집에.
      // local-agent는 사용자의 워커가 하나씩 처리하므로 이번에 새 활동이 있는 저장소만, 더 적게 넣는다(초안 작업이 밀리지 않게).
      if (profileBudget > 0 && (!local || signals.length > 0)) {
        try {
          const r = await ensureProfile(ctx, ownerId, { repo: name, description: repo.description ?? undefined, readme, recentReleaseNotes: allReleases.slice(0, 3).map((x) => x.body ?? "").filter(Boolean), language: repo.language ?? undefined, license: repo.license?.spdx_id, homepage: repo.homepage || undefined, stars: repo.stargazers_count });
          if (r !== "kept") { profileBudget--; ctx.log.info({ repo: name, r }, "repo profile"); }
        } catch (e) { ctx.log.warn({ repo: name, err: (e as Error).message }, "profile failed"); }
      }
      refreshEvidence(ctx, ownerId, name, evidence);
      if (signals.length) {
        const r = ingestSignals(ctx, ownerId, sourceId, signals, { latestReleaseAt: prev.latestReleaseAt ?? (latest ? Date.parse(latest.published_at) : undefined), repoCreatedAt: createdAt, recentPrCount: prev.recentPrCount + signals.filter((s) => s.kind === "pr_merged").length }, evidence);
        summary[name] = r.inserted;
      }
      } catch (e) {
        // 레이트 리밋이면 멈춘다. 계속 요청하면 남은 저장소도 전부 실패하고 GitHub의 제한만 길어진다.
        if (e instanceof GitHubRateLimitError) throw e;
        // 저장소 하나의 실패가 조직 전체 수집을 막지 않는다.
        ctx.log.warn({ repo: name, err: (e as Error).message }, "repo collect failed");
        summary[name] = -1;
      }
    }
    markPolled(ctx, sourceId);
  } catch (e) {
    markPolled(ctx, sourceId, (e as Error).message);
    throw e;
  }
  void processNewCandidates(ctx, ownerId);
  return summary;
}

/** 소유자별 진행 중인 수집. "지금 확인"을 연달아 눌러도, 크론·웹훅과 겹쳐도 소유자마다 한 번만 돈다. */
const inFlight = new WeakMap<AppContext["db"], Map<string, Promise<CollectResult>>>();
type CollectResult = Record<number, Record<string, number> | { error: string }>;

/** 소유자를 주면 그 소유자만, 없으면 모든 소유자를 차례로. 어느 쪽이든 같은 소유자별 잠금을 쓴다. */
export async function collectAll(ctx: AppContext, ownerId?: string): Promise<CollectResult> {
  if (ownerId !== undefined) return collectOwner(ctx, ownerId);
  const owners = [...new Set(listEnabledSources(ctx).map((s) => s.ownerId))];
  const out: CollectResult = {};
  for (const owner of owners) Object.assign(out, await collectOwner(ctx, owner));
  return out;
}

function collectOwner(ctx: AppContext, ownerId: string): Promise<CollectResult> {
  const running = inFlight.get(ctx.db) ?? new Map<string, Promise<CollectResult>>();
  inFlight.set(ctx.db, running);
  const existing = running.get(ownerId);
  if (existing) return existing;
  const p = collectAllOnce(ctx, ownerId).finally(() => running.delete(ownerId));
  running.set(ownerId, p);
  return p;
}

async function collectAllOnce(ctx: AppContext, ownerId: string): Promise<CollectResult> {
  const out: Record<number, Record<string, number> | { error: string }> = {};
  for (const s of listEnabledSources(ctx, { ownerId })) {
    if (s.kind !== "github" && s.kind !== "blog") continue;
    try {
      out[s.id] = s.kind === "blog" ? await collectBlogSource(ctx, s.id) : await collectGithubSource(ctx, s.id);
    } catch (e) {
      ctx.log.error({ sourceId: s.id, err: (e as Error).message }, "collect failed");
      out[s.id] = { error: (e as Error).message };
    }
  }
  return out;
}
