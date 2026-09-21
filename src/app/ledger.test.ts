import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { openDb, schema } from "../infra/db/index.js";
import type { AppContext } from "./context.js";
import { alreadyPublished, alreadyTold, markPublished, recordHighlights, similar, normalizeText } from "./ledger.js";

function makeCtx(): AppContext {
  return { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: { record() {} } as unknown as AppContext["usage"] };
}

describe("change ledger", () => {
  it("treats rephrased highlights as the same change", () => {
    expect(similar(normalizeText("Users can perform semantic search across the entire wiki using the new Ask-the-Wiki RAG feature."), normalizeText("Users can query the entire wiki using semantic search and RAG through the new Ask-the-Wiki feature."))).toBe(true);
    expect(similar(normalizeText("Figures are extracted from PDFs with captions."), normalizeText("A cost preview shows tokens before the add command."))).toBe(false);
  });
  it("records once, excludes own candidate, marks published", () => {
    const ctx = makeCtx();
    expect(recordHighlights(ctx, "o", "a/x", 1, ["Adds full-wiki RAG search.", "Adds cost preview before add."])).toBe(2);
    expect(recordHighlights(ctx, "o", "a/x", 2, ["Adds full wiki RAG search", "Incremental re-ingestion skips unchanged docs."])).toBe(1);
    expect(alreadyTold(ctx, "o", "a/x", { excludeCandidateId: 2 }).map((t) => t.text)).toEqual(["Adds cost preview before add."]);
    expect(markPublished(ctx, "o", 2, "x")).toBe(2);
    expect(alreadyPublished(ctx, "o", "a/x").length).toBe(2);
    expect(ctx.db.select().from(schema.changeLedger).all()).toHaveLength(3);
  });
});
