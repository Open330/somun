"use node";
import { v } from "convex/values";
import { internalAction, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { getOwnerId } from "./owner";
import { crossedThreshold, DOWNLOAD_THRESHOLDS, STAR_THRESHOLDS } from "./lib/cluster";

declare const process: { env: Record<string, string | undefined> };

/**
 * GitHub·npm 수집기. 하루 1회 크론과 "지금 확인" 버튼이 같은 액션을 부른다.
 *
 * GitHub 소스의 targets: "Owner" (조직/사용자 전체) 또는 "Owner/repo".
 * 신호: 릴리스, 머지된 PR, 새 레포, README 변경, 스타 임계, 다운로드 임계.
 * 근거(evidence)는 후보에 병합되어 초안의 사실 블록이 된다.
 */

const GH = "https://api.github.com";
const DAY = 24 * 3600 * 1000;

async function gh<T>(path: string, token: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(`${GH}${path}`, {
    ...init,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "somun", ...(init?.headers ?? {}) },
  });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`GitHub ${path} → ${res.status}`);
  return (await res.json()) as T;
}

type Repo = {
  full_name: string; description: string | null; html_url: string; homepage: string | null; stargazers_count: number; forks_count: number;
  language: string | null; license: { spdx_id: string } | null; created_at: string; pushed_at: string; fork: boolean; archived: boolean; default_branch: string;
};

async function expandTargets(targets: string[], token: string): Promise<Repo[]> {
  const repos: Repo[] = [];
  for (const t of targets) {
    if (t.includes("/")) {
      const r = await gh<Repo>(`/repos/${t}`, token);
      if (r) repos.push(r);
      continue;
    }
    for (let page = 1; page <= 5; page++) {
      const orgPage = await gh<Repo[]>(`/orgs/${t}/repos?per_page=100&page=${page}&sort=pushed`, token);
      const list = orgPage ?? (await gh<Repo[]>(`/users/${t}/repos?per_page=100&page=${page}&sort=pushed`, token));
      if (!list || list.length === 0) break;
      repos.push(...list);
      if (list.length < 100) break;
    }
  }
  // 포크·아카이브 제외. 최근 60일 push된 것만 (조용한 레포에는 신호가 없다).
  return repos.filter((r) => !r.fork && !r.archived && Date.now() - Date.parse(r.pushed_at) < 60 * DAY);
}

/** README의 첫 데모 자산. gif/mp4/webm 우선, 없으면 로고가 아닌 png/jpg. */
function firstGif(readme: string): string | undefined {
  const all = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+\.(?:gif|mp4|webm|png|jpe?g))\)/gi), ...readme.matchAll(/<(?:img|source)[^>]+src="([^"]+\.(?:gif|mp4|webm|png|jpe?g))"/gi)].map((m) => m[1]);
  const motion = all.find((u) => /\.(gif|mp4|webm)$/i.test(u));
  if (motion) return motion;
  return all.find((u) => !/logo|badge|shields\.io|icon/i.test(u));
}

function limitationsFrom(readme: string): string[] {
  const notes: string[] = [];
  const beta = /\[!(?:IMPORTANT|WARNING|CAUTION)\]\s*\n((?:>.*\n?){1,4})/i.exec(readme);
  if (beta) notes.push(beta[1].replace(/^>\s?/gm, "").replace(/\s+/g, " ").trim().slice(0, 240));
  const m = /(?:^|\n)#+\s*(?:limitations?|known issues|caveats|not (?:yet )?supported|한계|제한|아직 안 되는 것)[^\n]*\n([\s\S]{0,1200}?)(?:\n#+\s|$)/i.exec(readme);
  if (!m) return notes;
  return [...notes, ...m[1].split("\n").map((l) => l.replace(/^[-*\d.\s]+/, "").trim()).filter((l) => l.length > 8)].slice(0, 5);
}

type CollectResult = { skipped?: boolean; summary?: Record<string, number> };

export const collectGithubSource = internalAction({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, { sourceId }): Promise<CollectResult> => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN 이 Convex 환경변수에 없습니다.");
    const sources = await ctx.runQuery(internal.sources.listEnabled, {});
    const source = sources.find((s: { _id: string }) => s._id === sourceId);
    if (!source) return { skipped: true };
    const ownerId = source.ownerId;
    const since = Date.now() - 14 * DAY;
    const summary: Record<string, number> = {};
    try {
      const repos = await expandTargets(source.config.targets, token);
      for (const repo of repos) {
        const name = repo.full_name;
        const [readmeRaw, releases, prs, traffic, referrers] = await Promise.all([
          gh<{ content: string }>(`/repos/${name}/readme`, token),
          gh<{ tag_name: string; name: string; body: string; published_at: string; html_url: string }[]>(`/repos/${name}/releases?per_page=100`, token),
          gh<{ number: number; title: string; merged_at: string | null; closed_at: string; html_url: string; user: { login: string } }[]>(`/repos/${name}/pulls?state=closed&sort=updated&direction=desc&per_page=30`, token),
          gh<{ uniques: number }>(`/repos/${name}/traffic/views`, token),
          gh<{ referrer: string; uniques: number }[]>(`/repos/${name}/traffic/referrers`, token),
        ]);
        const readme = readmeRaw ? Buffer.from(readmeRaw.content, "base64").toString("utf8") : "";
        const allReleases = releases ?? [];
        const prev = await ctx.runQuery(internal.signals.latestForRepo, { ownerId, repo: name });
        const lastSnap = await ctx.runQuery(internal.metrics.lastForRepo, { ownerId, repo: name });

        const signals: { kind: "release" | "pr_merged" | "repo_created" | "readme_changed" | "star_milestone" | "download_milestone"; repo: string; ref: string; title: string; payload: unknown; occurredAt: number }[] = [];
        for (const r of allReleases) {
          const at = Date.parse(r.published_at);
          if (at < since) continue;
          signals.push({ kind: "release", repo: name, ref: `gh:release:${name}@${r.tag_name}`, title: `${name} ${r.tag_name}`, payload: { tag: r.tag_name, name: r.name, body: r.body?.slice(0, 4000), url: r.html_url }, occurredAt: at });
        }
        for (const p of prs ?? []) {
          if (!p.merged_at) continue;
          const at = Date.parse(p.merged_at);
          if (at < since) continue;
          signals.push({ kind: "pr_merged", repo: name, ref: `gh:pr:${name}#${p.number}`, title: p.title, payload: { number: p.number, url: p.html_url }, occurredAt: at });
        }
        const createdAt = Date.parse(repo.created_at);
        if (createdAt >= since) signals.push({ kind: "repo_created", repo: name, ref: `gh:repo:${name}`, title: `새 저장소 ${name}`, payload: { description: repo.description }, occurredAt: createdAt });
        const starT = crossedThreshold(prev.lastStarThreshold ?? lastSnap?.stars, repo.stargazers_count, STAR_THRESHOLDS);
        if (starT) signals.push({ kind: "star_milestone", repo: name, ref: `gh:stars:${name}#${starT}`, title: `${name} ${starT} stars`, payload: { threshold: starT, stars: repo.stargazers_count }, occurredAt: Date.now() });

        // npm: package.json name이 있고 공개돼 있으면 다운로드 조회
        let npmPackage: string | undefined;
        let npmMonthlyDownloads: number | undefined;
        const pkgRaw = await gh<{ content: string }>(`/repos/${name}/contents/package.json`, token);
        if (pkgRaw) {
          try {
            const pkg = JSON.parse(Buffer.from(pkgRaw.content, "base64").toString("utf8")) as { name?: string; private?: boolean };
            if (pkg.name && !pkg.private) {
              const dl = await fetch(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(pkg.name)}`);
              if (dl.ok) {
                const j = (await dl.json()) as { downloads: number };
                npmPackage = pkg.name;
                npmMonthlyDownloads = j.downloads;
                const dlT = crossedThreshold(prev.lastDownloadThreshold ?? lastSnap?.npmDownloadsMonth, j.downloads, DOWNLOAD_THRESHOLDS);
                if (dlT) signals.push({ kind: "download_milestone", repo: name, ref: `npm:dl:${pkg.name}#${dlT}`, title: `${pkg.name} ${dlT} downloads/month`, payload: { threshold: dlT, downloads: j.downloads }, occurredAt: Date.now() });
              }
            }
          } catch {
            /* package.json 파싱 실패는 무시 */
          }
        }

        const latest = allReleases[0];
        const sinceIso = new Date(latest ? Math.min(Date.parse(latest.published_at), since) : since).toISOString();
        const commits = await gh<{ commit: { message: string } }[]>(`/repos/${name}/commits?since=${encodeURIComponent(sinceIso)}&per_page=100`, token);
        const commitSubjects = (commits ?? []).map((c) => c.commit.message.split("\n")[0].trim()).filter((m) => m && !/^(merge|chore\(deps|bump|release v?\d)/i.test(m)).slice(0, 80);
        const commitsHead = await fetch(`${GH}/repos/${name}/commits?per_page=1`, { headers: { Authorization: `Bearer ${token}`, "User-Agent": "somun" } });
        const link = commitsHead.headers.get("link") ?? "";
        const commitCount = Number(/page=(\d+)>; rel="last"/.exec(link)?.[1] ?? (commitsHead.ok ? 1 : 0));

        const evidence = {
          repo: name,
          repoUrl: repo.html_url,
          description: repo.description ?? undefined,
          version: latest?.tag_name,
          releaseNotes: latest?.body?.slice(0, 3000),
          stars: repo.stargazers_count,
          forks: repo.forks_count,
          commitCount,
          releaseCount: allReleases.length,
          firstReleaseAt: allReleases.at(-1)?.published_at?.slice(0, 10),
          language: repo.language ?? undefined,
          license: repo.license?.spdx_id,
          homepage: repo.homepage || undefined,
          npmPackage,
          npmMonthlyDownloads,
          demoAsset: firstGif(readme),
          limitations: limitationsFrom(readme),
          readmeExcerpt: readme.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 1500),
          commitSubjects,
        };

        await ctx.runMutation(internal.metrics.snapshot, {
          ownerId, repo: name, stars: repo.stargazers_count, forks: repo.forks_count,
          viewsUniques14d: traffic?.uniques, referrers: referrers?.slice(0, 10).map((r) => ({ referrer: r.referrer, uniques: r.uniques })), npmDownloadsMonth: npmMonthlyDownloads,
        });
        await ctx.runMutation(internal.candidates.refreshEvidence, { ownerId, repo: name, evidence });
        if (signals.length) {
          const result = await ctx.runMutation(internal.signals.ingest, {
            ownerId, sourceId, signals,
            context: { latestReleaseAt: prev.latestReleaseAt ?? (latest ? Date.parse(latest.published_at) : undefined), repoCreatedAt: createdAt, recentPrCount: prev.recentPrCount + signals.filter((s) => s.kind === "pr_merged").length },
            evidence,
          });
          summary[name] = result.inserted;
        }
      }
      await ctx.runMutation(internal.sources.markPolled, { id: sourceId });
    } catch (e) {
      await ctx.runMutation(internal.sources.markPolled, { id: sourceId, error: (e as Error).message });
      throw e;
    }
    // 새 후보 판단은 별도 액션에서 (LLM 호출을 수집 실패와 분리)
    await ctx.scheduler.runAfter(0, internal.llm.judgePending, { ownerId });
    return { summary };
  },
});

export const runAll = internalAction({
  args: {},
  handler: async (ctx): Promise<{ sources: number }> => {
    const sources = await ctx.runQuery(internal.sources.listEnabled, { kind: "github" });
    for (const s of sources) {
      try {
        await ctx.runAction(internal.collect.collectGithubSource, { sourceId: s._id });
      } catch (e) {
        console.error(`collect ${s._id} failed`, e);
      }
    }
    return { sources: sources.length };
  },
});

/** 화면의 "지금 확인" 버튼. 내 소스만 돈다. */
export const runMine = action({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    const ownerId = await getOwnerId(ctx);
    const sources = await ctx.runQuery(internal.sources.listEnabled, { ownerId, kind: "github" });
    const results: Record<string, unknown> = {};
    for (const s of sources) {
      try {
        results[s._id] = await ctx.runAction(internal.collect.collectGithubSource, { sourceId: s._id });
      } catch (e) {
        results[s._id] = { error: (e as Error).message };
      }
    }
    return results;
  },
});
