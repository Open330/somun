import { crossedThreshold, DOWNLOAD_THRESHOLDS, STAR_THRESHOLDS } from "../core/cluster.js";
import { installationToken } from "../infra/github/app.js";
import { GitHubClient, type GhPull, type GhRelease, type GhRepo } from "../infra/github/client.js";
import { githubAppConfig } from "./connectors.js";
import type { Evidence } from "../shared/types.js";
import { mergeOpenReleases, refreshEvidence } from "./candidates.js";
import type { AppContext } from "./context.js";
import { processNewCandidates } from "./pipeline.js";
import { lastSnapshot, snapshotMetrics } from "./publications.js";
import { ingestSignals, latestForRepo, type IncomingSignal } from "./signals.js";
import { listEnabledSources, markPolled } from "./sources.js";

const DAY = 24 * 3600 * 1000;

/**
 * GitHub·npm 수집기. 크론과 "지금 확인"이 같은 함수를 부른다.
 * 저장소별로: 릴리스·머지 PR·새 레포·스타/다운로드 임계 신호, 근거 갱신, 지표 스냅샷, 릴리스 후보 병합.
 */

async function expandTargets(gh: GitHubClient, targets: string[]): Promise<GhRepo[]> {
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
  return repos.filter((r) => !r.fork && !r.archived && Date.now() - Date.parse(r.pushed_at) < 60 * DAY);
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

export async function collectGithubSource(ctx: AppContext, sourceId: number): Promise<Record<string, number>> {
  const source = listEnabledSources(ctx).find((s) => s.id === sourceId);
  if (!source) return {};
  // App 설치에서 온 소스는 설치 토큰으로, 아니면 서버 토큰으로 읽는다.
  const instId = source.options?.installationId ? Number(source.options.installationId) : undefined;
  const cfg = instId ? githubAppConfig(ctx) : null;
  const token = instId && cfg ? await installationToken(cfg, instId) : ctx.env.githubToken;
  if (!token) throw new Error("GitHub 토큰이 없습니다. GitHub App을 설치하거나 GITHUB_TOKEN을 설정하세요.");
  const gh = new GitHubClient(token);
  const ownerId = source.ownerId;
  const since = Date.now() - 14 * DAY;
  const summary: Record<string, number> = {};
  try {
    for (const repo of await expandTargets(gh, source.targets)) {
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
            const dl = await fetch(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(pkg.name)}`);
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
      const sinceIso = new Date(latest ? Math.min(Date.parse(latest.published_at), since) : since).toISOString();
      const commits = await gh.get<{ commit: { message: string } }[]>(`/repos/${name}/commits?since=${encodeURIComponent(sinceIso)}&per_page=100`);
      const commitSubjects = (commits ?? []).map((c) => c.commit.message.split("\n")[0].trim()).filter((m) => m && !/^(merge|chore\(deps|bump|release v?\d)/i.test(m)).slice(0, 80);

      const evidence: Evidence = {
        repo: name, repoUrl: repo.html_url, description: repo.description ?? undefined,
        version: latest?.tag_name, releaseNotes: latest?.body?.slice(0, 3000) ?? undefined,
        stars: repo.stargazers_count, forks: repo.forks_count, commitCount: await gh.commitCount(name), releaseCount: allReleases.length,
        firstReleaseAt: allReleases.at(-1)?.published_at?.slice(0, 10), language: repo.language ?? undefined, license: repo.license?.spdx_id, homepage: repo.homepage || undefined,
        npmPackage, npmMonthlyDownloads, demoAsset: firstDemoAsset(readme), limitations: limitationsFrom(readme),
        readmeExcerpt: readme.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 1500), commitSubjects,
      };

      snapshotMetrics(ctx, ownerId, { repo: name, stars: repo.stargazers_count, forks: repo.forks_count, viewsUniques14d: traffic?.uniques, referrers: referrers?.slice(0, 10), npmDownloadsMonth: npmMonthlyDownloads });
      refreshEvidence(ctx, ownerId, name, evidence);
      mergeOpenReleases(ctx, ownerId, name);
      if (signals.length) {
        const r = ingestSignals(ctx, ownerId, sourceId, signals, { latestReleaseAt: prev.latestReleaseAt ?? (latest ? Date.parse(latest.published_at) : undefined), repoCreatedAt: createdAt, recentPrCount: prev.recentPrCount + signals.filter((s) => s.kind === "pr_merged").length }, evidence);
        summary[name] = r.inserted;
      }
      } catch (e) {
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

export async function collectAll(ctx: AppContext, ownerId?: string): Promise<Record<number, Record<string, number> | { error: string }>> {
  const out: Record<number, Record<string, number> | { error: string }> = {};
  for (const s of listEnabledSources(ctx, { ownerId, kind: "github" })) {
    try {
      out[s.id] = await collectGithubSource(ctx, s.id);
    } catch (e) {
      ctx.log.error({ sourceId: s.id, err: (e as Error).message }, "collect failed");
      out[s.id] = { error: (e as Error).message };
    }
  }
  return out;
}
