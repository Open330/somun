import { and, eq } from "drizzle-orm";
import { SharedQuotaError, sharedUsage, usesSharedModel } from "./shared-quota.js";
import { normalizeGithubTarget } from "../core/source-target.js";
import { schema } from "../infra/db/index.js";
import { crossedThreshold, DOWNLOAD_THRESHOLDS, STAR_THRESHOLDS } from "../core/cluster.js";
import { installationToken } from "../infra/github/app.js";
import { GitHubClient, GitHubRateLimitError, type GhPull, type GhRelease, type GhRepo } from "../infra/github/client.js";
import { githubAppConfig, ownerOfInstallation } from "./connectors.js";
import type { Evidence } from "../shared/types.js";
import { getCandidateRow, refreshEvidence } from "./candidates.js";
import { backfillStarPoints, hasPrePostTrend } from "../core/metrics.js";
import { ensureProfile } from "./profiles.js";
import { getSettings } from "./settings.js";
import { localeOf, say } from "./i18n.js";
import { lastDigestAt } from "./ledger.js";
import { collectBlogSource } from "./collect-blog.js";
import { emit, isTrusted, NotFoundError, type AppContext } from "./context.js";
import { processNewCandidates } from "./pipeline.js";
import { lastSnapshot, snapshotMetrics } from "./publications.js";
import { ingestSignals, latestForRepo, type IncomingSignal } from "./signals.js";
import { representative } from "../core/releases.js";
import { listEnabledSources, markPolled } from "./sources.js";

const DAY = 24 * 3600 * 1000;

/**
 * GitHub·npm 수집기. 크론과 "지금 확인"이 같은 함수를 부른다.
 * 저장소별로: 릴리스·머지 PR·새 레포·스타/다운로드 임계 신호, 근거 갱신, 지표 스냅샷, 릴리스 후보 병합.
 */

/**
 * 수집할 저장소.
 * - 조직·사용자 단위로 넓힌 목록은 fork·보관·60일 넘게 push가 없는 저장소를 거른다.
 * - 사용자가 직접 지정한 저장소는 거르지 않는다. 다만 보관됐거나 60일 넘게 push가 없으면 quiet로 표시해, 수집이
 *   스타·fork 스냅샷과 스타 마일스톤만 처리하게 한다(세부 조회·프로필 생성 없이). GitHub App으로 저장소 200개를 고르면
 *   수집마다 수천 번 호출하고, 활동 없는 저장소의 프로필 생성으로 공유 모델 쿼터를 다 썼다.
 * - 공개 저장소만 읽을 수 있는데 비공개면 skipped로 알린다.
 */
export async function expandTargets(gh: GitHubClient, targets: string[], publicOnly = false, installation = false): Promise<{ repos: GhRepo[]; quiet: Set<string>; skipped: string[] }> {
  const explicit: GhRepo[] = [], expanded: GhRepo[] = [], skipped: string[] = [];
  const quiet = new Set<string>();
  // GitHub App 설치로 저장소를 여럿 고른 소스는 설치 저장소 목록을 한 번(100개씩) 받아 쓴다. 저장소마다 GET /repos를 부르면
  // 200개를 고른 계정은 수집마다 200번 호출한다. 목록에 없는 저장소만 따로 조회한다.
  const listed = installation && targets.filter((t) => t.includes("/")).length > 10 ? await installationRepos(gh) : new Map<string, GhRepo>();
  for (const raw of targets) {
    const t = normalizeGithubTarget(raw);
    if (!t) throw new Error("Invalid GitHub target");
    if (t.includes("/")) {
      const r = listed.get(t.toLowerCase()) ?? (await gh.get<GhRepo>(`/repos/${t}`));
      if (!r) throw new Error(`GitHub repository unavailable: ${t}`);
      if (publicOnly && r.private !== false) skipped.push(r.full_name);
      else {
        explicit.push(r);
        if (r.archived || !recentlyPushed(r)) quiet.add(r.full_name);
      }
      continue;
    }
    for (let page = 1; page <= 5; page++) {
      const list = (await gh.get<GhRepo[]>(`/orgs/${t}/repos?per_page=100&page=${page}&sort=pushed`)) ?? (await gh.get<GhRepo[]>(`/users/${t}/repos?per_page=100&page=${page}&sort=pushed`));
      if (!list?.length) break;
      expanded.push(...list);
      if (list.length < 100) break;
    }
  }
  // 최근에 움직인 저장소부터. 프로필 생성 예산(수집당 25개)이 활발한 저장소에 먼저 쓰인다.
  const active = expanded.filter((r) => !r.fork && !r.archived && !(publicOnly && r.private !== false) && recentlyPushed(r));
  const seen = new Set<string>();
  const repos = [...explicit, ...active].filter((r) => !seen.has(r.full_name) && seen.add(r.full_name)).sort((a, b) => (Date.parse(b.pushed_at ?? "") || 0) - (Date.parse(a.pushed_at ?? "") || 0));
  return { repos, quiet, skipped };
}

/** 이 저장소에 아직 버리거나 발행하지 않은 글감이 있는가. */
function hasOpenCandidate(ctx: AppContext, ownerId: string, repo: string): boolean {
  return ctx.db.select({ status: schema.candidates.status }).from(schema.candidates).where(and(eq(schema.candidates.ownerId, ownerId), eq(schema.candidates.repo, repo))).all().some((c) => !["dropped", "published"].includes(c.status));
}

/** GitHub App 설치에 들어 있는 저장소(최대 1000개). 이름은 소문자로 찾는다. */
async function installationRepos(gh: GitHubClient): Promise<Map<string, GhRepo>> {
  const out = new Map<string, GhRepo>();
  for (let page = 1; page <= 10; page++) {
    const res = await gh.get<{ repositories: GhRepo[] }>(`/installation/repositories?per_page=100&page=${page}`);
    const list = res?.repositories ?? [];
    for (const r of list) out.set(r.full_name.toLowerCase(), r);
    if (list.length < 100) break;
  }
  return out;
}

/** 최근 60일 안에 push가 있었는가. push 기록이 없는 새 저장소는 활동 중으로 본다. */
const recentlyPushed = (r: GhRepo) => { const at = Date.parse(r.pushed_at ?? ""); return !Number.isFinite(at) || Date.now() - at < 60 * DAY; };

/** 글감 판단에 필요한데 권한 없음으로 읽지 못한 것. 트래픽은 관리 권한이 있어야 해서 늘 빠질 수 있으므로 세지 않는다. */
export function missingReads(denied: Iterable<string>, repo: string): string[] {
  const kinds: [RegExp, string][] = [[/\/pulls\b/, "pull requests"], [/\/releases\b/, "releases"], [/\/(?:readme|contents)\b/, "contents"], [/\/commits\b/, "commits"]];
  const prefix = `/repos/${repo}/`;
  // 저장소 이름에 commits·pulls 같은 낱말이 있어도 오인하지 않게 저장소 뒤 경로만 본다.
  const paths = [...denied].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length - 1));
  return kinds.filter(([re]) => paths.some((p) => re.test(p))).map(([, label]) => label);
}

/** README의 첫 데모 자산. gif/mp4/webm 우선, 없으면 로고가 아닌 이미지. */
/**
 * 100개씩 끝까지(최대 maxPages쪽) 읽는다. 릴리스가 100개를 넘는 저장소에서 개수와 첫 릴리스 날짜가 틀리지 않게.
 * 첫 쪽이 null(없음·권한 없음)이면 null을 그대로 돌려준다.
 */
export async function pagedList<T>(gh: GitHubClient, path: string, maxPages = 10): Promise<T[] | null> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const list = await gh.get<T[]>(`${path}?per_page=100&page=${page}`);
    if (!list) return page === 1 ? null : out;
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}

/**
 * 수집 창 안에 갱신된 닫힌 PR을 끝까지 읽는다(최근 갱신순, 최대 maxPages쪽). 예전에는 30개만 읽어,
 * 봇 PR이나 머지하지 않고 닫은 PR이 많은 저장소에서 실제로 머지된 PR이 빠졌다. 봇이 연 PR은 글감이 아니므로 뺀다.
 */
export async function closedPullsSince(gh: GitHubClient, repo: string, since: number, maxPages = 5): Promise<GhPull[] | null> {
  const out: GhPull[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const list = await gh.get<GhPull[]>(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`);
    if (!list) return page === 1 ? null : out;
    out.push(...list.filter((p) => p.user?.type !== "Bot" && !p.user?.login?.endsWith("[bot]")));
    const oldest = list.at(-1)?.updated_at;
    if (list.length < 100 || (oldest && Date.parse(oldest) < since)) break;
  }
  return out;
}

/**
 * 근거에 적을 "최신판". 글감 제목과 같은 규칙(core/releases)으로, 같은 범위에서 고른다:
 * 수집 창 안에 릴리스가 있으면 그중에서(제목도 창 안 릴리스 신호로 정해진다), 없으면 전체에서.
 * 게시일만 보면 옛 줄기의 백포트(vite v6.4.4)가 최신판이 된다.
 */
export function latestRelease(releases: GhRelease[], since = -Infinity): GhRelease | undefined {
  const inWindow = releases.filter((r) => Date.parse(r.published_at) >= since);
  return representative(inWindow.length ? inWindow : releases, (r) => r.tag_name, (r) => Date.parse(r.published_at));
}

/** 진행 중 글감이 되는 최소 커밋 수. 오타·설정 몇 개로 글감이 생기지 않게 한다. */
export const COMMIT_BATCH_MIN = 5;
/** 독자에게 보이지 않는 커밋. Conventional Commits의 문서·테스트·CI·잡일과 병합·의존성 갱신·릴리스 커밋. */
const INVISIBLE_COMMIT = /^(?:merge\b|bump\b|release v?\d|auto-?update\b|(?:chore|ci|docs?|test|tests|style|build|refactor|deploy)(?:\([^)]*\))?!?:)/i;

/** 같은 틀로 찍어 내는 자동 커밋("🔮 horoscope 2026-10-01")을 한 종류로 보기 위한 틀. 숫자·날짜·기호를 지운다. */
const commitTemplate = (subject: string) => subject.toLowerCase().replace(/[\d\p{Extended_Pictographic}]+/gu, "").replace(/[^\p{L}]+/gu, " ").trim();

/**
 * 수집 창 안의 의미 있는 커밋 묶음. 모자라면 null. head는 가장 최근 커밋이라 새 커밋이 생길 때만 새 신호가 된다.
 * 봇 커밋, 배포·잡일 커밋은 세지 않고, 같은 틀의 반복 커밋은 한 번으로 센다(매일 도는 자동 커밋이 글감이 되지 않게).
 */
export function commitBatch(commits: { sha: string; author?: { login?: string; type?: string } | null; commit: { message: string; committer?: { date?: string } | null } }[], since: number): { head: string; at: number; subjects: string[] } | null {
  const visible = commits
    .filter((c) => c.author?.type !== "Bot" && !c.author?.login?.endsWith("[bot]"))
    .map((c) => ({ sha: c.sha, at: Date.parse(c.commit.committer?.date ?? ""), subject: c.commit.message.split("\n")[0].trim() }))
    // 스쿼시 머지 커밋("feat: x (#12)")은 PR 신호가 나르는 변경이다.
    .filter((c) => c.subject && Number.isFinite(c.at) && c.at >= since && !INVISIBLE_COMMIT.test(c.subject) && !/\(#\d+\)$/.test(c.subject))
    .sort((a, b) => b.at - a.at);
  if (new Set(visible.map((c) => commitTemplate(c.subject))).size < COMMIT_BATCH_MIN) return null;
  return { head: visible[0].sha, at: visible[0].at, subjects: visible.map((c) => c.subject) };
}

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

/** README가 실험·로컬 전용으로 표시한 절 제목. 운영에서 꺼 둔 기능을 초안이 지금 쓸 수 있는 것처럼 알리지 않게 한다. */
export function experimentalFrom(readme: string): string[] {
  // 명시적인 표지만 본다. "Local development", "Preview"(스크린샷) 같은 평범한 절은 실험 기능이 아니다.
  const MARK = /\b(experimental|alpha|wip|local[- ]only)\b|실험|로컬 전용/i;
  return [...readme.matchAll(/^#{1,4}\s+(.+?)\s*#*\s*$/gm)].map((m) => m[1].replace(/[`*_]/g, "").trim()).filter((h) => MARK.test(h)).slice(0, 5);
}

/** 수집 한 번에 만드는 프로필 수 상한. 분석 모델 호출 1회/저장소. */
export const PROFILE_BUDGET = 25;
/** 공유 모델 하루 한도 중 사용자가 직접 요청할 작업을 위해 프로필 생성이 남겨 두는 횟수. */
export const PROFILE_RESERVE = 20;
/** 최신 릴리스 노트를 근거에 담는 길이. 3000자에서 잘리면 긴 노트(barshelf v0.6.0, 6159자)의 뒤쪽 변경이 빠졌다. */
export const RELEASE_NOTES_MAX = 6000;
/** local-agent 모드의 상한. 워커가 CLI를 하나씩 돌리므로 작게 둔다. */
export const PROFILE_BUDGET_LOCAL = 5;

/**
 * 소유자가 GitHub를 읽을 토큰. 설치 토큰은 그 설치를 연결한 소유자만 쓴다.
 * 서버 토큰은 운영자(trustedOwners)만 비공개 저장소까지 읽고, 나머지는 공개 저장소만(publicOnly).
 */
export async function githubAccess(ctx: AppContext, ownerId: string, installationId?: number): Promise<{ gh: GitHubClient; publicOnly: boolean }> {
  if (installationId) {
    if (ownerOfInstallation(ctx, installationId) !== ownerId) throw new Error(say(localeOf(ctx, ownerId), "이 계정에 연결된 GitHub 설치가 아닙니다.", "This GitHub installation is not linked to this account."));
    const cfg = githubAppConfig(ctx);
    if (!cfg) throw new Error(say(localeOf(ctx, ownerId), "GitHub App이 설정되지 않았습니다.", "The GitHub App is not configured."));
    return { gh: new GitHubClient(await installationToken(cfg, installationId)), publicOnly: false };
  }
  if (!ctx.env.githubToken) throw new Error(say(localeOf(ctx, ownerId), "GitHub 토큰이 없습니다. GitHub App을 설치하거나 GITHUB_TOKEN을 설정하세요.", "No GitHub token. Install the GitHub App or set GITHUB_TOKEN."));
  return { gh: new GitHubClient(ctx.env.githubToken), publicOnly: !isTrusted(ctx, ownerId) };
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

/**
 * 발행 전 추세의 기준점(발행 2~11일 전 스냅샷)이 없으면 GitHub 스타 시각으로 되짚어 채운다.
 * 연결 직후 올린 첫 소개 글은 소문이 찍은 스냅샷이 없어 "추세 대비 증가"를 낼 수 없었다. 최근 스타 500개까지만 읽는다.
 */
export async function backfillStarTrend(ctx: AppContext, ownerId: string, publicationId: number): Promise<number> {
  const pub = ctx.db.select().from(schema.publications).where(and(eq(schema.publications.id, publicationId), eq(schema.publications.ownerId, ownerId))).get();
  if (!pub) return 0;
  const name = getCandidateRow(ctx, ownerId, pub.candidateId).repo;
  // 같은 저장소에 글을 연달아 등록해도 한 번만 읽고 한 번만 넣는다.
  const lock = `${ownerId}|${name}`;
  if (backfilling.has(lock)) return 0;
  backfilling.add(lock);
  try { return await backfillRepo(ctx, ownerId, name, pub.publishedAt); } finally { backfilling.delete(lock); }
}
const backfilling = new Set<string>();

async function backfillRepo(ctx: AppContext, ownerId: string, name: string, publishedAt: number): Promise<number> {
  const snaps = ctx.db.select({ at: schema.metricSnapshots.at, forks: schema.metricSnapshots.forks }).from(schema.metricSnapshots).where(and(eq(schema.metricSnapshots.ownerId, ownerId), eq(schema.metricSnapshots.repo, name))).all();
  if (hasPrePostTrend(snaps, publishedAt)) return 0;
  const src = listEnabledSources(ctx, { ownerId, kind: "github" }).find((s) => s.targets.some((t) => t === name || t === name.split("/")[0]));
  const { gh, publicOnly } = await githubAccess(ctx, ownerId, src?.options?.installationId ? Number(src.options.installationId) : undefined);
  const repo = await gh.get<GhRepo>(`/repos/${name}`);
  if (!repo || (publicOnly && repo.private !== false)) return 0;
  const { times, complete, status } = await gh.recentStarTimes(name, repo.stargazers_count, publishedAt - 9 * DAY);
  if (!complete) {
    ctx.log.info({ repo: name, status, read: times.length }, status === 404 ? "star history unavailable: GitHub lists stargazers only for repositories this token can access" : "star history incomplete: more recent stars than the backfill reads");
    return 0;
  }
  let inserted = 0;
  for (const p of backfillStarPoints(repo.stargazers_count, times, publishedAt)) {
    if (snaps.some((s) => Math.abs(s.at - p.at) < 12 * 3600e3)) continue;
    // 과거 fork 수는 알 수 없다. 가장 가까운 실제 스냅샷의 값을 쓰고, 없을 때만 지금 값을 쓴다.
    const nearest = [...snaps].sort((a, b) => Math.abs(a.at - p.at) - Math.abs(b.at - p.at))[0];
    ctx.db.insert(schema.metricSnapshots).values({ ownerId, repo: name, stars: p.stars, forks: nearest?.forks ?? repo.forks_count, at: p.at }).run();
    inserted++;
  }
  if (inserted) emit(ctx, ownerId, { resource: "publications" });
  return inserted;
}

export async function collectGithubSource(ctx: AppContext, sourceId: number): Promise<Record<string, number>> {
  const source = listEnabledSources(ctx).find((s) => s.id === sourceId);
  if (!source) return {};
  const ownerId = source.ownerId;
  const since = Date.now() - 14 * DAY;
  const summary: Record<string, number> = {};
  const local = getSettings(ctx, ownerId).llm.provider === "local-agent";
  let profileBudget = local ? PROFILE_BUDGET_LOCAL : PROFILE_BUDGET;
  // 공유 모델을 쓰는 계정은 프로필(뒤에서 도는 작업)이 하루 한도의 마지막 PROFILE_RESERVE회를 쓰지 않는다.
  // 사용자가 직접 요청한 분석·초안이 한도에 막히지 않게 남겨 둔다.
  if (usesSharedModel(ctx, ownerId)) {
    const usage = sharedUsage(ctx, ownerId);
    profileBudget = Math.min(profileBudget, Math.max(0, usage.limit - PROFILE_RESERVE - usage.used));
  }
  try {
    // App 설치에서 온 소스는 설치 토큰으로, 아니면 서버 토큰으로 읽는다.
    const { gh, publicOnly } = await githubAccess(ctx, ownerId, source.options?.installationId ? Number(source.options.installationId) : undefined);
    const { repos, quiet, skipped } = await expandTargets(gh, source.targets, publicOnly, Boolean(source.options?.installationId));
    const missing: string[] = [];
    for (const repo of repos) {
      const name = repo.full_name;
      try {
      if (quiet.has(name)) {
        // 활동 없는 저장소: 이미 받은 저장소 정보로 스냅샷(발행 성과 추적)과 스타 마일스톤만. 세부 조회·프로필 생성은 하지 않는다.
        const prevQuiet = latestForRepo(ctx, ownerId, name);
        const starT = crossedThreshold(prevQuiet.lastStarThreshold ?? lastSnapshot(ctx, ownerId, name)?.stars, repo.stargazers_count, STAR_THRESHOLDS);
        snapshotMetrics(ctx, ownerId, { repo: name, stars: repo.stargazers_count, forks: repo.forks_count });
        if (starT) {
          const milestone: IncomingSignal = { kind: "star_milestone", repo: name, ref: `gh:stars:${name}#${starT}`, title: `${name} ${starT} stars`, payload: { threshold: starT, stars: repo.stargazers_count }, occurredAt: Date.now() };
          summary[name] = ingestSignals(ctx, ownerId, sourceId, [milestone], {}, { repo: name, repoUrl: repo.html_url, description: repo.description ?? undefined, stars: repo.stargazers_count, forks: repo.forks_count }).inserted;
        }
        continue;
      }
      const [readmeRaw, releases, prs, traffic, referrers, pkgRaw] = await Promise.all([
        gh.get<{ content: string }>(`/repos/${name}/readme`),
        pagedList<GhRelease>(gh, `/repos/${name}/releases`),
        closedPullsSince(gh, name, since),
        gh.get<{ uniques: number }>(`/repos/${name}/traffic/views`),
        gh.get<{ referrer: string; uniques: number }[]>(`/repos/${name}/traffic/referrers`),
        gh.get<{ content: string }>(`/repos/${name}/contents/package.json`),
      ]);
      const readme = readmeRaw ? Buffer.from(readmeRaw.content, "base64").toString("utf8") : "";
      // 게시되지 않은 초안 릴리스는 published_at이 null이라 날짜 계산을 깨뜨린다.
      // GitHub 목록 순서는 게시일 순이 아니다(오래된 릴리스가 맨 앞에 올 수 있다). 최신 판·첫 릴리스 계산을 위해 게시일 내림차순으로 맞춘다.
      const allReleases = (releases ?? []).filter((r) => r.published_at && !Number.isNaN(Date.parse(r.published_at)))
        .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
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
      if (createdAt >= since) signals.push({ kind: "repo_created", repo: name, ref: `gh:repo:${name}`, title: name, payload: { description: repo.description }, occurredAt: createdAt });
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

      const latest = latestRelease(allReleases, since);
      // 커밋 창: 이 저장소를 마지막으로 다이제스트한 시각부터. 없으면 마지막 릴리스나 14일.
      const digestedAt = lastDigestAt(ctx, ownerId, name);
      const sinceIso = new Date(digestedAt ?? (latest ? Math.min(Date.parse(latest.published_at), since) : since)).toISOString();
      const commits = await gh.get<{ sha: string; author?: { login?: string; type?: string } | null; commit: { message: string; committer?: { date?: string } | null } }[]>(`/repos/${name}/commits?since=${encodeURIComponent(sinceIso)}&per_page=100`);
      const commitSubjects = (commits ?? []).map((c) => c.commit.message.split("\n")[0].trim()).filter((m) => m && !/^(merge|chore\(deps|bump|release v?\d)/i.test(m)).slice(0, 80);
      // PR 없이 main에 바로 올리는 저장소는 릴리스·PR 신호가 없다. 수집 창 안의 의미 있는 커밋이 쌓이면 진행 중 글감으로 본다.
      // PR로 일하는 저장소는 PR 신호가 이미 같은 변경을 나른다. 커밋 묶음은 이 창에 머지된 PR이 없을 때만 만든다.
      const mergedInWindow = (prs ?? []).some((p) => p.merged_at && Date.parse(p.merged_at) >= since);
      const batch = mergedInWindow ? null : commitBatch(commits ?? [], since);
      if (batch && !signals.some((s) => s.kind === "release")) signals.push({ kind: "commit_batch", repo: name, ref: `gh:commits:${name}@${batch.head}`, title: `${name}: ${batch.subjects.length} commits`, payload: { count: batch.subjects.length, head: batch.head, subjects: batch.subjects.slice(0, 20) }, occurredAt: batch.at });

      const plainReadme = readme.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      const evidence: Evidence = {
        repo: name, repoUrl: repo.html_url, description: repo.description ?? undefined,
        version: latest?.tag_name, releaseNotes: latest?.body?.slice(0, RELEASE_NOTES_MAX) ?? undefined,
        stars: repo.stargazers_count, forks: repo.forks_count, commitCount: await gh.commitCount(name), releaseCount: allReleases.length,
        firstReleaseAt: allReleases.at(-1)?.published_at?.slice(0, 10), language: repo.language ?? undefined, license: repo.license?.spdx_id, homepage: repo.homepage || undefined,
        npmPackage, npmMonthlyDownloads, demoAsset: firstDemoAsset(readme), limitations: limitationsFrom(readme), limitationsSource: "readme" as const, experimental: experimentalFrom(readme),
        readmeExcerpt: plainReadme.slice(0, 1500), readmeForChecks: plainReadme.slice(0, 8000), commitSubjects,
      };

      snapshotMetrics(ctx, ownerId, { repo: name, stars: repo.stargazers_count, forks: repo.forks_count, viewsUniques14d: traffic?.uniques, referrers: referrers?.slice(0, 10), npmDownloadsMonth: npmMonthlyDownloads });
      refreshEvidence(ctx, ownerId, name, evidence);
      if (signals.length) {
        // 같은 PR이 저장된 것과 이번 응답에 함께 있으므로 ref로 중복을 뺀다. 릴리스 시각은 저장된 것과 방금 받은 것 중 늦은 쪽.
        const latestReleaseAt = Math.max(prev.latestReleaseAt ?? -Infinity, latest ? Date.parse(latest.published_at) : -Infinity);
        // 진행 중 글감의 기준은 "최근 릴리스 뒤에 쌓인 PR"이다. 릴리스에 이미 들어간 PR은 세지 않는다.
        const recent = [...prev.recentPrs, ...signals.filter((s) => s.kind === "pr_merged" && Date.now() - s.occurredAt < 7 * DAY).map((s) => ({ ref: s.ref, at: s.occurredAt }))];
        const recentPrCount = new Set(recent.filter((p) => !(p.at <= latestReleaseAt)).map((p) => p.ref)).size;
        const r = ingestSignals(ctx, ownerId, sourceId, signals, { latestReleaseAt: Number.isFinite(latestReleaseAt) ? latestReleaseAt : undefined, repoCreatedAt: createdAt, recentPrCount }, evidence);
        summary[name] = r.inserted;
      }
      // 프로필: 이번 수집에서 새 신호가 저장됐거나 열린 글감이 있는 저장소만(초안의 근거가 되는 곳). ensureProfile은 없거나 README가
      // 바뀐 경우에만 모델을 부른다. 활동 없는 저장소까지 만들면 webhook마다 공유 모델 쿼터를 프로필에 다 쓴다. 수집 한 번에 최대 PROFILE_BUDGET개.
      if (profileBudget > 0 && ((summary[name] ?? 0) > 0 || hasOpenCandidate(ctx, ownerId, name))) {
        try {
          const r = await ensureProfile(ctx, ownerId, { repo: name, description: repo.description ?? undefined, readme, recentReleaseNotes: allReleases.slice(0, 3).map((x) => x.body ?? "").filter(Boolean), language: repo.language ?? undefined, license: repo.license?.spdx_id, homepage: repo.homepage || undefined, stars: repo.stargazers_count });
          if (r !== "kept") { profileBudget--; ctx.log.info({ repo: name, r }, "repo profile"); }
        } catch (e) {
          // 한도에 닿으면 이번 수집의 나머지 프로필은 시도하지 않는다(저장소마다 같은 실패 로그가 쌓이지 않게).
          if (e instanceof SharedQuotaError) { profileBudget = 0; ctx.log.info({ repo: name }, "profile skipped: shared model limit reached"); }
          else ctx.log.warn({ repo: name, err: (e as Error).message }, "profile failed");
        }
      }
      } catch (e) {
        // 레이트 리밋이면 멈춘다. 계속 요청하면 남은 저장소도 전부 실패하고 GitHub의 제한만 길어진다.
        if (e instanceof GitHubRateLimitError) throw e;
        // 저장소 하나의 실패가 조직 전체 수집을 막지 않는다.
        ctx.log.warn({ repo: name, err: (e as Error).message }, "repo collect failed");
        summary[name] = -1;
      }
    }
    for (const repo of repos) {
      const lacks = missingReads(gh.denied, repo.full_name);
      if (lacks.length) missing.push(`${repo.full_name} (${lacks.join(", ")})`);
    }
    if (missing.length) ctx.log.warn({ sourceId, missing }, "GitHub permission missing");
    markPolled(ctx, sourceId, Object.values(summary).some((n) => n < 0) ? "GitHub partial collection failure"
      : missing.length ? `GitHub permission missing: ${missing.join("; ")}`
        : skipped.length ? `GitHub repositories skipped (private): ${skipped.join(", ")}` : undefined);
  } catch (e) {
    markPolled(ctx, sourceId, (e as Error).message);
    throw e;
  }
  void processNewCandidates(ctx, ownerId).catch((err: Error) => ctx.log.error({ ownerId, err: err.message }, "processing new candidates after collect failed"));
  return summary;
}

/** 소유자별 진행 중인 수집. "지금 확인"을 연달아 눌러도, 크론·웹훅과 겹쳐도 소유자마다 한 번만 돈다. */
const inFlight = new WeakMap<AppContext["db"], Map<string, Promise<CollectResult>>>();
type CollectResult = Record<number, Record<string, number> | { error: string }>;
/** 진행 중인 수집 뒤에 예약한 "다시 돌기". 수집 하나당 하나. */
const reruns = new WeakMap<Promise<CollectResult>, Promise<CollectResult>>();

/**
 * 소유자를 주면 그 소유자만, 없으면 모든 소유자를 차례로. 어느 쪽이든 같은 소유자별 잠금을 쓴다.
 * fresh: 사용자가 누른 "지금 확인". 이미 도는 수집은 시작할 때의 소스 목록을 쓰므로, 방금 연결한 소스가 빠지지 않게
 * 그 수집이 끝난 뒤 한 번 더 돈다(크론·웹훅은 합류만 한다).
 */
export async function collectAll(ctx: AppContext, ownerId?: string, opts: { fresh?: boolean } = {}): Promise<CollectResult> {
  if (ownerId !== undefined) {
    const existing = inFlight.get(ctx.db)?.get(ownerId);
    if (!existing || !opts.fresh) return collectOwner(ctx, ownerId);
    // 다시 돌기는 진행 중인 수집마다 한 번만 예약한다(연달아 눌러도 전체 수집이 줄줄이 이어지지 않게).
    const queued = reruns.get(existing);
    if (queued) return queued;
    const again = existing.then(() => collectOwner(ctx, ownerId), () => collectOwner(ctx, ownerId));
    reruns.set(existing, again);
    return again;
  }
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
