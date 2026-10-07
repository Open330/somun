import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDb, schema } from "../infra/db/index.js";
import { runLlm } from "../infra/llm/providers.js";
import type { AppContext } from "./context.js";
import { processServerJob } from "./generation-worker.js";
import { modelAvailability } from "./keys.js";
import { queueStep } from "./pipeline.js";
import { getSettingsView, updateSettings } from "./settings.js";

const OWNER = "https://api.jiun.dev|665f00000000000000000001";
const GATEWAY = { url: "http://jiun-api.test:3100/v1", key: "gw-key" };
const prompt = { system: "s", user: "u", schema: {}, schemaName: "t" };
let ctx: AppContext, cid: number, record: ReturnType<typeof vi.fn>;

beforeEach(() => {
  record = vi.fn();
  ctx = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: { llmGateway: GATEWAY }, bus: new EventEmitter(), usage: { record } as unknown as AppContext["usage"] };
  cid = Number(ctx.db.insert(schema.candidates).values({ ownerId: OWNER, repo: "a/b", title: "Fix", type: "release", key: "k", evidence: { repo: "a/b", repoUrl: "https://github.com/a/b", highlights: ["Fixes CRLF positions."], highlightsAt: 1 }, status: "judged", createdAt: 1, updatedAt: 1 }).run().lastInsertRowid);
});
afterEach(() => { vi.unstubAllGlobals(); ctx.db.$client.close(); });

const answer = (model: string) => new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"","body":"Fixes CRLF positions. https://github.com/a/b"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200, headers: { "X-Jiun-Model": model, "X-Jiun-Key-Label": "free-2" } });

it("leaves the direct Gemini path unchanged when the gateway is not configured", async () => {
  const fetchMock = vi.fn(async () => answer("gemini-3.5-flash-lite"));
  vi.stubGlobal("fetch", fetchMock);
  await runLlm({ provider: "gemini" }, prompt, "judge", undefined, '{"free-1":"k"}', new AbortController().signal, {});
  expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("generativelanguage.googleapis.com");
});

it("sends one request to the gateway with the service key and user, and reports no usage itself", async () => {
  const fetchMock = vi.fn(async () => answer("gemini-3.5-flash-lite"));
  vi.stubGlobal("fetch", fetchMock);
  queueStep(ctx, OWNER, "draft", cid, "x", "en");
  await processServerJob(ctx);
  // 보정 호출 없이 한 번(린트 통과 초안). 서버 무료 키도, 재시도 라운드도 쓰지 않는다.
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("http://jiun-api.test:3100/v1/chat/completions");
  const h = init.headers as Record<string, string>;
  expect(h.Authorization).toBe("Bearer gw-key");
  expect(h["X-Jiun-User"]).toBe("665f00000000000000000001");
  // 기본 초안 모델은 quality 별칭으로 보내고, 답한 실제 모델은 X-Jiun-Model에서 읽는다.
  expect(JSON.parse(String(init.body)).model).toBe("quality");
  expect(ctx.db.select().from(schema.drafts).get()?.model).toContain("gemini-3.5-flash-lite");
  expect(record).not.toHaveBeenCalled();
});

it("honours Retry-After on a gateway 429 without retrying, and shows the model as waiting until then", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "pool_exhausted", message: "busy" } }), { status: 429, headers: { "Retry-After": "120" } }));
  vi.stubGlobal("fetch", fetchMock);
  const id = queueStep(ctx, OWNER, "draft", cid, "x", "en");
  const before = Date.now();
  await processServerJob(ctx);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const job = ctx.db.select().from(schema.llmJobs).all().find((j) => j.id === id)!;
  expect(job.status).toBe("failed");
  expect(job.error).toContain("pool_exhausted");
  expect(record).not.toHaveBeenCalled();
  const draft = modelAvailability(ctx, OWNER).models.find((m) => m.purpose === "draft")!;
  expect(draft.state).toBe("waiting");
  expect(draft.retryAt! - before).toBeGreaterThanOrEqual(119_000);
});

it("treats the gateway as the house model when no free Gemini keys are configured", () => {
  expect(getSettingsView(ctx, OWNER).llm.credentialsConfigured).toBe(true);
  expect(modelAvailability(ctx, OWNER).mode).toBe("shared");
});

it("refuses a non-Gemini model name on the house path before calling the gateway", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(runLlm({ provider: "gemini", model: "gpt-5" }, prompt, "judge", undefined, undefined, new AbortController().signal, { gateway: GATEWAY })).rejects.toThrow("gemini-");
  expect(fetchMock).not.toHaveBeenCalled();
  // 작업으로 돌려도 요청이 없었으므로 사용량 이벤트를 남기지 않는다.
  updateSettings(ctx, OWNER, { llm: { provider: "gemini", model: "gpt-5", draftModel: "gpt-5" } });
  queueStep(ctx, OWNER, "draft", cid, "x", "en");
  await processServerJob(ctx);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
});

it("reads an HTTP-date Retry-After, defaults a bare 429 to a minute, and never self-reports gateway failures", async () => {
  const until = new Date(Date.now() + 300_000).toUTCString();
  vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":{"code":"gateway_busy"}}', { status: 429, headers: { "Retry-After": until } })));
  const e1 = await runLlm({ provider: "gemini" }, prompt, "judge", undefined, undefined, new AbortController().signal, { gateway: GATEWAY }).catch((e) => e);
  expect(Math.abs(e1.retryAt - Date.parse(until))).toBeLessThan(1000);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 429 })));
  const e2 = await runLlm({ provider: "gemini" }, prompt, "judge", undefined, undefined, new AbortController().signal, { gateway: GATEWAY }).catch((e) => e);
  expect(e2.retryAt - Date.now()).toBeGreaterThan(50_000);
  // 게이트웨이가 답했지만 내용이 JSON이 아닌 경우, 네트워크 오류도 reported로 표시된다.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), { status: 200 })));
  const e3 = await runLlm({ provider: "gemini" }, prompt, "judge", undefined, undefined, new AbortController().signal, { gateway: GATEWAY }).catch((e) => e);
  expect(e3.reported).toBe(true);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
  const e4 = await runLlm({ provider: "gemini" }, prompt, "judge", undefined, undefined, new AbortController().signal, { gateway: GATEWAY }).catch((e) => e);
  expect(e4.reported).toBe(true);
});
