import { expect, it } from "vitest";
import { openDb, schema } from "../infra/db/index.js";
import { exportHoldout } from "./holdout.js";
import { casesSchema, configSchema, validatePlan } from "./drafts.js";

it("turns copied drafts with a digest into replayable held-out cases", () => {
  const db = openDb(":memory:");
  try {
    const now = Date.now();
    const cand = (evidence: Record<string, unknown>) => Number(db.insert(schema.candidates).values({ ownerId: "me", type: "release", title: "tool v2", repo: "me/tool", key: `k${Math.random()}`, evidence, status: "published", createdAt: now, updatedAt: now }).run().lastInsertRowid);
    const withDigest = cand({ repo: "me/tool", repoUrl: "https://github.com/me/tool", highlights: ["Adds --watch."], unverifiedHighlights: [{ text: "x", numbers: ["3x"] }], commitSubjects: ["wip"] });
    const noDigest = cand({ repo: "me/tool", repoUrl: "https://github.com/me/tool" });
    const draft = (candidateId: number, status: string, body: string) => db.insert(schema.drafts).values({ ownerId: "me", candidateId, channel: "x", lang: "ko", version: 1, body, lint: [], status, model: "m", createdAt: now, updatedAt: now }).run();
    draft(withDigest, "copied", "--watch 추가. https://github.com/me/tool");
    draft(withDigest, "proposed", "not copied");
    draft(noDigest, "copied", "no digest");
    db.insert(schema.drafts).values({ ownerId: "other", candidateId: withDigest, channel: "x", lang: "en", version: 1, body: "other owner", lint: [], status: "copied", model: "m", createdAt: now, updatedAt: now }).run();

    const { cases, config, skipped } = exportHoldout(db, "me");
    expect(skipped).toBe(1);
    expect(cases).toHaveLength(1);
    expect(cases[0].candidate.evidence).not.toHaveProperty("unverifiedHighlights");
    expect(cases[0].candidate.evidence).not.toHaveProperty("commitSubjects");
    expect(config.variants[0].replay?.[cases[0].id]).toEqual({ title: "", body: "--watch 추가. https://github.com/me/tool" });
    expect(() => casesSchema.parse(cases)).not.toThrow();
    expect(validatePlan(configSchema.parse(config), cases, "replay", 0)).toBe(1);
  } finally { db.$client.close(); }
});
