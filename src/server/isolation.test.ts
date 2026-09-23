import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../app/context.js";
import { openDb, schema } from "../infra/db/index.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

/**
 * 계정 간 격리. 같은 DB를 쓰는 두 소유자(alice, bob)가 각자 로그인한다.
 * bob은 alice의 id를 알아도 읽기·수정·실행 어느 것도 할 수 없어야 한다.
 */
describe("per-account isolation", () => {
  let ctx: AppContext;
  let bob: ReturnType<typeof createApp>;
  const ids = { candidate: 0, draft: 0, publication: 0, example: 0, source: 0, suggestion: 0, job: 0, installation: 4242 };

  beforeEach(() => {
    ctx = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: { githubToken: "server-pat", githubTokenOwners: ["alice"] }, bus: new EventEmitter(), usage: { record: vi.fn() } as unknown as AppContext["usage"] };
    bob = createApp(ctx, loadConfig({ SOMUN_TOKEN: "bob-token", SOMUN_TOKEN_OWNER_ID: "bob" }));
    const now = Date.now();
    const db = ctx.db;
    ids.candidate = Number(db.insert(schema.candidates).values({ ownerId: "alice", type: "release", title: "secret release", repo: "alice/private", key: "repo:alice/private:1", evidence: { repo: "alice/private", repoUrl: "https://github.com/alice/private", highlights: ["Private change."], highlightsAt: now }, status: "drafted", createdAt: now, updatedAt: now }).run().lastInsertRowid);
    ids.draft = Number(db.insert(schema.drafts).values({ ownerId: "alice", candidateId: ids.candidate, channel: "x", lang: "en", version: 1, body: "alice draft", lint: [], status: "proposed", model: "test", createdAt: now, updatedAt: now }).run().lastInsertRowid);
    ids.publication = Number(db.insert(schema.publications).values({ ownerId: "alice", candidateId: ids.candidate, draftId: ids.draft, channel: "x", url: "https://x.com/alice/status/1", publishedAt: now }).run().lastInsertRowid);
    ids.example = Number(db.insert(schema.examples).values({ ownerId: "alice", channel: "x", lang: "en", body: "alice example", source: "approved", active: true, createdAt: now }).run().lastInsertRowid);
    ids.source = Number(db.insert(schema.sources).values({ ownerId: "alice", kind: "github", targets: ["alice/private"], options: { installationId: String(ids.installation) }, enabled: true }).run().lastInsertRowid);
    ids.suggestion = Number(db.insert(schema.guideSuggestions).values({ ownerId: "alice", rule: "alice rule", normalized: "alice rule", category: "voice", sources: [], status: "pending", createdAt: now, updatedAt: now }).run().lastInsertRowid);
    ids.job = Number(db.insert(schema.llmJobs).values({ ownerId: "alice", kind: "draft", candidateId: ids.candidate, channel: "x", lang: "en", system: "s", user: "u", schemaJson: "{}", status: "failed", executor: "local", createdAt: now }).run().lastInsertRowid);
    db.insert(schema.githubInstallations).values({ installationId: ids.installation, ownerId: "alice", account: "alice", accountType: "User", repos: ["alice/private"], createdAt: now, updatedAt: now }).run();
  });
  afterEach(() => { ctx.db.$client.close(); vi.unstubAllGlobals(); });

  const call = (app: ReturnType<typeof createApp>, token: string, method: string, path: string, body?: unknown) =>
    app.request(`/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const asBob = (method: string, path: string, body?: unknown) => call(bob, "bob-token", method, path, body);

  it("hides every resource of another account from list endpoints", async () => {
    for (const path of ["/candidates", "/sources", "/publications", "/examples", "/suggestions", "/profiles", "/jobs/status", "/jobs/pending"]) {
      const res = await asBob("GET", path);
      expect(res.status, path).toBe(200);
      expect(await res.json(), path).toEqual([]);
    }
  });

  it("answers 404 to id-based reads and writes on another account's resources and changes nothing", async () => {
    const attempts: [string, string, unknown?][] = [
      ["GET", `/candidates/${ids.candidate}`],
      ["POST", `/candidates/${ids.candidate}/status`, { status: "dropped" }],
      ["POST", `/candidates/${ids.candidate}/override`, { decision: "drop", reason: "other" }],
      ["POST", `/candidates/${ids.candidate}/rejudge`],
      ["POST", `/candidates/${ids.candidate}/redraft`, { targets: [{ channel: "x", lang: "en" }] }],
      ["POST", "/candidates/judge", { ids: [ids.candidate] }],
      ["POST", `/drafts/${ids.draft}/edit`, { body: "bob was here", markCopied: true }],
      ["POST", `/drafts/${ids.draft}/drop`, { reason: "other" }],
      ["POST", `/publications/${ids.publication}/stats`, { likes: 999 }],
      ["PATCH", `/publications/${ids.publication}`, { url: "https://x.com/bob/status/2" }],
      ["DELETE", `/publications/${ids.publication}`],
      ["POST", `/examples/${ids.example}/active`, { active: false }],
      ["DELETE", `/examples/${ids.example}`],
      ["DELETE", `/sources/${ids.source}`],
      ["POST", "/sources", { id: ids.source, kind: "github", targets: ["bob/x"], enabled: true }],
      ["POST", `/suggestions/${ids.suggestion}/accept`],
      ["POST", `/suggestions/${ids.suggestion}/dismiss`],
      ["POST", `/jobs/${ids.job}/retry`],
      ["POST", `/jobs/${ids.job}/complete`, { claimToken: "00000000-0000-4000-8000-000000000000", resultJson: "{}" }],
      ["GET", `/jobs/status?candidateId=${ids.candidate}`],
      ["GET", `/github/installations/${ids.installation}/repos`],
      ["POST", `/github/installations/${ids.installation}/watch`, { repos: ["alice/private"] }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await asBob(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // 주인의 데이터는 그대로.
    const db = ctx.db;
    expect(db.select().from(schema.candidates).get()?.status).toBe("drafted");
    expect(db.select().from(schema.drafts).get()).toMatchObject({ body: "alice draft", status: "proposed" });
    expect(db.select().from(schema.publications).get()).toMatchObject({ url: "https://x.com/alice/status/1", manualStats: null });
    expect(db.select().from(schema.examples).get()?.active).toBe(true);
    expect(db.select().from(schema.sources).get()?.targets).toEqual(["alice/private"]);
    expect(db.select().from(schema.guideSuggestions).get()?.status).toBe("pending");
    expect(db.select().from(schema.llmJobs).all()).toHaveLength(1);
  });

  it("claims no job of another account", async () => {
    ctx.db.update(schema.llmJobs).set({ status: "pending" }).run();
    const res = await asBob("POST", `/jobs/${ids.job}/claim`, { runner: "bob" });
    expect(await res.json()).toEqual({ claimed: false });
    expect(ctx.db.select().from(schema.llmJobs).get()?.status).toBe("pending");
  });

  it("does not let another account point a source at someone else's GitHub installation", async () => {
    const res = await asBob("POST", "/sources", { kind: "github", targets: ["alice/private"], options: { installationId: String(ids.installation) }, enabled: true });
    expect(res.status).toBe(404);
    expect(ctx.db.select().from(schema.sources).all()).toHaveLength(1);
  });

  it("does not let a publication borrow another account's draft", async () => {
    const now = Date.now();
    const bobCandidate = Number(ctx.db.insert(schema.candidates).values({ ownerId: "bob", type: "release", title: "bob", repo: "bob/x", key: "k", evidence: { repo: "bob/x", repoUrl: "https://github.com/bob/x" }, status: "drafted", createdAt: now, updatedAt: now }).run().lastInsertRowid);
    const res = await asBob("POST", "/publications", { candidateId: bobCandidate, draftId: ids.draft, channel: "x", url: "https://x.com/bob/status/3" });
    expect(res.status).toBe(404);
    expect(ctx.db.select().from(schema.drafts).get()?.status).toBe("proposed");
  });

  it("reads only public repositories with the server token for accounts outside the allow list", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/repos/alice/private")) return new Response(JSON.stringify({ full_name: "alice/private", private: true }), { status: 200 });
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await asBob("POST", "/profiles/alice/private/regenerate");
    expect(res.status).toBe(404);
    expect(fetchMock.mock.calls.map(([u]) => String(u)).some((u) => u.includes("/readme"))).toBe(false);
  });
});
