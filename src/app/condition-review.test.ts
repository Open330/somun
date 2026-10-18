import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openDb, schema } from "../infra/db/index.js";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import type { AppContext } from "./context.js";
import { confirmDraftConditions, currentConditionReview } from "./condition-review.js";
import { getCandidateDetail } from "./candidates.js";
import { saveDraftEdit } from "./review.js";

let ctx: AppContext, cid: number, did: number;
const owner = "me";
const original = "Records speech and creates summaries.";
const material = "Cross-device sync, when enabled, uses personal iCloud.\n\nUntil StoreKit proves a product is actually purchasable, nothing is locked.";
const row = () => ctx.db.select().from(schema.drafts).where(eq(schema.drafts.id, did)).get()!;
const state = () => currentConditionReview(ctx, owner, row());
const copy = (body = row().body, copyIfClean?: boolean) => saveDraftEdit(ctx, owner, did, { title: row().title ?? undefined, body, markCopied: true, copyIfClean });
beforeEach(() => {
  ctx = { db: openDb(":memory:"), env: {}, log: pino({ level: "silent" }), bus: new EventEmitter(), usage: { record() {} } as unknown as AppContext["usage"] };
  cid = Number(ctx.db.insert(schema.candidates).values({ ownerId: owner, repo: "a/recorder", title: "Recorder", type: "release", key: "test", evidence: { repo: "a/recorder", repoUrl: "https://github.com/a/recorder", readmeForChecks: material }, status: "drafted", createdAt: 1, updatedAt: 1 }).run().lastInsertRowid);
  did = Number(ctx.db.insert(schema.drafts).values({ ownerId: owner, candidateId: cid, channel: "threads", lang: "en", version: 1, body: original, lint: [], status: "proposed", model: "test", createdAt: 1, updatedAt: 1 }).run().lastInsertRowid);
});
afterEach(() => ctx.db.$client.close());

it.each([undefined, false, true])("holds unconfirmed copy regardless of copyIfClean=%s, with no copy or learning side effects", (copyIfClean) => {
  expect(state().required).toBe(true);
  expect(state().sources[0].excerpts.join(" ")).toContain("when enabled");
  expect(state().sources[0].excerpts.join(" ")).toContain("nothing is locked");
  const result = copy(original, copyIfClean);
  expect(result.copyHeld).toBe(true);
  expect(row().status).toBe("proposed");
  expect(row().copiedAt).toBeNull();
  expect(ctx.db.select().from(schema.examples).all()).toEqual([]);
  expect(ctx.db.select().from(schema.llmJobs).all()).toEqual([]);
});

it("permits copy after a server-bound user confirmation without certifying the text", () => {
  const review = confirmDraftConditions(ctx, owner, did, state().revision, "authenticated-account");
  expect(review.confirmedAt).toBeTypeOf("number");
  expect(row().conditionReview?.reviewedBy).toBe("authenticated-account");
  expect(copy(original, true).copyHeld).toBeUndefined();
  expect(row().status).toBe("copied");
  expect(getCandidateDetail(ctx, owner, cid).drafts[0].conditionReview?.confirmedAt).toBe(review.confirmedAt);
});

it("holds edits, invalidates confirmation even after text is restored, and does not learn the held edit", () => {
  const before = state().revision;
  confirmDraftConditions(ctx, owner, did, before);
  expect(copy("Audio is recorded locally.", false).copyHeld).toBe(true);
  expect(row().conditionReview).toBeNull();
  expect(row().copiedAt).toBeNull();
  expect(ctx.db.select().from(schema.examples).all()).toEqual([]);
  expect(ctx.db.select().from(schema.llmJobs).all()).toEqual([]);
  saveDraftEdit(ctx, owner, did, { body: original, markCopied: false });
  expect(state().revision).toBe(before);
  expect(state().confirmedAt).toBeUndefined();
  expect(copy().copyHeld).toBe(true);
  confirmDraftConditions(ctx, owner, did, state().revision);
  expect(copy().copyHeld).toBeUndefined();
});

it("invalidates a title edit and rejects an old confirmation from another tab", () => {
  const old = state().revision;
  confirmDraftConditions(ctx, owner, did, old);
  saveDraftEdit(ctx, owner, did, { title: "New title", body: original, markCopied: false });
  expect(() => confirmDraftConditions(ctx, owner, did, old)).toThrow(/바뀌|changed/);
  expect(copy().copyHeld).toBe(true);
});

it("invalidates changed source text outside the extracted condition and effective profile changes", () => {
  const old = state().revision;
  confirmDraftConditions(ctx, owner, did, old);
  ctx.db.update(schema.candidates).set({ evidence: { repo: "a/recorder", repoUrl: "https://github.com/a/recorder", readmeForChecks: `${material}\n\nThe output now contains tasks.` } }).run();
  expect(state().revision).not.toBe(old);
  expect(copy().copyHeld).toBe(true);
  expect(() => confirmDraftConditions(ctx, owner, did, old)).toThrow();
  confirmDraftConditions(ctx, owner, did, state().revision);
  ctx.db.insert(schema.repoProfiles).values({ ownerId: owner, repo: "a/recorder", readmeHash: "fixed", profile: { what: "Recorder", audience: "Users", claims: [], stage: "beta", limitations: ["Requires setup"], naming: "Recorder", avoid: [] }, model: "test", createdAt: 1, updatedAt: 1 }).run();
  expect(state().confirmedAt).toBeUndefined();
  expect(copy().copyHeld).toBe(true);
});

it("also holds previously copied drafts without overwriting their historical copy time", () => {
  ctx.db.update(schema.drafts).set({ status: "copied", copiedAt: 10 }).run();
  expect(copy(original, false)).toMatchObject({ status: "copied", copyHeld: true });
  expect(row().copiedAt).toBe(10);
  expect(ctx.db.select().from(schema.examples).all()).toEqual([]);
});

it("does not invalidate on unrelated source metrics and retains the plain no-candidate path", () => {
  confirmDraftConditions(ctx, owner, did, state().revision);
  ctx.db.update(schema.candidates).set({ evidence: { repo: "a/recorder", repoUrl: "https://github.com/a/recorder", readmeForChecks: material, stars: 5 } }).run();
  expect(state().confirmedAt).toBeTypeOf("number");
  ctx.db.update(schema.candidates).set({ evidence: { repo: "a/recorder", repoUrl: "https://github.com/a/recorder", readmeForChecks: "Records speech and creates summaries." } }).run();
  expect(state().required).toBe(false);
  expect(copy(original, true).copyHeld).toBeUndefined();
});

it("requires review for incomplete PRs and protects confirmation ownership and server actor fields", async () => {
  ctx.db.update(schema.candidates).set({ evidence: { repo: "a/recorder", repoUrl: "https://github.com/a/recorder", mergedPrDetails: [{ number: 3, title: "Change", body: "", url: "https://github.com/a/recorder/pull/3", bodyTruncated: true }] } }).run();
  expect(state().required).toBe(true);
  const app = createApp(ctx, loadConfig({ SOMUN_TOKEN: "test", SOMUN_TOKEN_OWNER_ID: owner }));
  const foreign = createApp(ctx, loadConfig({ SOMUN_TOKEN: "test", SOMUN_TOKEN_OWNER_ID: "other" }));
  const params = { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify({ revision: state().revision, reviewedBy: "forged", reviewedAt: 1 }) };
  expect((await foreign.request(`/api/drafts/${did}/conditions/confirm`, params)).status).toBe(404);
  expect(row().conditionReview).toBeNull();
  expect((await app.request(`/api/drafts/${did}/conditions/confirm`, params)).status).toBe(200);
  expect(row().conditionReview?.reviewedBy).toBe(owner);
  expect(row().conditionReview?.reviewedAt).not.toBe(1);
});
