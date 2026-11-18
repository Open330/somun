import { EventEmitter } from "node:events";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { openDb, schema } from "../infra/db/index.js";
import type { AppContext } from "./context.js";
import { listProducts } from "./products.js";

const EMPTY = { what: "", audience: "", why: "", claims: [], stage: "stable", limitations: [], naming: "", avoid: [], unreleased: [] };

function setup() {
  const ctx: AppContext = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: { record() {} } as unknown as AppContext["usage"] };
  const now = Date.now();
  const profile = (ownerId: string, repo: string, profile: Record<string, unknown>, edits: Record<string, unknown> | null = null) =>
    ctx.db.insert(schema.repoProfiles).values({ ownerId, repo, readmeHash: "h", profile: { ...EMPTY, ...profile }, edits, model: "m", generatedAt: now, createdAt: now, updatedAt: now }).run();
  const candidate = (ownerId: string, repo: string, evidence: Record<string, unknown>, key: string) =>
    Number(ctx.db.insert(schema.candidates).values({ ownerId, type: "release", title: repo, repo, key, evidence: { repo, repoUrl: `https://github.com/${repo}`, ...evidence }, status: "new", createdAt: now, updatedAt: now }).run().lastInsertRowid);
  return { ctx, now, profile, candidate };
}

describe("listProducts", () => {
  it("lists each profiled repository with approved lines, the latest collected values, last post and status", () => {
    const { ctx, now, profile, candidate } = setup();
    profile("me", "o/tend", { naming: "Tend" }, { oneLinerKo: "Tend는 세션을 지켜봅니다.", oneLinerEn: "Tend watches sessions." });
    profile("me", "o/aas", {}, { oneLinerKo: "aas는 계정을 바꿉니다." });
    profile("me", "o/old", { stage: "archived" });
    profile("other", "x/secret", { naming: "Secret" });
    candidate("me", "o/tend", { stars: 10, homepage: "https://old.example/" }, "a");
    const latest = candidate("me", "o/tend", { stars: 42, homepage: "https://tend.example/" }, "b");
    ctx.db.insert(schema.publications).values({ ownerId: "me", candidateId: latest, channel: "x", url: "https://x.com/me/status/1", publishedAt: now - 1000 }).run();

    const rows = listProducts(ctx, "me");
    expect(rows.map((r) => [r.name, r.status])).toEqual([["aas", "needs_line"], ["Tend", "ready"], ["old", "hold"]]);
    expect(rows.find((r) => r.repo === "o/tend")).toMatchObject({ stars: 42, homepage: "https://tend.example/", candidateId: latest, lastPublishedAt: now - 1000, oneLinerEn: "Tend watches sessions." });
    expect(rows.find((r) => r.repo === "o/aas")).toMatchObject({ oneLinerKo: "aas는 계정을 바꿉니다.", oneLinerEn: undefined, candidateId: undefined, lastPublishedAt: undefined });
    expect(rows.some((r) => r.repo === "x/secret")).toBe(false);
  });

  it("picks the most recently created candidate, not the highest id, and skips non-numeric stars", () => {
    const { ctx, profile } = setup();
    profile("me", "o/tool", {}, {});
    const now = Date.now();
    const newer = Number(ctx.db.insert(schema.candidates).values({ ownerId: "me", type: "release", title: "t", repo: "o/tool", key: "a", evidence: { repo: "o/tool", repoUrl: "u", stars: 42 }, status: "new", createdAt: now + 200, updatedAt: now }).run().lastInsertRowid);
    ctx.db.insert(schema.candidates).values({ ownerId: "me", type: "release", title: "t", repo: "o/tool", key: "b", evidence: { repo: "o/tool", repoUrl: "u", stars: 10 }, status: "new", createdAt: now + 100, updatedAt: now }).run();
    expect(listProducts(ctx, "me")[0]).toMatchObject({ candidateId: newer, stars: 42 });
  });

  it("reads only the latest row's fields and groups publications once, fast with a long history", () => {
    const { ctx, profile, candidate } = setup();
    for (let i = 0; i < 300; i++) profile("me", `o/p${i}`, {}, {});
    const big = "x".repeat(50_000);
    for (let i = 0; i < 1000; i++) candidate("me", "o/p0", { stars: i, readmeForChecks: big }, `k${i}`);
    const start = performance.now();
    expect(listProducts(ctx, "me")).toHaveLength(300);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("treats blank approved lines as missing", () => {
    const { ctx, profile } = setup();
    profile("me", "o/tool", {}, { oneLinerKo: "  ", oneLinerEn: "Tool saves records." });
    expect(listProducts(ctx, "me")[0]).toMatchObject({ status: "needs_line", oneLinerKo: undefined });
  });
});
