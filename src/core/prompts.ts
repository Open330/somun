/**
 * 다이제스트·판단·초안 프롬프트 (순수). 프로바이더와 워커가 같은 텍스트를 쓴다.
 *
 * 원칙: 원자료(커밋 제목, PR 제목, README, omp 세션)는 다이제스트만 본다.
 * 판단과 초안은 다이제스트가 추린 highlights + 기본 사실만 본다. 전체를 넘기지 않는다.
 */
import { CHANNELS, langInstruction, langName, type Channel } from "./channels.js";
import { KO_FLUENCY_RULES } from "./voice.js";

export type EvidenceLike = {
  repo: string; repoUrl: string; description?: string; version?: string; releaseNotes?: string; stars?: number; forks?: number;
  commitCount?: number; releaseCount?: number; firstReleaseAt?: string; language?: string; license?: string; homepage?: string;
  npmPackage?: string; npmMonthlyDownloads?: number; demoAsset?: string; limitations?: string[]; readmeExcerpt?: string;
  mergedPrTitles?: string[]; ompSummary?: string; commitSubjects?: string[]; highlights?: string[];
};

export type CandidateLike = { title: string; type: string; evidence: EvidenceLike };

export type PromptSpec = { system: string; user: string; schema: Record<string, unknown>; schemaName: string };

/** 판단·초안이 보는 사실 블록. 원자료는 넣지 않는다. */
export function factsBlock(c: CandidateLike): string {
  const e = c.evidence;
  return [
    `# ${c.title} (${c.type})`,
    `repo: ${e.repo} — ${e.repoUrl}`,
    e.description ? `what it is: ${e.description}` : "",
    e.version ? `latest version: ${e.version}` : "",
    e.firstReleaseAt ? `first release: ${e.firstReleaseAt}` : "",
    e.releaseCount !== undefined ? `releases: ${e.releaseCount}` : "",
    e.commitCount !== undefined ? `commits: ${e.commitCount}` : "",
    e.stars !== undefined ? `stars: ${e.stars}, forks: ${e.forks ?? 0}` : "",
    e.language ? `language: ${e.language}, license: ${e.license ?? "?"}` : "",
    e.homepage ? `homepage: ${e.homepage}` : "",
    e.npmPackage ? `npm: ${e.npmPackage}, downloads last month: ${e.npmMonthlyDownloads}` : "",
    e.demoAsset ? `demo asset in README: ${e.demoAsset}` : "demo asset: none found in README",
    e.limitations?.length ? `limitations (from README):\n- ${e.limitations.join("\n- ")}` : "limitations: none stated in README",
    e.highlights?.length ? `\n## What changed, PR-worthy only (digest)\n- ${e.highlights.join("\n- ")}` : "\n## Digest: (none yet)",
    `\n## Numbers you may use (verbatim, nothing else)\n${numbersLine(e)}`,
  ].filter(Boolean).join("\n");
}

/** 초안이 쓸 수 있는 숫자를 한 줄로 못 박는다. 모델이 placeholder를 남발하지 않게. */
export function numbersLine(e: EvidenceLike): string {
  const items = [
    e.stars !== undefined ? `stars=${e.stars}` : "",
    e.forks !== undefined ? `forks=${e.forks}` : "",
    e.commitCount !== undefined ? `commits=${e.commitCount}` : "",
    e.releaseCount !== undefined ? `releases=${e.releaseCount}` : "",
    e.version ? `version=${e.version}` : "",
    e.firstReleaseAt ? `first_release=${e.firstReleaseAt}` : "",
    e.npmMonthlyDownloads !== undefined ? `npm_downloads_last_month=${e.npmMonthlyDownloads}` : "",
  ].filter(Boolean);
  return items.length ? items.join(", ") : "(none — write [number needed] where a number would go)";
}

/** 다이제스트만 원자료를 본다. */
export function rawBlock(c: CandidateLike): string {
  const e = c.evidence;
  return [
    e.releaseNotes ? `## Release notes\n${e.releaseNotes.slice(0, 3000)}` : "",
    e.mergedPrTitles?.length ? `## Merged PR titles\n- ${e.mergedPrTitles.join("\n- ")}` : "",
    e.commitSubjects?.length ? `## Commit subjects since last release\n- ${e.commitSubjects.slice(0, 60).join("\n- ")}` : "",
    e.ompSummary ? `## Agent session summary (what the author struggled with)\n${e.ompSummary}` : "",
    e.readmeExcerpt ? `## README excerpt\n${e.readmeExcerpt.slice(0, 1500)}` : "",
  ].filter(Boolean).join("\n\n");
}

export const DIGEST_SCHEMA = {
  type: "object",
  properties: {
    highlights: { type: "array", items: { type: "string" }, description: "3-8 facts worth telling the public, each one sentence, each traceable to the raw material" },
    dropped: { type: "string", description: "One sentence on what was left out and why (internal refactors, chores, noise)" },
    limitations: { type: "array", items: { type: "string" }, description: "0-3 honest limitations or caveats stated anywhere in the raw material (beta notices, unsupported platforms, known gaps), each one sentence" },
  },
  required: ["highlights", "dropped", "limitations"],
  additionalProperties: false,
};

export function digestPrompt(c: CandidateLike): PromptSpec {
  return {
    schemaName: "digest",
    schema: DIGEST_SCHEMA,
    system: `You read a developer's raw work record (commit subjects, merged PR titles, release notes, agent-session summaries, README) and keep only what an outside reader would care about.
Keep: user-visible features, behavior changes, measurable improvements with numbers, things that were reversed or failed and what was learned, new platforms/integrations, anything runnable.
Drop: refactors, chores, CI, formatting, dependency bumps, internal renames, anything with no visible effect.
Also collect limitations: beta notices, unsupported platforms, "not yet" items, anything the author admits does not work. Quote the substance, not the wording.
Each highlight is one plain sentence with no adjectives. Never invent numbers. If the raw material contains a number, keep it verbatim. If nothing is worth telling, return an empty list.
Write highlights in the same language as most of the raw material (English if mixed).`,
    user: `${factsBlock({ ...c, evidence: { ...c.evidence, highlights: undefined } })}\n\n# Raw material\n${rawBlock(c) || "(no raw material)"}`,
  };
}

export const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "object",
      properties: { runnable: { type: "integer" }, numbers: { type: "integer" }, lesson: { type: "integer" }, novelty: { type: "integer" }, audience: { type: "integer" } },
      required: ["runnable", "numbers", "lesson", "novelty", "audience"],
      additionalProperties: false,
    },
    reasoning: { type: "string" },
    suggestedChannels: { type: "array", items: { type: "string", enum: ["x", "threads", "linkedin", "show_hn", "show_gn", "blog"] } },
    angle: { type: "string" },
  },
  required: ["scores", "reasoning", "suggestedChannels", "angle"],
  additionalProperties: false,
};

export function judgePrompt(c: CandidateLike, ctx: { recentPublished: string[]; enabledChannels: string[]; feedback: { targetType: string; reason: string; note?: string }[] }): PromptSpec {
  const feedbackText = ctx.feedback.length ? `\nRecent editor feedback (most recent first), use it to calibrate:\n${ctx.feedback.map((f) => `- [${f.targetType}] ${f.reason}${f.note ? `: ${f.note}` : ""}`).join("\n")}` : "";
  return {
    schemaName: "judgment",
    schema: JUDGE_SCHEMA,
    system: `You are the editor for a developer who builds far more than they announce.
Decide whether this unit of work is worth a public post, and say why in a way the developer can argue with.
You are skeptical of hype and of "AI-made" as a selling point. Score five criteria 0, 1, or 2 each. Be stingy with 2s:
- runnable: can a reader try it within a minute from a link?
- numbers: is there a real measurement, count, or before/after?
- lesson: is there a failure, reversal, or non-obvious finding?
- novelty: is it new relative to what was published in the last 30 days?
- audience: can you name who cares and on which channel?
reasoning: 3-5 plain sentences in Korean, first sentence is the verdict.
angle: the one-sentence angle a post should take, or empty string.
suggestedChannels: subset of the enabled channels.`,
    user: [factsBlock(c), ctx.recentPublished.length ? `\nPublished in the last 30 days (novelty check):\n- ${ctx.recentPublished.join("\n- ")}` : "\nNothing published in the last 30 days.", `\nEnabled channels: ${ctx.enabledChannels.join(", ")}`, feedbackText].join("\n"),
  };
}

export const DRAFT_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, body: { type: "string" } },
  required: ["title", "body"],
  additionalProperties: false,
};

export type DraftOptions = { guide?: string; instruction?: string; previous?: { title?: string; body: string } };

export function draftPrompt(c: CandidateLike, channel: Channel, lang: string, examples: { source: string; title?: string; body: string }[], angle?: string, opts: DraftOptions = {}): PromptSpec {
  const spec = CHANNELS[channel];
  const exampleText = examples.length
    ? `## Examples of the voice to match (${langName(lang)})\n` + examples.map((e, i) => `### Example ${i + 1}${e.source === "seed" ? " (best practice)" : " (author's own)"}\n${e.title ? `Title: ${e.title}\n` : ""}${e.body}`).join("\n\n")
    : "";
  return {
    schemaName: "draft",
    schema: DRAFT_SCHEMA,
    system: `You write first drafts of public posts for a developer who dislikes self-promotion and dislikes AI-sounding text even more.
Hard rules:
- Every fact, number, and link must come from the Facts block. Never invent a number. If a number is missing, write [number needed] (or [숫자 확인] in Korean) in its place.
- Never mention that the code was written with AI or agents unless the tool itself is about agents.
- Include exactly one real limitation from Facts when the channel asks for one. If Facts lists no limitation, use the version status (e.g. "still 0.x, API may change") as the limitation. Never write "none stated".
- Use the numbers from "Numbers you may use" directly. Write [number needed] only when that line has no matching number.
- No emoji, no exclamation marks, no press-release phrases, no bullet lists made of emoji.
- Follow the Voice guide for register, sentence length, and how to open and close. If Examples are given, they only illustrate the same voice; never copy their facts.
- If an Editor instruction is given, it overrides the guide for this rewrite. Keep everything else the same unless the instruction says otherwise.
- title must be an empty string if the channel has no title.`,
    user: [
      `## Channel: ${spec.label} · Language: ${langName(lang)}`,
      langInstruction(lang),
      `Rules: ${spec.rules}`,
      spec.maxChars ? `Max length: ${spec.maxChars} characters.` : "",
      spec.hasTitle ? `A title is required (max ${spec.titleMaxChars} chars).` : "No title (return empty string).",
      angle ? `Angle to take: ${angle}` : "",
      "",
      opts.guide ? `## Voice guide\n${opts.guide}` : "",
      lang === "ko" ? `\n${KO_FLUENCY_RULES}` : "",
      opts.previous ? `\n## Previous version (rewrite this; do not repeat it verbatim)\n${opts.previous.title ? `Title: ${opts.previous.title}\n` : ""}${opts.previous.body}` : "",
      opts.instruction ? `\n## Editor instruction for this rewrite\n${opts.instruction}` : "",
      "",
      "## Facts",
      factsBlock(c),
      "",
      exampleText,
    ].filter((l) => l !== undefined).join("\n"),
  };
}
