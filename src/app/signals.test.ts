import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { openDb, schema } from "../infra/db/index.js";
import type { Evidence } from "../shared/types.js";
import type { AppContext } from "./context.js";
import { migrateLegacyCandidates } from "./candidates.js";
import { ingestSignals } from "./signals.js";

const DAY = 86400e3;
function makeCtx(): AppContext {
  const db = openDb(":memory:");
  return { db, log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: { record() {} } as unknown as AppContext["usage"] };
}
const ev = (repo: string): Evidence => ({ repo, repoUrl: `https://github.com/${repo}`, stars: 30 });

describe("repo-window candidates", () => {
  it("folds release, milestones and PRs of one repo into a single candidate", () => {
    const ctx = makeCtx();
    const now = Date.now();
    ctx.db.insert(schema.sources).values({ ownerId: "o", kind: "github", targets: ["a/x"], enabled: true }).run();
    ingestSignals(ctx, "o", 1, [
      { kind: "star_milestone", repo: "a/x", ref: "gh:stars:a/x#25", title: "a/x stars 25", payload: { threshold: 25 }, occurredAt: now },
      { kind: "release", repo: "a/x", ref: "gh:release:a/x@v1.2.0", title: "a/x v1.2.0", payload: { tag: "v1.2.0" }, occurredAt: now },
      { kind: "download_milestone", repo: "a/x", ref: "npm:dl:x#100", title: "x 100", payload: { threshold: 100 }, occurredAt: now },
    ], {}, ev("a/x"));
    const rows = ctx.db.select().from(schema.candidates).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("release");
    expect(rows[0].title).toBe("a/x v1.2.0");
    expect(rows[0].key.startsWith("repo:a/x:")).toBe(true);
    const e = rows[0].evidence as Evidence;
    expect(e.milestones?.map((m) => `${m.metric}-${m.threshold}`)).toEqual(["stars-25", "downloads-100"]);
  });

  it("opens a new window after 10 days", () => {
    const ctx = makeCtx();
    const now = Date.now();
    ctx.db.insert(schema.sources).values({ ownerId: "o", kind: "github", targets: ["a/x"], enabled: true }).run();
    ingestSignals(ctx, "o", 1, [{ kind: "release", repo: "a/x", ref: "r1", title: "a/x v1", payload: { tag: "v1" }, occurredAt: now }], {}, ev("a/x"));
    ctx.db.update(schema.candidates).set({ createdAt: now - 11 * DAY }).run();
    ingestSignals(ctx, "o", 1, [{ kind: "release", repo: "a/x", ref: "r2", title: "a/x v2", payload: { tag: "v2" }, occurredAt: now }], {}, ev("a/x"));
    expect(ctx.db.select().from(schema.candidates).all()).toHaveLength(2);
  });
});

describe("migrateLegacyCandidates", () => {
  it("merges same-repo legacy candidates within 10 days and keeps drafts", () => {
    const ctx = makeCtx();
    const now = Date.now();
    const ins = (type: string, key: string, createdAt: number, hl?: string[]) => Number(ctx.db.insert(schema.candidates).values({ ownerId: "o", type, title: key, repo: "a/x", key, evidence: { ...ev("a/x"), highlights: hl, highlightsAt: hl ? now : undefined } as Record<string, unknown>, status: "judged", createdAt, updatedAt: createdAt }).run().lastInsertRowid);
    const rel = ins("release", "release:a/x@v1", now - DAY, ["Adds RAG"]);
    const ms = ins("milestone", "milestone:a/x#stars-25", now, ["Adds RAG again"]);
    const old = ins("milestone", "milestone:a/x#stars-10", now - 20 * DAY);
    ctx.db.insert(schema.drafts).values({ ownerId: "o", candidateId: ms, channel: "x", lang: "ko", version: 1, body: "b", lint: [], status: "proposed", model: "m", createdAt: now, updatedAt: now }).run();
    const r = migrateLegacyCandidates(ctx);
    expect(r.merged).toBe(1);
    const rows = ctx.db.select().from(schema.candidates).all();
    expect(rows).toHaveLength(2);
    const keeper = rows.find((c) => c.id !== old)!;
    expect(keeper.id).toBe(ms); // 초안이 있는 쪽이 남는다
    expect(keeper.type).toBe("release"); // 가장 강한 종류로
    expect((keeper.evidence as Evidence).milestones?.[0]).toMatchObject({ metric: "stars", threshold: 25 });
    expect(ctx.db.select().from(schema.drafts).all()[0].candidateId).toBe(ms);
    expect(rows.every((c) => c.key.startsWith("repo:"))).toBe(true);
    expect(ctx.db.select().from(schema.candidates).where(undefined).all().find((c) => c.id === rel)).toBeUndefined();
    // 두 번째 실행은 아무것도 하지 않는다
    expect(migrateLegacyCandidates(ctx)).toEqual({ merged: 0, renamed: 0 });
  });
});
