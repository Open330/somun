import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { ALL_CHANNELS, type Channel } from "../../core/channels.js";
import { getCandidateDetail, listInbox, overrideJudgment, setCandidateStatus } from "../../app/candidates.js";
import { collectAll, collectGithubSource, profileMaterialFor } from "../../app/collect.js";
import { editProfile, getProfile, listProfiles, regenerateProfile } from "../../app/profiles.js";
import { acceptSuggestion, dismissSuggestion, listSuggestions } from "../../app/learning.js";
import { sendWeeklySummary } from "../../app/notify.js";
import { deleteAccount, exportAccount } from "../../app/account.js";
import { NotFoundError, type AppContext } from "../../app/context.js";
import { claimJob, completeJob, pendingJobs } from "../../app/jobs.js";
import { keyStatus } from "../../app/keys.js";
import { ingestSessions } from "../../app/sessions.js";
import { connectorsView, githubAppConfig, listInstallationRepos, recordInstallation, setWatchedRepos } from "../../app/connectors.js";
import { appManifest } from "../../infra/github/app.js";
import { judgeCandidates, runStep } from "../../app/pipeline.js";
import { listPublicationsWithMetrics, performanceSummary, registerPublication, setManualStats } from "../../app/publications.js";
import { addExample, dropDraft, importSeeds, listExamples, removeExample, saveDraftEdit, setExampleActive } from "../../app/review.js";
import { getSettingsView, updateSettings } from "../../app/settings.js";
import { listSources, removeSource, upsertSource } from "../../app/sources.js";
import type { ChangeEvent } from "../../shared/types.js";
import type { AuthVars } from "../auth.js";

const channel = z.enum(ALL_CHANNELS as [Channel, ...Channel[]]);
const lang = z.string().min(2).max(8).regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/);
const reason = z.enum(["wrong_facts", "voice", "wrong_channel", "not_yet", "not_worth", "other"]);
const id = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new NotFoundError("id");
  return n;
};

function publicBase(url: string, proto?: string, host?: string): string {
  const u = new URL(url);
  return `${proto ?? u.protocol.replace(":", "")}://${host ?? u.host}`;
}

/** /api 아래 전부. 얇은 층: 검증 → 유스케이스 → JSON. */
export function apiRoutes(ctx: AppContext) {
  const app = new Hono<{ Variables: AuthVars }>();
  const body = async <T>(c: { req: { json: () => Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> => schema.parse(await c.req.json());

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
      ui: z.object({ onboardingDismissedAt: z.number().optional() }).optional(),
      notify: z.object({ discordWebhookUrl: z.string().url().startsWith("https://discord.com/api/webhooks/").or(z.literal("")).optional(), weekly: z.boolean() }).optional(),
      voice: z.object({ preset: z.string().max(40), guide: z.string().max(2000), useExamples: z.boolean(), chosenAt: z.number().optional() }).optional(),
    }));
    const { keepApiKey, ...patch } = input;
    return c.json(updateSettings(ctx, c.get("ownerId"), patch, keepApiKey ?? true));
  });

  // sources
  app.get("/sources", (c) => c.json(listSources(ctx, c.get("ownerId"))));
  app.post("/sources", async (c) => c.json(upsertSource(ctx, c.get("ownerId"), await body(c, z.object({ id: z.number().optional(), kind: z.enum(["github", "npm", "blog", "omp"]), targets: z.array(z.string().min(1)), options: z.record(z.string(), z.string()).optional(), enabled: z.boolean() })))));
  app.delete("/sources/:id", (c) => { removeSource(ctx, c.get("ownerId"), id(c.req.param("id"))); return c.body(null, 204); });
  app.post("/collect", async (c) => c.json(await collectAll(ctx, c.get("ownerId"))));

  // candidates
  app.get("/candidates", (c) => c.json(listInbox(ctx, c.get("ownerId"))));
  app.get("/candidates/:id", (c) => c.json(getCandidateDetail(ctx, c.get("ownerId"), id(c.req.param("id")))));
  app.post("/candidates/:id/status", async (c) => { setCandidateStatus(ctx, c.get("ownerId"), id(c.req.param("id")), (await body(c, z.object({ status: z.enum(["new", "judged", "drafted", "published", "dropped", "deferred"]) }))).status); return c.body(null, 204); });
  app.post("/candidates/:id/override", async (c) => { const i = await body(c, z.object({ decision: z.enum(["draft", "drop"]), reason, note: z.string().optional() })); overrideJudgment(ctx, c.get("ownerId"), id(c.req.param("id")), i.decision, i.reason, i.note); return c.body(null, 204); });
  // 수동 모드: 고른 글감만 판단. 오래 걸리므로 시작만 알리고 진행은 SSE로.
  app.post("/candidates/judge", async (c) => { const { ids } = await body(c, z.object({ ids: z.array(z.number().int()).min(1).max(50) })); void judgeCandidates(ctx, c.get("ownerId"), ids); return c.json({ started: ids.length }); });
  app.post("/candidates/:id/rejudge", async (c) => c.json(await runStep(ctx, c.get("ownerId"), "digest", id(c.req.param("id")))));
  app.post("/candidates/:id/redraft", async (c) => {
    const { targets, instruction } = await body(c, z.object({ targets: z.array(z.object({ channel, lang })).min(1), instruction: z.string().max(600).optional() }));
    const out: Record<string, unknown> = {};
    // 아직 다이제스트가 없는 새 글감이면 초안만 쓸 수 없다. 다이제스트(→판단은 안에서 이어짐) 뒤 요청한 초안을 쓴다.
    // 세 단계를 합치면 Cloudflare 100초를 넘기므로 시작만 알리고 뒤에서 돌린다. 진행은 SSE로 화면에 보인다.
    const ownerId = c.get("ownerId");
    const cand = getCandidateDetail(ctx, ownerId, id(c.req.param("id"))).candidate;
    if (!cand.evidence.highlightsAt) {
      void (async () => {
        try {
          await runStep(ctx, ownerId, "digest", cand.id);
          for (const t of targets) await runStep(ctx, ownerId, "draft", cand.id, t.channel, t.lang, { instruction });
        } catch (e) { ctx.log.warn({ id: cand.id, err: (e as Error).message }, "chain from fresh failed"); }
      })();
      return c.json({ started: "chain", targets: targets.length });
    }
    for (const t of targets) out[`${t.channel}:${t.lang}`] = await runStep(ctx, c.get("ownerId"), "draft", id(c.req.param("id")), t.channel, t.lang, { instruction });
    return c.json(out);
  });

  // drafts
  app.post("/drafts/:id/edit", async (c) => c.json(saveDraftEdit(ctx, c.get("ownerId"), id(c.req.param("id")), await body(c, z.object({ title: z.string().optional(), body: z.string().min(1), markCopied: z.boolean() })))));
  app.post("/drafts/:id/drop", async (c) => { const i = await body(c, z.object({ reason, note: z.string().optional() })); dropDraft(ctx, c.get("ownerId"), id(c.req.param("id")), i.reason, i.note); return c.body(null, 204); });

  // repo profiles (정체성 기준선)
  app.get("/profiles", (c) => c.json(listProfiles(ctx, c.get("ownerId"))));
  app.get("/profiles/:owner/:name", (c) => { const p = getProfile(ctx, c.get("ownerId"), `${c.req.param("owner")}/${c.req.param("name")}`); return p ? c.json(p) : c.json({ error: "no profile" }, 404); });
  app.patch("/profiles/:owner/:name", async (c) => c.json(editProfile(ctx, c.get("ownerId"), `${c.req.param("owner")}/${c.req.param("name")}`, await body(c, z.object({ what: z.string().max(400).optional(), audience: z.string().max(400).optional(), claims: z.array(z.string().max(200)).max(6).optional(), stage: z.enum(["experiment", "beta", "stable", "archived", "unknown"]).optional(), limitations: z.array(z.string().max(300)).max(8).optional(), naming: z.string().max(200).optional(), avoid: z.array(z.string().max(100)).max(12).optional() })))));
  app.post("/profiles/:owner/:name/regenerate", async (c) => { const repo = `${c.req.param("owner")}/${c.req.param("name")}`; return c.json(await regenerateProfile(ctx, c.get("ownerId"), await profileMaterialFor(ctx, c.get("ownerId"), repo))); });

  // 계정: 내보내기(JSON), 삭제(확인 문구 필요)
  app.get("/account/export", (c) => { c.header("Content-Disposition", `attachment; filename="somun-export-${new Date().toISOString().slice(0, 10)}.json"`); return c.json(exportAccount(ctx, c.get("ownerId"))); });
  app.post("/account/delete", async (c) => { const { confirm } = await body(c, z.object({ confirm: z.literal("삭제") })); void confirm; return c.json(deleteAccount(ctx, c.get("ownerId"))); });

  // 알림 시험 발송
  app.post("/notify/test", async (c) => { const r = await sendWeeklySummary(ctx, c.get("ownerId"), true); return r.ok ? c.json(r) : c.json(r, 400); });

  // 지침 제안 (학습 루프)
  app.get("/suggestions", (c) => c.json(listSuggestions(ctx, c.get("ownerId"))));
  app.post("/suggestions/:id/accept", (c) => { acceptSuggestion(ctx, c.get("ownerId"), id(c.req.param("id"))); return c.body(null, 204); });
  app.post("/suggestions/:id/dismiss", (c) => { dismissSuggestion(ctx, c.get("ownerId"), id(c.req.param("id"))); return c.body(null, 204); });
  app.get("/publications/summary", (c) => c.json(performanceSummary(ctx, c.get("ownerId"))));

  // publications
  app.get("/publications", (c) => c.json(listPublicationsWithMetrics(ctx, c.get("ownerId"))));
  app.post("/publications", async (c) => c.json({ id: registerPublication(ctx, c.get("ownerId"), await body(c, z.object({ candidateId: z.number(), draftId: z.number().optional(), channel, lang: lang.optional(), url: z.string().url() }))) }));
  app.post("/publications/:id/stats", async (c) => { setManualStats(ctx, c.get("ownerId"), id(c.req.param("id")), await body(c, z.object({ likes: z.number().optional(), comments: z.number().optional(), reposts: z.number().optional() }))); return c.body(null, 204); });

  // examples
  app.get("/examples", (c) => c.json(listExamples(ctx, c.get("ownerId"), c.req.query("channel") as Channel | undefined)));
  app.post("/examples", async (c) => c.json(addExample(ctx, c.get("ownerId"), await body(c, z.object({ channel, lang, title: z.string().optional(), body: z.string().min(1), note: z.string().optional(), source: z.enum(["seed", "approved"]).optional() })))));
  app.post("/examples/import", async (c) => c.json({ inserted: importSeeds(ctx, c.get("ownerId"), (await body(c, z.object({ items: z.array(z.object({ channel, lang, title: z.string().optional(), body: z.string().min(1), note: z.string().optional() })) }))).items) }));
  app.post("/examples/:id/active", async (c) => { setExampleActive(ctx, c.get("ownerId"), id(c.req.param("id")), (await body(c, z.object({ active: z.boolean() }))).active); return c.body(null, 204); });
  app.delete("/examples/:id", (c) => { removeExample(ctx, c.get("ownerId"), id(c.req.param("id"))); return c.body(null, 204); });

  // keys · jobs · omp
  app.get("/keys", (c) => c.json(keyStatus(ctx)));
  app.get("/jobs/pending", (c) => c.json(pendingJobs(ctx, c.get("ownerId"))));
  app.post("/jobs/:id/claim", async (c) => c.json({ claimed: claimJob(ctx, c.get("ownerId"), id(c.req.param("id")), (await body(c, z.object({ runner: z.string() }))).runner) }));
  app.post("/jobs/:id/complete", async (c) => c.json(await completeJob(ctx, c.get("ownerId"), id(c.req.param("id")), await body(c, z.object({ resultJson: z.string().optional(), error: z.string().optional(), model: z.string().optional() })))));
  const sessionsBody = z.object({ repos: z.array(z.object({ repo: z.string(), summary: z.string(), sessions: z.array(z.object({ sessionId: z.string(), source: z.string(), startedAt: z.number(), promptCount: z.number(), retries: z.number().optional(), topic: z.string() })) })) });
  app.post("/sessions", async (c) => c.json(ingestSessions(ctx, c.get("ownerId"), (await body(c, sessionsBody)).repos)));
  app.post("/omp/sessions", async (c) => c.json(ingestSessions(ctx, c.get("ownerId"), (await body(c, sessionsBody)).repos)));

  // connectors · GitHub App
  app.get("/connectors", (c) => c.json(connectorsView(ctx, c.get("ownerId"))));
  app.get("/github/app", (c) => {
    const cfg = githubAppConfig(ctx);
    const base = publicBase(c.req.url, c.req.header("x-forwarded-proto"), c.req.header("host"));
    return c.json({ configured: Boolean(cfg), slug: cfg?.slug, installUrl: cfg?.slug ? `https://github.com/apps/${cfg.slug}/installations/new` : undefined, manifest: cfg ? undefined : appManifest(base), createUrl: "https://github.com/settings/apps/new" });
  });
  /** 설치 완료 후 GitHub가 보내는 곳. 로그인된 브라우저에서 열리므로 ownerId를 안다. */
  app.get("/github/installations/:id/repos", async (c) => c.json(await listInstallationRepos(ctx, c.get("ownerId"), id(c.req.param("id")))));
  app.post("/github/installations/:id/watch", async (c) => {
    const { repos } = await body(c, z.object({ repos: z.array(z.string().min(3)).max(500) }));
    const r = setWatchedRepos(ctx, c.get("ownerId"), id(c.req.param("id")), repos);
    // 고른 즉시 한 번 수집한다. 자동 모드가 아니면 글감은 "새 글감"으로만 쌓인다.
    if (r.count) void collectGithubSource(ctx, r.sourceId).catch((e: Error) => ctx.log.warn({ err: e.message }, "collect after watch failed"));
    return c.json(r);
  });
  app.get("/github/setup", async (c) => {
    const id = Number(c.req.query("installation_id"));
    if (!id) return c.json({ error: "installation_id required" }, 400);
    const r = await recordInstallation(ctx, c.get("ownerId"), id);
    return c.json({ ok: true, ...r });
  });
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
