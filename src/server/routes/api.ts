import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { ALL_CHANNELS, type Channel } from "../../core/channels.js";
import { getCandidateDetail, listInbox, overrideJudgment, setCandidateStatus } from "../../app/candidates.js";
import { collectAll, profileMaterialFor } from "../../app/collect.js";
import { editProfile, getProfile, listProfiles, regenerateProfile } from "../../app/profiles.js";
import { acceptSuggestion, dismissSuggestion, GUIDE_MAX_CHARS, listSuggestions } from "../../app/learning.js";
import { learningStats } from "../../app/learning-stats.js";
import { sendWeeklySummary } from "../../app/notify.js";
import { deleteAccount, exportAccount } from "../../app/account.js";
import { refreshReactions } from "../../app/reactions.js";
import { isTrusted, NotFoundError, type AppContext } from "../../app/context.js";
import { assertPublicUrl } from "../../infra/net.js";
import { retryGeneration, generationStatus, claimJob, completeJob, pendingJobs } from "../../app/jobs.js";
import { keyStatus } from "../../app/keys.js";
import { ingestSessions } from "../../app/sessions.js";
import { connectorsView, githubAppConfig, issueInstallLink, listInstallationRepos, recordInstallation, setWatchedRepos } from "../../app/connectors.js";
import type { Config } from "../config.js";
import { canConfigureGithubApp, startGithubAppSetup } from "./github-app.js";
import { queueStep } from "../../app/pipeline.js";
import { listPublicationsWithMetrics, performanceSummary, registerPublication, removePublication, setManualStats, updatePublicationUrl } from "../../app/publications.js";
import { addExample, dropDraft, importSeeds, listExamples, removeExample, saveDraftEdit, setExampleActive } from "../../app/review.js";
import { getSettingsView, updateSettings } from "../../app/settings.js";
import { assertModelEndpoint } from "../../app/net-policy.js";
import { listSources, removeSource, upsertSource } from "../../app/sources.js";
import type { ChangeEvent } from "../../shared/types.js";
import { TicketStore, type AuthVars } from "../auth.js";
import { listVideos, requestVideo, videoFile } from "../../app/videos.js";
import { issueBridgeToken, listBridgeTokens, revokeBridgeToken, videoConfig } from "../../app/bridges.js";
import { VIDEO_ASPECTS, VIDEO_DURATIONS } from "../../shared/video.js";
import { launchCheck } from "../../app/launch-check.js";

const channel = z.enum(ALL_CHANNELS as [Channel, ...Channel[]]);
const lang = z.string().min(2).max(8).regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/);
const reason = z.enum(["wrong_facts", "voice", "wrong_channel", "not_yet", "not_worth", "other"]);
const id = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new NotFoundError("id");
  return n;
};

/** /api 아래 전부. 얇은 층: 검증 → 유스케이스 → JSON. */
export function apiRoutes(ctx: AppContext, config: Config, tickets: TicketStore = new TicketStore()) {
  const app = new Hono<{ Variables: AuthVars }>();
  const body = async <T>(c: { req: { json: () => Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> => {
    let input: unknown;
    try {
      input = await c.req.json();
    } catch (err) {
      if (err instanceof SyntaxError) throw new HTTPException(400, { message: "invalid JSON" });
      throw err;
    }
    return schema.parse(input);
  };

  app.get("/me", (c) => c.json({ ownerId: c.get("ownerId") }));

  // settings
  app.get("/settings", (c) => c.json(getSettingsView(ctx, c.get("ownerId"))));
  app.patch("/settings", async (c) => {
    const input = await body(c, z.object({
      rubricWeights: z.object({ runnable: z.number(), numbers: z.number(), lesson: z.number(), novelty: z.number(), audience: z.number() }).optional(),
      draftThreshold: z.number().optional(), deferThreshold: z.number().optional(),
      channelLangs: z.record(channel, z.array(lang)).optional(), bannedPhrases: z.array(z.string()).optional(),
      llm: z.object({ provider: z.enum(["gemini", "anthropic", "openai", "local-agent"]), model: z.string().optional(), draftModel: z.string().optional(), apiKey: z.string().optional(), baseUrl: z.string().optional(), agentCli: z.enum(["claude", "codex"]).optional() }).optional(),
      keepApiKey: z.boolean().optional(),
      watch: z.object({ mode: z.enum(["manual", "auto"]), recentDays: z.number().int().min(1).max(365) }).optional(),
      ui: z.object({ onboardingDismissedAt: z.number().optional(), locale: z.enum(["ko", "en"]).optional() }).optional(),
      notify: z.object({ discordWebhookUrl: z.string().url().startsWith("https://discord.com/api/webhooks/").or(z.literal("")).optional(), weekly: z.boolean() }).optional(),
      voice: z.object({ preset: z.string().max(40), guide: z.string().max(GUIDE_MAX_CHARS), useExamples: z.boolean(), chosenAt: z.number().optional() }).optional(),
      trackLinks: z.boolean().optional(),
    }));
    const { keepApiKey, ...patch } = input;
    if (patch.llm) await assertModelEndpoint(ctx, c.get("ownerId"), patch.llm);
    return c.json(updateSettings(ctx, c.get("ownerId"), patch, keepApiKey ?? true));
  });

  // sources
  app.get("/sources", (c) => c.json(listSources(ctx, c.get("ownerId"))));
  app.post("/sources", async (c) => {
    const input = await body(c, z.object({ id: z.number().optional(), kind: z.enum(["github", "npm", "blog", "omp"]), targets: z.array(z.string().min(1)), options: z.record(z.string(), z.string()).optional(), enabled: z.boolean() }));
    // 피드 주소는 저장할 때도 확인해 바로 알려준다(수집할 때 다시 확인한다).
    if (input.kind === "blog" && !isTrusted(ctx, c.get("ownerId"))) for (const url of input.targets) await assertPublicUrl(url);
    return c.json(upsertSource(ctx, c.get("ownerId"), input));
  });
  app.delete("/sources/:id", (c) => { removeSource(ctx, c.get("ownerId"), id(c.req.param("id"))); return c.body(null, 204); });
  app.post("/collect", async (c) => c.json(await collectAll(ctx, c.get("ownerId"))));

  // candidates
  app.get("/candidates", (c) => c.json(listInbox(ctx, c.get("ownerId"))));
  app.get("/candidates/:id", (c) => c.json(getCandidateDetail(ctx, c.get("ownerId"), id(c.req.param("id")))));
  app.post("/candidates/:id/status", async (c) => { setCandidateStatus(ctx, c.get("ownerId"), id(c.req.param("id")), (await body(c, z.object({ status: z.enum(["new", "judged", "drafted", "published", "dropped", "deferred"]) }))).status); return c.body(null, 204); });
  app.post("/candidates/:id/override", async (c) => { const i = await body(c, z.object({ decision: z.enum(["draft", "drop"]), reason, note: z.string().optional() })); overrideJudgment(ctx, c.get("ownerId"), id(c.req.param("id")), i.decision, i.reason, i.note); return c.body(null, 204); });
  // Persist first, acknowledge immediately; clients follow the status resource.
  app.post("/candidates/judge", async (c) => {
    const { ids } = await body(c, z.object({ ids: z.array(z.number().int()).min(1).max(50) }));
    const jobs = ctx.db.$client.transaction(() => [...new Set(ids)].map((cid) => queueStep(ctx, c.get("ownerId"), "digest", cid))).immediate();
    c.header("Location", "/api/jobs/status"); c.header("Retry-After", "5");
    return c.json({ started: jobs.length, jobs }, 202);
  });
  app.post("/candidates/:id/rejudge", (c) => {
    const cid = id(c.req.param("id"));
    const job = queueStep(ctx, c.get("ownerId"), "digest", cid);
    c.header("Location", `/api/jobs/status?candidateId=${cid}`); c.header("Retry-After", "5");
    return c.json({ started: "queued", jobs: [job] }, 202);
  });
  app.post("/candidates/:id/redraft", async (c) => {
    const { targets, instruction, introduction } = await body(c, z.object({ introduction: z.boolean().optional(), targets: z.array(z.object({ channel, lang })).min(1).max(30), instruction: z.string().max(600).optional() }));
    const ownerId = c.get("ownerId"), cid = id(c.req.param("id"));
    const cand = getCandidateDetail(ctx, ownerId, cid).candidate;
    const unique = targets.filter((t, i) => targets.findIndex((o) => o.channel === t.channel && o.lang === t.lang) === i);
    const jobs = ctx.db.$client.transaction(() => introduction || cand.evidence.highlightsAt
      ? unique.map((t) => queueStep(ctx, ownerId, "draft", cid, t.channel, t.lang, { instruction, introduction }))
      : [queueStep(ctx, ownerId, "digest", cid, undefined, undefined, { continuation: { targets: unique, instruction } })]).immediate();
    c.header("Location", `/api/jobs/status?candidateId=${cid}`); c.header("Retry-After", "5");
    return c.json({ started: "queued", jobs }, 202);
  });

  // videos: 글감 → 짧은 영상(영상 서버 + 사용자의 Claude Code)
  app.get("/video", async (c) => c.json(await videoConfig(ctx, c.get("ownerId"))));
  app.get("/video/bridges", async (c) => c.json(await listBridgeTokens(ctx, c.get("ownerId"))));
  app.post("/video/bridges", async (c) => c.json(await issueBridgeToken(ctx, c.get("ownerId"), (await body(c, z.object({ label: z.string().max(60) }))).label), 201));
  app.delete("/video/bridges/:id", async (c) => c.json(await revokeBridgeToken(ctx, c.get("ownerId"), c.req.param("id"))));
  app.get("/candidates/:id/launch-check", async (c) => c.json(await launchCheck(ctx, c.get("ownerId"), id(c.req.param("id")))));
  app.get("/candidates/:id/videos", async (c) => c.json(await listVideos(ctx, c.get("ownerId"), id(c.req.param("id")))));
  app.post("/candidates/:id/videos", async (c) => {
    const i = await body(c, z.object({ durationSec: z.union([z.literal(VIDEO_DURATIONS[0]), z.literal(VIDEO_DURATIONS[1]), z.literal(VIDEO_DURATIONS[2])]), aspect: z.enum(VIDEO_ASPECTS), draftId: z.number().int().positive().optional() }));
    return c.json(await requestVideo(ctx, c.get("ownerId"), id(c.req.param("id")), i), 202);
  });
  app.get("/videos/:id/file", async (c) => {
    const res = await videoFile(ctx, c.get("ownerId"), id(c.req.param("id")), c.req.header("range"));
    const headers = new Headers();
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) { const v = res.headers.get(h); if (v) headers.set(h, v); }
    headers.set("cache-control", "private, no-store");
    return new Response(res.body, { status: res.status, headers });
  });

  // drafts
  app.post("/drafts/:id/edit", async (c) => c.json(saveDraftEdit(ctx, c.get("ownerId"), id(c.req.param("id")), await body(c, z.object({ title: z.string().optional(), body: z.string().min(1), markCopied: z.boolean() })))));
  app.post("/drafts/:id/drop", async (c) => { const i = await body(c, z.object({ reason, note: z.string().optional() })); dropDraft(ctx, c.get("ownerId"), id(c.req.param("id")), i.reason, i.note); return c.body(null, 204); });

  // repo profiles (정체성 기준선)
  app.get("/profiles", (c) => c.json(listProfiles(ctx, c.get("ownerId"))));
  app.get("/profiles/:owner/:name", (c) => { const p = getProfile(ctx, c.get("ownerId"), `${c.req.param("owner")}/${c.req.param("name")}`); return p ? c.json(p) : c.json({ error: "no profile" }, 404); });
  app.patch("/profiles/:owner/:name", async (c) => c.json(editProfile(ctx, c.get("ownerId"), `${c.req.param("owner")}/${c.req.param("name")}`, await body(c, z.object({ what: z.string().max(400).optional(), audience: z.string().max(400).optional(), claims: z.array(z.string().max(200)).max(6).optional(), stage: z.enum(["experiment", "beta", "stable", "archived", "unknown"]).optional(), limitations: z.array(z.string().max(300)).max(8).optional(), naming: z.string().max(200).optional(), avoid: z.array(z.string().max(100)).max(12).optional() })))));
  app.post("/profiles/:owner/:name/regenerate", async (c) => {
    const repo = `${c.req.param("owner")}/${c.req.param("name")}`;
    const r = await regenerateProfile(ctx, c.get("ownerId"), await profileMaterialFor(ctx, c.get("ownerId"), repo));
    // local-agent: 워커가 만들면 candidates 변경 이벤트로 화면이 갱신된다.
    return r.queued ? c.json(r, 202) : c.json(r);
  });

  // 계정: 내보내기(JSON), 삭제(확인 문구 필요)
  app.get("/account/export", (c) => { c.header("Content-Disposition", `attachment; filename="somun-export-${new Date().toISOString().slice(0, 10)}.json"`); return c.json(exportAccount(ctx, c.get("ownerId"))); });
  app.post("/account/delete", async (c) => { const { confirm } = await body(c, z.object({ confirm: z.enum(["삭제", "delete"]) })); void confirm; return c.json(deleteAccount(ctx, c.get("ownerId"))); });

  // 알림 시험 발송
  app.post("/notify/test", async (c) => { const r = await sendWeeklySummary(ctx, c.get("ownerId"), true); return r.ok ? c.json(r) : c.json(r, 400); });

  // 지침 제안 (학습 루프)
  app.get("/suggestions", (c) => c.json(listSuggestions(ctx, c.get("ownerId"))));
  app.post("/suggestions/:id/accept", (c) => { acceptSuggestion(ctx, c.get("ownerId"), id(c.req.param("id"))); return c.body(null, 204); });
  app.post("/suggestions/:id/dismiss", (c) => { dismissSuggestion(ctx, c.get("ownerId"), id(c.req.param("id"))); return c.body(null, 204); });
  app.get("/learning/stats", (c) => c.json(learningStats(ctx, c.get("ownerId"))));
  app.get("/publications/summary", (c) => c.json(performanceSummary(ctx, c.get("ownerId"))));
  app.post("/publications/refresh", async (c) => c.json({ refreshed: await refreshReactions(ctx, c.get("ownerId"), true) }));

  // publications
  app.get("/publications", (c) => c.json(listPublicationsWithMetrics(ctx, c.get("ownerId"))));
  app.post("/publications", async (c) => c.json({ id: registerPublication(ctx, c.get("ownerId"), await body(c, z.object({ candidateId: z.number(), draftId: z.number().optional(), channel, lang: lang.optional(), url: z.string().url() }))) }));
  app.patch("/publications/:id", async (c) => { updatePublicationUrl(ctx, c.get("ownerId"), id(c.req.param("id")), (await body(c, z.object({ url: z.string().url() }))).url); return c.body(null, 204); });
  app.delete("/publications/:id", (c) => { removePublication(ctx, c.get("ownerId"), id(c.req.param("id"))); return c.body(null, 204); });
  app.post("/publications/:id/stats", async (c) => { setManualStats(ctx, c.get("ownerId"), id(c.req.param("id")), await body(c, z.object({ likes: z.number().optional(), comments: z.number().optional(), reposts: z.number().optional() }))); return c.body(null, 204); });

  // examples
  app.get("/examples", (c) => c.json(listExamples(ctx, c.get("ownerId"), c.req.query("channel") as Channel | undefined)));
  app.post("/examples", async (c) => c.json(addExample(ctx, c.get("ownerId"), await body(c, z.object({ channel, lang, title: z.string().optional(), body: z.string().min(1), note: z.string().optional(), source: z.enum(["seed", "approved"]).optional() })))));
  app.post("/examples/import", async (c) => c.json({ inserted: importSeeds(ctx, c.get("ownerId"), (await body(c, z.object({ items: z.array(z.object({ channel, lang, title: z.string().optional(), body: z.string().min(1), note: z.string().optional() })) }))).items) }));
  app.post("/examples/:id/active", async (c) => { setExampleActive(ctx, c.get("ownerId"), id(c.req.param("id")), (await body(c, z.object({ active: z.boolean() }))).active); return c.body(null, 204); });
  app.delete("/examples/:id", (c) => { removeExample(ctx, c.get("ownerId"), id(c.req.param("id"))); return c.body(null, 204); });

  // keys · jobs · omp
  // 서버 키 풀 상태는 운영자만. 다른 계정에는 빈 목록.
  app.get("/keys", (c) => c.json(isTrusted(ctx, c.get("ownerId")) ? keyStatus(ctx) : []));
  app.post("/jobs/:id/retry", (c) => { const job = retryGeneration(ctx, c.get("ownerId"), id(c.req.param("id"))); c.header("Location", "/api/jobs/status"); c.header("Retry-After", "5"); return c.json({ started: "queued", jobs: [job] }, 202); });
  app.get("/jobs/status", (c) => c.json(generationStatus(ctx, c.get("ownerId"), c.req.query("candidateId") === undefined ? undefined : id(c.req.query("candidateId")!))));
  app.get("/jobs/pending", (c) => c.json(pendingJobs(ctx, c.get("ownerId"))));
  app.post("/jobs/:id/claim", async (c) => c.json(claimJob(ctx, c.get("ownerId"), id(c.req.param("id")), (await body(c, z.object({ runner: z.string().min(1).max(200) }))).runner)));
  app.post("/jobs/:id/complete", async (c) => c.json(await completeJob(ctx, c.get("ownerId"), id(c.req.param("id")), await body(c, z.object({ claimToken: z.string().uuid(), resultJson: z.string().optional(), error: z.string().optional(), model: z.string().optional() })))));
  const sessionsBody = z.object({ repos: z.array(z.object({ repo: z.string(), summary: z.string(), sessions: z.array(z.object({ sessionId: z.string(), source: z.string(), startedAt: z.number(), promptCount: z.number(), retries: z.number().optional(), topic: z.string() })) })) });
  app.post("/sessions", async (c) => c.json(ingestSessions(ctx, c.get("ownerId"), (await body(c, sessionsBody)).repos)));
  app.post("/omp/sessions", async (c) => c.json(ingestSessions(ctx, c.get("ownerId"), (await body(c, sessionsBody)).repos)));

  // connectors · GitHub App
  app.get("/connectors", (c) => c.json(connectorsView(ctx, c.get("ownerId"))));
  app.get("/github/app", (c) => {
    const cfg = githubAppConfig(ctx);
    return c.json({ configured: Boolean(cfg), slug: cfg?.slug, installUrl: cfg?.slug ? `https://github.com/apps/${cfg.slug}/installations/new` : undefined, canConfigure: canConfigureGithubApp(c, config) });
  });
  app.post("/github/app/setup", startGithubAppSetup(ctx, config));
  /** 설치 완료 후 GitHub가 보내는 곳. 로그인된 브라우저에서 열리므로 ownerId를 안다. */
  app.get("/github/installations/:id/repos", async (c) => c.json(await listInstallationRepos(ctx, c.get("ownerId"), id(c.req.param("id")))));
  app.post("/github/installations/:id/watch", async (c) => {
    const { repos } = await body(c, z.object({ repos: z.array(z.string().min(3)).max(500) }));
    const r = setWatchedRepos(ctx, c.get("ownerId"), id(c.req.param("id")), repos);
    // 고른 즉시 한 번 수집한다. 자동 모드가 아니면 글감은 "새 글감"으로만 쌓인다.
    // 소유자별 수집 잠금을 거친다. 크론·"지금 확인"과 겹쳐도 한 번만 돈다.
    if (r.count) void collectAll(ctx, c.get("ownerId")).catch((e: Error) => ctx.log.warn({ err: e.message }, "collect after watch failed"));
    return c.json(r);
  });
  /** 설치 링크(1회용 state 포함). 설치는 이 링크로 시작해야 콜백에서 이 계정의 것으로 확인된다. */
  app.post("/github/install-link", (c) => {
    const url = issueInstallLink(ctx, c.get("ownerId"));
    return url ? c.json({ url }) : c.json({ error: "GitHub App is not configured" }, 404);
  });
  app.get("/github/setup", async (c) => {
    const installationId = id(c.req.query("installation_id") ?? "");
    const r = await recordInstallation(ctx, c.get("ownerId"), installationId, { code: c.req.query("code") || undefined, state: c.req.query("state") || undefined });
    return c.json({ ok: true, ...r });
  });
  /** SSE 1회용 티켓. EventSource는 헤더를 못 붙이므로 토큰 대신 이것을 주소에 넣는다. */
  app.post("/events/ticket", (c) => c.json({ ticket: tickets.issue(c.get("ownerId"), c.get("authMethod")) }));
  // SSE: 내 자원이 바뀌면 알려준다. 화면은 다시 fetch.
  app.get("/events", (c) => {
    const ownerId = c.get("ownerId");
    return streamSSE(c, async (stream) => {
      const onChange = (ev: ChangeEvent & { ownerId: string }) => {
        if (ev.ownerId === ownerId || ev.ownerId === "*") void stream.writeSSE({ event: "change", data: JSON.stringify(ev) });
      };
      ctx.bus.on("change", onChange);
      const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 25_000);
      stream.onAbort(() => { ctx.bus.off("change", onChange); clearInterval(ping); });
      await new Promise<void>((resolve) => stream.onAbort(resolve));
    });
  });

  return app;
}
