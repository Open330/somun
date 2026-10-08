import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, schema } from "../infra/db/index.js";
import { GenerationConflictError, type AppContext } from "./context.js";
import { claimJob, completeJob, generationStatus, pendingJobs, retryGeneration } from "./jobs.js";
import { learningStats } from "./learning-stats.js";
import { acceptSuggestion, applyLesson, GUIDE_MAX_LINES, listSuggestions, tagLegacySuggestions } from "./learning.js";
import { dropDraft, OWN_EXAMPLE_CAP, saveDraftEdit } from "./review.js";
import { getSettingsView, updateSettings } from "./settings.js";
import { editProfile, ensureProfile, getProfile, regenerateProfile } from "./profiles.js";
import { buildPrompt, examplesFor, processNewCandidates } from "./pipeline.js";

let ctx: AppContext;
let candidateId: number;
const OWNER = "me";

function draft(body: string, channel = "x", lang = "en") {
  const now = Date.now();
  return Number(ctx.db.insert(schema.drafts).values({ ownerId: OWNER, candidateId, channel, lang, version: 1, body, lint: [], status: "proposed", model: "test", createdAt: now, updatedAt: now }).run().lastInsertRowid);
}
const examples = () => ctx.db.select().from(schema.examples).all();
const lessons = () => ctx.db.select().from(schema.llmJobs).all().filter((j) => j.kind === "lesson");

beforeEach(() => {
  ctx = { db: openDb(":memory:"), log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: { record: vi.fn() } as unknown as AppContext["usage"] };
  const now = Date.now();
  candidateId = Number(ctx.db.insert(schema.candidates).values({ ownerId: OWNER, type: "release", title: "tool v1", repo: "me/tool", key: "k", evidence: { repo: "me/tool", repoUrl: "https://github.com/me/tool" }, status: "drafted", createdAt: now, updatedAt: now }).run().lastInsertRowid);
});
afterEach(() => ctx.db.$client.close());

describe("voice examples come only from copied drafts", () => {
  it("does not turn an edit that was never copied into an example, but queues a lesson", () => {
    const id = draft("Original text https://github.com/me/tool");
    saveDraftEdit(ctx, OWNER, id, { body: "Edited text https://github.com/me/tool", markCopied: false });
    expect(examples()).toHaveLength(0);
    expect(lessons()).toMatchObject([{ draftId: id, executor: "server", status: "pending" }]);
    expect(ctx.db.select().from(schema.draftEdits).all()).toHaveLength(1);
  });

  it("keeps one example per copied draft and marks it as edited", () => {
    const id = draft("Original text https://github.com/me/tool");
    saveDraftEdit(ctx, OWNER, id, { body: "Edited text https://github.com/me/tool", markCopied: false });
    saveDraftEdit(ctx, OWNER, id, { body: "Edited text https://github.com/me/tool", markCopied: true });
    saveDraftEdit(ctx, OWNER, id, { body: "Edited again https://github.com/me/tool", markCopied: true });
    expect(examples()).toMatchObject([{ draftId: id, source: "edited", body: "Edited again https://github.com/me/tool", active: true }]);
  });

  it("marks a draft copied without edits as approved", () => {
    const id = draft("Plain text https://github.com/me/tool");
    saveDraftEdit(ctx, OWNER, id, { body: "Plain text https://github.com/me/tool", markCopied: true });
    expect(examples()).toMatchObject([{ source: "approved" }]);
    expect(lessons()).toHaveLength(0);
  });

  it("does not learn voice from a copied draft that breaks the basic rules", () => {
    const id = draft("Excited to announce 🚀 https://github.com/me/tool");
    saveDraftEdit(ctx, OWNER, id, { body: "Excited to announce 🚀 https://github.com/me/tool", markCopied: true });
    expect(examples()).toHaveLength(0);
  });

  it("keeps only the most recent own examples active per channel", () => {
    for (let i = 0; i < OWN_EXAMPLE_CAP + 2; i++) { const id = draft(`Post ${String.fromCharCode(65 + i)} https://github.com/me/tool`); saveDraftEdit(ctx, OWNER, id, { body: `Post ${String.fromCharCode(65 + i)} https://github.com/me/tool`, markCopied: true }); }
    expect(examples().filter((e) => e.active)).toHaveLength(OWN_EXAMPLE_CAP);
  });

  it("prefers the author's own examples once there are two, and ranks unedited copies after seeds", () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) ctx.db.insert(schema.examples).values({ ownerId: OWNER, channel: "x", lang: "en", body: `seed ${i}`, source: "seed", active: true, createdAt: now - 1000 }).run();
    const a = draft("Mine A https://github.com/me/tool");
    saveDraftEdit(ctx, OWNER, a, { body: "Mine A https://github.com/me/tool", markCopied: true });
    // 고치지 않고 복사한 초안은 모델 출력이다. 참고 예시 뒤로 밀리고 작성자 글로 세지 않는다.
    expect(examplesFor(ctx, OWNER, "x", "en", 4).map((e) => e.source)).toEqual(["seed", "seed", "seed", "accepted"]);
    const b = draft("Mine B https://github.com/me/tool");
    saveDraftEdit(ctx, OWNER, b, { body: "Mine B, rewritten https://github.com/me/tool", markCopied: true });
    expect(examplesFor(ctx, OWNER, "x", "en", 4).map((e) => e.source)).toEqual(["authored", "seed", "seed", "seed"]);
    const c = draft("Mine C https://github.com/me/tool");
    saveDraftEdit(ctx, OWNER, c, { body: "Mine C, in my words https://github.com/me/tool", markCopied: true });
    expect(examplesFor(ctx, OWNER, "x", "en", 4).map((e) => e.source)).toEqual(["authored", "authored"]);
    // 직접 써서 넣은 예시는 작성자 글이다.
    ctx.db.insert(schema.examples).values({ ownerId: OWNER, channel: "x", lang: "en", body: "hand written", source: "approved", active: true, createdAt: now + 10_000 }).run();
    expect(examplesFor(ctx, OWNER, "x", "en", 4).map((e) => e.body)).toEqual(["hand written", "Mine C, in my words https://github.com/me/tool", "Mine B, rewritten https://github.com/me/tool"]);
  });
});

describe("lessons run on the same executor as generation", () => {
  it("keeps lessons on the local worker in local-agent mode and hides them from generation status", () => {
    updateSettings(ctx, OWNER, { llm: { provider: "local-agent" } });
    const id = draft("Original https://github.com/me/tool");
    dropDraft(ctx, OWNER, id, "voice", "too formal");
    expect(lessons()).toMatchObject([{ executor: "local" }]);
    expect(pendingJobs(ctx, OWNER).map((j) => j.kind)).toEqual(["lesson"]);
    expect(generationStatus(ctx, OWNER)).toEqual([]);
  });

  it("applies a lesson result as a guide suggestion even after the candidate was published", () => {
    updateSettings(ctx, OWNER, { llm: { provider: "local-agent" } });
    const id = draft("Original https://github.com/me/tool");
    saveDraftEdit(ctx, OWNER, id, { body: "Shorter https://github.com/me/tool", markCopied: true });
    ctx.db.update(schema.candidates).set({ status: "published" }).run();
    const job = lessons()[0];
    const { claimToken } = claimJob(ctx, OWNER, job.id, "test");
    expect(completeJob(ctx, OWNER, job.id, { claimToken: claimToken!, resultJson: JSON.stringify({ rule: "Keep posts under three sentences.", category: "length" }) })).toEqual({ applied: true });
    expect(ctx.db.select().from(schema.guideSuggestions).all()).toMatchObject([{ rule: "Keep posts under three sentences.", sources: [{ kind: "edit", draftId: id }] }]);
  });

  it("refuses to grow the guide past its line limit", () => {
    const now = Date.now();
    updateSettings(ctx, OWNER, { voice: { preset: "plain", guide: Array.from({ length: GUIDE_MAX_LINES }, (_, i) => `rule ${i}`).join("\n"), useExamples: true } });
    const sid = Number(ctx.db.insert(schema.guideSuggestions).values({ ownerId: OWNER, rule: "one more", normalized: "one more", category: "voice", sources: [], status: "pending", createdAt: now, updatedAt: now }).run().lastInsertRowid);
    expect(() => acceptSuggestion(ctx, OWNER, sid)).toThrow(/정리한 뒤/);
  });
});

it("refuses to overwrite a draft that another tab saved after this edit began", () => {
  const id = draft("Original text");
  saveDraftEdit(ctx, OWNER, id, { body: "Tab A text", markCopied: false, base: { body: "Original text" } });
  expect(() => saveDraftEdit(ctx, OWNER, id, { body: "Tab B text", markCopied: true, base: { body: "Original text" } })).toThrow(GenerationConflictError);
  const row = ctx.db.select().from(schema.drafts).all()[0];
  expect(row).toMatchObject({ body: "Tab A text", status: "edited" });
  expect(examples()).toHaveLength(0);
  expect(saveDraftEdit(ctx, OWNER, id, { body: "Tab B text", markCopied: false }).body).toBe("Tab B text");
});

it("measures copied drafts: unchanged rate and how much was rewritten", () => {
  const same = draft("one two three four https://x.y");
  saveDraftEdit(ctx, OWNER, same, { body: "one two three four https://x.y", markCopied: true });
  const edited = draft("one two three four https://x.y");
  saveDraftEdit(ctx, OWNER, edited, { body: "one two six four https://x.y", markCopied: false });
  saveDraftEdit(ctx, OWNER, edited, { body: "one two six four https://x.y", markCopied: true });
  draft("never copied");
  const stats = learningStats(ctx, OWNER);
  expect(stats).toMatchObject({ copied: 2, unchangedRate: 0.5, avgEditRatio: 0.2 });
  expect(stats.byChannel).toMatchObject([{ channel: "x", copied: 2 }]);
  expect(stats.byWeek.reduce((n, w) => n + w.copied, 0)).toBe(2);
});

it("stores the rewrite share on the draft when it is copied", () => {
  const id = draft("one two three four");
  saveDraftEdit(ctx, OWNER, id, { body: "one two six four", markCopied: false });
  expect(ctx.db.select().from(schema.drafts).get()?.editRatio).toBeNull();
  saveDraftEdit(ctx, OWNER, id, { body: "one two six seven", markCopied: true });
  expect(ctx.db.select().from(schema.drafts).get()?.editRatio).toBe(0.5);
});

it("accepts a suggestion that repeats an existing guide line even when the guide is full", () => {
  const now = Date.now();
  updateSettings(ctx, OWNER, { voice: { preset: "plain", guide: Array.from({ length: GUIDE_MAX_LINES }, (_, i) => `rule number ${i}`).join("\n"), useExamples: true } });
  const sid = Number(ctx.db.insert(schema.guideSuggestions).values({ ownerId: OWNER, rule: "rule number 3", normalized: "rule number 3", category: "voice", sources: [], status: "pending", createdAt: now, updatedAt: now }).run().lastInsertRowid);
  acceptSuggestion(ctx, OWNER, sid);
  expect(ctx.db.select().from(schema.guideSuggestions).get()?.status).toBe("accepted");
});

it("never retires examples the user added by hand", () => {
  const now = Date.now();
  ctx.db.insert(schema.examples).values({ ownerId: OWNER, channel: "x", lang: "en", body: "hand written", source: "approved", active: true, createdAt: now - 10_000 }).run();
  for (let i = 0; i < OWN_EXAMPLE_CAP + 1; i++) { const id = draft(`Post ${String.fromCharCode(65 + i)} https://github.com/me/tool`); saveDraftEdit(ctx, OWNER, id, { body: `Post ${String.fromCharCode(65 + i)} https://github.com/me/tool`, markCopied: true }); }
  expect(examples().find((e) => e.body === "hand written")?.active).toBe(true);
});

it("records whether a lesson came from an edit even if the draft is dropped before it runs, and retries lessons with their draft", () => {
  updateSettings(ctx, OWNER, { llm: { provider: "local-agent" } });
  const id = draft("Original https://github.com/me/tool");
  saveDraftEdit(ctx, OWNER, id, { body: "Edited https://github.com/me/tool", markCopied: false });
  dropDraft(ctx, OWNER, id, "voice");
  const [edit, drop] = lessons();
  expect([edit.lessonKind, drop.lessonKind]).toEqual(["edit", "drop"]);
  const first = claimJob(ctx, OWNER, edit.id, "t");
  completeJob(ctx, OWNER, edit.id, { claimToken: first.claimToken!, error: "quota" });
  ctx.db.update(schema.candidates).set({ status: "published" }).run();
  const retried = retryGeneration(ctx, OWNER, edit.id);
  const second = claimJob(ctx, OWNER, retried, "t");
  completeJob(ctx, OWNER, retried, { claimToken: second.claimToken!, resultJson: JSON.stringify({ rule: "Say it in one line.", category: "length" }) });
  expect(ctx.db.select().from(schema.guideSuggestions).get()?.sources).toMatchObject([{ kind: "edit", draftId: id }]);
});

it("fills in the rewrite share for drafts copied before it was stored", () => {
  const id = draft("a b c d");
  ctx.db.update(schema.drafts).set({ status: "copied", copiedAt: Date.now() }).run();
  expect(learningStats(ctx, OWNER).copied).toBe(1);
  expect(ctx.db.select().from(schema.drafts).get()?.editRatio).toBe(0);
  void id;
});

describe("repository profiles in local-agent mode", () => {
  const material = { repo: "me/tool", description: "A tool", readme: "# tool\nDoes things.", recentReleaseNotes: [], stars: 1 };
  it("queues the profile for the local worker instead of calling a server model, once per repository", async () => {
    updateSettings(ctx, OWNER, { llm: { provider: "local-agent" } });
    expect(await ensureProfile(ctx, OWNER, material)).toBe("queued");
    expect(await ensureProfile(ctx, OWNER, material)).toBe("kept");
    const jobs = ctx.db.select().from(schema.llmJobs).all();
    expect(jobs).toMatchObject([{ kind: "profile", executor: "local", meta: { repo: "me/tool" } }]);
    expect(jobs[0].user).toContain("Does things.");
    expect(generationStatus(ctx, OWNER)).toMatchObject([{ kind: "profile", repo: "me/tool", status: "pending", executor: "local" }]);
    expect(pendingJobs(ctx, OWNER).map((j) => j.kind)).toEqual(["profile"]);
  });

  it("saves the worker's profile under the README hash it was built from", async () => {
    updateSettings(ctx, OWNER, { llm: { provider: "local-agent" } });
    await ensureProfile(ctx, OWNER, material);
    const job = ctx.db.select().from(schema.llmJobs).get()!;
    const { claimToken } = claimJob(ctx, OWNER, job.id, "t");
    completeJob(ctx, OWNER, job.id, { claimToken: claimToken!, resultJson: JSON.stringify({ what: "A tool that does things", audience: "devs", claims: [], stage: "beta", limitations: [], naming: "tool", avoid: [] }), model: "claude" });
    expect(getProfile(ctx, OWNER, "me/tool")?.profile).toMatchObject({ what: "A tool that does things", stage: "beta" });
    expect(await ensureProfile(ctx, OWNER, material)).toBe("kept");
  });

  const complete = (id: number, profile: Record<string, unknown>) => { const { claimToken } = claimJob(ctx, OWNER, id, "t"); return completeJob(ctx, OWNER, id, { claimToken: claimToken!, resultJson: JSON.stringify(profile) }); };
  const P = (what: string) => ({ what, audience: "", claims: [], stage: "beta", limitations: [], naming: "", avoid: [] });

  it("does not let an older job overwrite a newer profile", async () => {
    updateSettings(ctx, OWNER, { llm: { provider: "local-agent" } });
    await ensureProfile(ctx, OWNER, material);
    const old = ctx.db.select().from(schema.llmJobs).get()!;
    ctx.db.insert(schema.repoProfiles).values({ ownerId: OWNER, repo: "me/tool", readmeHash: "newer", profile: P("newer"), model: "gemini", generatedAt: Date.now() + 1000, createdAt: Date.now() + 1000, updatedAt: Date.now() + 1000 }).run();
    expect(complete(old.id, P("older"))).toEqual({ applied: true });
    expect(getProfile(ctx, OWNER, "me/tool")?.profile.what).toBe("newer");
  });

  it("replaces a not-yet-started job when the README changes, and waits for one the worker already took", async () => {
    updateSettings(ctx, OWNER, { llm: { provider: "local-agent" } });
    await ensureProfile(ctx, OWNER, material);
    expect(await ensureProfile(ctx, OWNER, { ...material, readme: "# tool v2" })).toBe("queued");
    expect(ctx.db.select().from(schema.llmJobs).all().map((j) => j.status)).toEqual(["failed", "pending"]);
    claimJob(ctx, OWNER, 2, "t");
    expect(await regenerateProfile(ctx, OWNER, material)).toMatchObject({ queued: false, busy: true });
    expect(() => retryGeneration(ctx, OWNER, 1)).toThrow(/이미 대기 중/);
  });

  it("holds automatic digests for a repository until its profile arrives, then continues", async () => {
    updateSettings(ctx, OWNER, { llm: { provider: "local-agent" }, watch: { mode: "auto", recentDays: 30 } });
    ctx.db.update(schema.candidates).set({ status: "new", updatedAt: Date.now() }).run();
    await ensureProfile(ctx, OWNER, material);
    expect(await processNewCandidates(ctx)).toBe(0);
    complete(ctx.db.select().from(schema.llmJobs).get()!.id, P("A tool"));
    await vi.waitFor(() => expect(ctx.db.select().from(schema.llmJobs).all().some((j) => j.kind === "digest")).toBe(true));
    expect(ctx.db.select().from(schema.llmJobs).all().find((j) => j.kind === "digest")?.user).toContain("A tool");
  });

  it("still applies the worker's profile when the user edited a field while it was running", async () => {
    updateSettings(ctx, OWNER, { llm: { provider: "local-agent" } });
    await ensureProfile(ctx, OWNER, material);
    editProfile(ctx, OWNER, "me/tool", { audience: "my team" });
    complete(ctx.db.select().from(schema.llmJobs).get()!.id, P("from the worker"));
    expect(getProfile(ctx, OWNER, "me/tool")?.profile).toMatchObject({ what: "from the worker", audience: "my team" });
  });

  it("keeps the original request time on retry, so an old README cannot overwrite a newer profile", async () => {
    updateSettings(ctx, OWNER, { llm: { provider: "local-agent" } });
    await ensureProfile(ctx, OWNER, material);
    const first = ctx.db.select().from(schema.llmJobs).get()!;
    const { claimToken } = claimJob(ctx, OWNER, first.id, "t");
    completeJob(ctx, OWNER, first.id, { claimToken: claimToken!, error: "cli failed" });
    ctx.db.insert(schema.repoProfiles).values({ ownerId: OWNER, repo: "me/tool", readmeHash: "b", profile: P("from README B"), model: "gemini", generatedAt: Date.now() + 1000, createdAt: 1, updatedAt: 1 }).run();
    const retried = retryGeneration(ctx, OWNER, first.id);
    complete(retried, P("from README A"));
    expect(getProfile(ctx, OWNER, "me/tool")?.profile.what).toBe("from README B");
  });
});

describe("account language", () => {
  it("writes lint explanations, stored errors, and the judge's reasoning language in the account's language", () => {
    updateSettings(ctx, OWNER, { ui: { locale: "en" } });
    const id = draft("Now 3x faster https://github.com/me/tool");
    const saved = saveDraftEdit(ctx, OWNER, id, { body: "Now 3x faster https://github.com/me/tool", markCopied: false });
    expect(saved.lint.find((r) => r.rule === "numbers_need_review")).toMatchObject({ ok: false, detail: expect.stringContaining("Numbers not found"), args: { numbers: "3x" } });
    ctx.db.update(schema.candidates).set({ evidence: { repo: "me/tool", repoUrl: "https://github.com/me/tool", highlights: ["Adds a flag."], highlightsAt: 1 } }).run();
    expect(buildPrompt(ctx, OWNER, "judge", candidateId).system).toContain("sentences in English");
    updateSettings(ctx, OWNER, { ui: { locale: "ko" } });
    expect(buildPrompt(ctx, OWNER, "judge", candidateId).system).toContain("sentences in Korean");
  });

  it("keeps other ui settings when the language changes", () => {
    updateSettings(ctx, OWNER, { ui: { onboardingDismissedAt: 123 } });
    updateSettings(ctx, OWNER, { ui: { locale: "en" } });
    expect(getSettingsView(ctx, OWNER).ui).toEqual({ onboardingDismissedAt: 123, locale: "en" });
  });
});

it("keeps every profile edit up to the limits the API accepts", () => {
  const claims = ["a", "b", "c", "d", "e", "f"].map((x) => `claim ${x}`);
  const limitations = Array.from({ length: 8 }, (_, i) => `limit ${i}`);
  const avoid = Array.from({ length: 12 }, (_, i) => `word ${i}`);
  const view = editProfile(ctx, OWNER, "me/tool", { claims, limitations, avoid });
  expect(view.profile.claims).toEqual(claims);
  expect(view.profile.limitations).toEqual(limitations);
  expect(view.profile.avoid).toEqual(avoid);
});

it("keeps the author's stated motivation and hands it to drafts only when there is one", async () => {
  const { profileBlock } = await import("../core/prompts.js");
  const view = editProfile(ctx, OWNER, "me/tool", { why: "I kept missing which agent was waiting for me." });
  expect(view.profile.why).toBe("I kept missing which agent was waiting for me.");
  expect(profileBlock(view.profile)).toContain("why it exists (the author's own words; the only allowed motivation): I kept missing");
  expect(profileBlock({ ...view.profile, why: "" })).not.toContain("why it exists");
});

it.each([
  ['Now 40% faster. https://github.com/me/tool', 'Now handles line endings. https://github.com/me/tool'],
  ['소셜 media 게시글을 작성합니다. https://github.com/me/tool', '소셜 미디어 게시글을 작성합니다. https://github.com/me/tool'],
])('records copying but withholds an unsafe voice example until its warnings are corrected', (unsafe, fixed) => {
  const id=draft(unsafe);
  const copied=saveDraftEdit(ctx, OWNER, id, {body:unsafe,markCopied:true});
  expect(copied.status).toBe("copied");
  expect(ctx.db.select().from(schema.drafts).all().find((d) => d.id === id)?.copiedAt).toBeTruthy();
  expect(learningStats(ctx, OWNER).copied).toBe(1);
  expect(examples()).toHaveLength(0);
  saveDraftEdit(ctx, OWNER, id, {body:fixed,markCopied:true});
  expect(examples()).toHaveLength(1);
  expect(examples()[0].body).toBe(fixed);
});

it('copyIfClean saves an edit but only marks it copied when no number or claim needs review', () => {
  const id = draft('Plain text https://github.com/me/tool');
  const held = saveDraftEdit(ctx, OWNER, id, { body: 'Now 40% faster. https://github.com/me/tool', markCopied: true, copyIfClean: true });
  expect(held.status).toBe('edited');
  expect(held.body).toBe('Now 40% faster. https://github.com/me/tool');
  expect(learningStats(ctx, OWNER).copied).toBe(0);
  const clean = saveDraftEdit(ctx, OWNER, id, { body: 'Now handles line endings. https://github.com/me/tool', markCopied: true, copyIfClean: true });
  expect(clean.status).toBe('copied');
  expect(learningStats(ctx, OWNER).copied).toBe(1);
});

it("tags format lessons with their channel so they only shape that channel's drafts", () => {
  const id = draft("Long X post https://github.com/me/tool");
  expect(applyLesson(ctx, OWNER, id, "edit", { rule: "Keep it to two sentences.", category: "format" })?.rule).toBe("[X] Keep it to two sentences.");
  expect(applyLesson(ctx, OWNER, id, "edit", { rule: "Say what changed before why.", category: "voice" })?.rule).toBe("Say what changed before why.");
});

it("keeps the same rule for different channels as separate suggestions and guide lines", () => {
  const x = draft("Long X post https://github.com/me/tool");
  const li = draft("긴 링크드인 글 https://github.com/me/tool", "linkedin", "ko");
  const a = applyLesson(ctx, OWNER, x, "edit", { rule: "Keep posts short.", category: "format" });
  const b = applyLesson(ctx, OWNER, li, "edit", { rule: "Keep posts short.", category: "format" });
  expect(a?.id).not.toBe(b?.id);
  updateSettings(ctx, OWNER, { voice: { preset: "plain", guide: "Keep posts short.", useExamples: true } });
  acceptSuggestion(ctx, OWNER, a!.id);
  expect(getSettingsView(ctx, OWNER).voice.guide).toBe("Keep posts short.\n[X] Keep posts short.");
});

it("splits legacy untagged format suggestions by the channels of their source drafts, merging into existing ones", () => {
  const x = draft("Long X post https://github.com/me/tool");
  const li = draft("긴 링크드인 글 https://github.com/me/tool", "linkedin", "ko");
  const now = Date.now();
  ctx.db.insert(schema.guideSuggestions).values({ ownerId: OWNER, rule: "[X] Use bullet headings.", normalized: "x use bullet headings", category: "format", count: 2, sources: [], status: "pending", createdAt: now, updatedAt: now }).run();
  ctx.db.insert(schema.guideSuggestions).values({ ownerId: OWNER, rule: "Use bullet headings.", normalized: "use bullet headings", category: "format", count: 2, sources: [{ kind: "edit", draftId: x, at: now }, { kind: "edit", draftId: li, at: now }], status: "pending", createdAt: now, updatedAt: now }).run();
  expect(tagLegacySuggestions(ctx)).toBe(1);
  const rules = listSuggestions(ctx, OWNER).map((s) => [s.rule, s.count]).sort();
  expect(rules).toEqual([["[LinkedIn] Use bullet headings.", 1], ["[X] Use bullet headings.", 3]]);
  expect(tagLegacySuggestions(ctx)).toBe(0);
});
