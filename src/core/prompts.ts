/**
 * 다이제스트·판단·초안 프롬프트 (순수). 프로바이더와 워커가 같은 텍스트를 쓴다.
 *
 * 원칙: 원자료(커밋 제목, PR 제목, README, omp 세션)는 다이제스트만 본다.
 * 판단과 초안은 다이제스트가 추린 highlights + 기본 사실만 본다. 전체를 넘기지 않는다.
 */
import { CHANNELS, langInstruction, langName, type Channel } from "./channels.js";
import { KO_FLUENCY_RULES } from "./voice.js";
import type { Locale } from "../shared/locale.js";

export type EvidenceLike = {
  repo: string; repoUrl: string; description?: string; version?: string; releaseNotes?: string; stars?: number; forks?: number;
  commitCount?: number; releaseCount?: number; firstReleaseAt?: string; language?: string; license?: string; homepage?: string;
  npmPackage?: string; npmMonthlyDownloads?: number; demoAsset?: string; limitations?: string[]; readmeExcerpt?: string;
  mergedPrTitles?: string[]; ompSummary?: string; commitSubjects?: string[]; highlights?: string[];
  milestones?: { metric: string; threshold: number; at: number }[];
};

export type CandidateLike = { title: string; type: string; evidence: EvidenceLike };

export type PromptSpec = { system: string; user: string; schema: Record<string, unknown>; schemaName: string };

export type ProfileLike = { what: string; audience: string; claims: string[]; stage: string; limitations: string[]; naming: string; avoid: string[] };

/** 프로필 블록. 정체성은 여기서만 말하고, 변경은 다이제스트가 말한다. */
export function profileBlock(p: ProfileLike): string {
  return [
    "## What this project is (profile, the baseline; do not re-announce any of this as a change)",
    `what: ${p.what}`,
    `for whom: ${p.audience}`,
    p.claims.length ? `core claims:\n- ${p.claims.join("\n- ")}` : "",
    `stage: ${p.stage}`,
    p.limitations.length ? `known limitations:\n- ${p.limitations.join("\n- ")}` : "",
    p.naming ? `how to name it: ${p.naming}` : "",
    p.avoid.length ? `never mention: ${p.avoid.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

/** 판단·초안이 보는 사실 블록. 원자료는 넣지 않는다. 프로필이 있으면 설명 대신 프로필을 쓴다. */
export function factsBlock(c: CandidateLike, profile?: ProfileLike): string {
  const e = c.evidence;
  return [
    `# ${c.title} (${c.type})`,
    `repo: ${e.repo} — ${e.repoUrl}`,
    profile ? profileBlock(profile) : e.description ? `what it is: ${e.description}` : "",
    e.version ? `latest version: ${e.version}` : "",
    e.firstReleaseAt ? `first release: ${e.firstReleaseAt}` : "",
    e.releaseCount !== undefined ? `releases: ${e.releaseCount}` : "",
    e.commitCount !== undefined ? `commits: ${e.commitCount}` : "",
    e.stars !== undefined ? `stars: ${e.stars}${e.forks !== undefined ? `, forks: ${e.forks}` : ""}` : "",
    e.milestones?.length ? `milestones crossed this window: ${e.milestones.map((m) => `${m.metric} ${m.threshold}`).join(", ")}` : "",
    e.language ? `language: ${e.language}, license: ${e.license ?? "?"}` : "",
    e.homepage ? `homepage: ${e.homepage}` : "",
    e.npmPackage ? `npm: ${e.npmPackage}, downloads last month: ${e.npmMonthlyDownloads}` : "",
    e.demoAsset ? `demo asset in README: ${e.demoAsset}` : "demo asset: none found in README",
    e.limitations?.length ? `limitations (from README):\n- ${e.limitations.join("\n- ")}` : profile?.limitations.length ? "" : "limitations: none stated in README",
    e.highlights?.length ? `\n## What changed, PR-worthy only (digest)\n- ${e.highlights.join("\n- ")}` : "\n## Digest: (none yet)",
    `\n## Numbers you may use (verbatim, nothing else)\n${numbersLine(e)}`,
  ].filter(Boolean).join("\n");
}

/**
 * 사실 대조의 기준. 다이제스트가 본 원자료 + 기본 사실 + 프로필. 다이제스트 요약(highlights)은 넣지 않는다.
 * 요약이 지어낸 숫자가 "근거 있음"으로 통과하지 않게, 요약과 초안 모두 이것과 맞춰 본다.
 */
export function groundingText(c: CandidateLike, profile?: ProfileLike): string {
  return [factsBlock({ ...c, evidence: { ...c.evidence, highlights: undefined } }, profile), rawBlock(c, false)].join("\n\n");
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
  return items.length ? items.join(", ") : "(none — omit numeric claims; do not insert placeholders)";
}

/** 다이제스트만 원자료를 본다. */
export function rawBlock(c: CandidateLike, hasProfile = false): string {
  const e = c.evidence;
  return [
    e.releaseNotes ? `## Release notes\n${e.releaseNotes.slice(0, 3000)}` : "",
    e.mergedPrTitles?.length ? `## Merged PR titles\n- ${e.mergedPrTitles.join("\n- ")}` : "",
    e.commitSubjects?.length ? `## Commit subjects since last release\n- ${e.commitSubjects.slice(0, 60).join("\n- ")}` : "",
    e.ompSummary ? `## Agent session summary (what the author struggled with)\n${e.ompSummary}` : "",
    e.readmeExcerpt && !hasProfile ? `## README excerpt\n${e.readmeExcerpt.slice(0, 1500)}` : "",
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

export type DigestContext = { profile?: ProfileLike; alreadyTold?: string[]; disputed?: string[] };

export function digestPrompt(c: CandidateLike, ctx: DigestContext = {}): PromptSpec {
  return {
    schemaName: "digest",
    schema: DIGEST_SCHEMA,
    system: `You read a developer's raw work record (commit subjects, merged PR titles, release notes, agent-session summaries, README) and keep only what an outside reader would care about.
Keep: user-visible features, behavior changes, measurable improvements with numbers, things that were reversed or failed and what was learned, new platforms/integrations, anything runnable.
Drop: refactors, chores, CI, formatting, dependency bumps, internal renames, anything with no visible effect.
Also collect limitations: beta notices, unsupported platforms, "not yet" items, anything the author admits does not work. Quote the substance, not the wording.
Each highlight is one plain sentence with no adjectives. Never invent numbers. If the raw material contains a number, keep it verbatim. If nothing is worth telling, return an empty list.
Write highlights in the same language as most of the raw material (English if mixed).
If a profile is given, it is the baseline: never restate what the project is as a highlight. Only what changed relative to it.
If an "Already told" list is given, drop any highlight that says the same thing in other words.`,
    user: [
      factsBlock({ ...c, evidence: { ...c.evidence, highlights: undefined } }, ctx.profile),
      ctx.alreadyTold?.length ? `\n## Already told (do not repeat; only genuinely new changes)\n- ${ctx.alreadyTold.join("\n- ")}` : "",
      ctx.disputed?.length ? `\n## Flagged as wrong by the author (never restate these; if the raw material still suggests them, be more precise)\n- ${ctx.disputed.join("\n- ")}` : "",
      `\n# Raw material\n${rawBlock(c, Boolean(ctx.profile)) || "(no raw material)"}`,
    ].filter(Boolean).join("\n"),
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

export function judgePrompt(c: CandidateLike, ctx: { recentPublished: string[]; enabledChannels: string[]; feedback: { targetType: string; reason: string; note?: string }[]; profile?: ProfileLike; alreadyPublished?: string[]; repoDrops?: number; channelResults?: string[]; locale?: Locale }): PromptSpec {
  const feedbackText = ctx.feedback.length ? `\nRecent editor feedback (most recent first), use it to calibrate:\n${ctx.feedback.map((f) => `- [${f.targetType}] ${f.reason}${f.note ? `: ${f.note}` : ""}`).join("\n")}` : "";
  return {
    schemaName: "judgment",
    schema: JUDGE_SCHEMA,
    system: `You are the editor for a developer who builds far more than they announce.
Decide whether this unit of work is worth a public post, and say why in a way the developer can argue with.
You are skeptical of hype and of "AI-made" as a selling point. Score five criteria 0, 1, or 2 each. Be stingy with 2s:
- runnable: can a reader try it within a minute from a link? A repo URL is a supplied link: never claim there is no link when repo or homepage includes a URL. If installation or demo steps are absent, explain that specific gap instead.
- numbers: is there a real measurement, count, or before/after?
- lesson: is there a failure, reversal, or non-obvious finding?
- novelty: is this change new relative to what was published in the last 30 days? Judge the change, not whether the project itself is already famous.
- audience: can you name who cares and on which channel?
reasoning: 3-5 plain sentences in ${ctx.locale === "en" ? "English" : "Korean"}, first sentence is the verdict.
angle: the one-sentence angle a post should take, or empty string.
suggestedChannels: subset of the enabled channels.`,
    user: [factsBlock(c, ctx.profile), ctx.recentPublished.length ? `\nPublished in the last 30 days (novelty check):\n- ${ctx.recentPublished.join("\n- ")}` : "\nNothing published in the last 30 days.", ctx.alreadyPublished?.length ? `\nChanges of this repo already announced (score novelty low if the digest repeats them):\n- ${ctx.alreadyPublished.join("\n- ")}` : "", ctx.repoDrops ? `\nThe editor has dropped ${ctx.repoDrops} post(s) from this repo as "not worth announcing". Be stricter: prefer defer/ask unless this is clearly different.` : "", `\nEnabled channels: ${ctx.enabledChannels.join(", ")}`, ctx.channelResults?.length ? `\nHow this developer's past posts did per channel (use it when choosing suggestedChannels; small samples, do not over-weight):\n- ${ctx.channelResults.join("\n- ")}` : "", feedbackText].join("\n"),
  };
}

export const DRAFT_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, body: { type: "string" } },
  required: ["title", "body"],
  additionalProperties: false,
};

export type DraftOptions = { guide?: string; instruction?: string; previous?: { title?: string; body: string }; profile?: ProfileLike; disputed?: string[] };

/** 짧은 채널은 선택·압축하되, 긴 채널은 변경 누락 대신 부연을 줄인다. */
export function draftCoverageGuide(c: CandidateLike, channel: Channel): string {
  const highlights = c.evidence.highlights?.filter((text) => text.trim()) ?? [];
  if (!highlights.length) return "";
  if (channel === "x" || channel === "threads") return "## Coverage\nSelect concrete changes that fit this channel. Keep each selected operation accurate. Do not imply this is a complete change list when details are omitted.";
  return ["## Required change checklist", "Preserve every distinct change below, including its component and operation. Shorten background and repetition rather than omit changes. Use compact sentences or a list within the channel character limit. Before returning, check every item against the draft. Do not add new effects or measurements.", ...highlights.map((text) => `- ${text}`)].join("\n");
}

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
- Every fact, number, and link must come from the Facts block. Never invent a number. If a number is missing, omit the numeric claim. Never insert [number needed] or [숫자 확인] placeholders.
- Never mention that the code was written with AI or agents unless the tool itself is about agents.
- Include one real limitation from Facts when the channel asks for one. If Facts lists no limitation, leave it out. Never invent one: no "API may change", "still beta", "not tested" unless Facts says so.
- Refer to the project only by the exact name in Facts (the repo name after the slash, or the full owner/name). Never shorten, respell or invent owners or names.
- Do not invent a backstory, a problem the author "hit", or a motivation. The opening must be supported by the digest or Facts. If the digest has no problem statement, open with what changed.
- A connected repository or release does not establish that the author built, owns, or released it. Use neutral attribution unless Facts explicitly establishes the author’s role. Do not imply personal authorship with "we released", "I built", or "출시했습니다" without that evidence.
- Do not add general claims about affected users, scale, bottlenecks, or benefits beyond Facts. If a required section has no evidence, omit that section rather than filling it with plausible context.
- When a technical operation has no unambiguous translation, retain the original technical wording rather than substitute a different operation.
- Keep technical nouns as the established term in the target language or the original English word (secrets → 시크릿, vault → 볼트, engine → 엔진). Never swap them for a nearby everyday word (secrets ≠ 비밀번호).
- Use the numbers from "Numbers you may use" directly. If that line has no matching number, omit the claim.
- No emoji, no exclamation marks, no press-release phrases, no bullet lists made of emoji.
- Follow the Voice guide for register, sentence length, and how to open and close. If Examples are given, they only illustrate the same voice; never copy their facts.
- If an Editor instruction is given, it overrides the guide for this rewrite. Keep everything else the same unless the instruction says otherwise.
- Factual grounding takes priority over channel format and voice instructions. Never invent personal experience, measurements, runnable commands, or limitations to fill a requested section.
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
      opts.disputed?.length ? `\n## Flagged as wrong by the author (do not use)\n- ${opts.disputed.join("\n- ")}` : "",
      "",
      "## Facts",
      factsBlock(c, opts.profile),
      "",
      exampleText,
      draftCoverageGuide(c, channel),
    ].filter((l) => l !== undefined).join("\n"),
  };
}

export const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    what: { type: "string" }, audience: { type: "string" },
    claims: { type: "array", items: { type: "string" } },
    stage: { type: "string", enum: ["experiment", "beta", "stable", "archived", "unknown"] },
    limitations: { type: "array", items: { type: "string" } },
    naming: { type: "string" }, avoid: { type: "array", items: { type: "string" } },
  },
  required: ["what", "audience", "claims", "stage", "limitations", "naming", "avoid"],
  additionalProperties: false,
};

export type ProfileMaterial = { repo: string; description?: string; readme: string; recentReleaseNotes: string[]; language?: string; license?: string; homepage?: string; stars?: number; topics?: string[] };

/** 저장소 프로필 생성. README 전문과 최근 릴리스 노트로 정체성만 뽑는다. 변경 사항은 여기 들어가지 않는다. */
export function profilePrompt(m: ProfileMaterial): PromptSpec {
  return {
    schemaName: "repo_profile",
    schema: PROFILE_SCHEMA,
    system: `You write a short, factual profile of a software project from its README and metadata. The profile is a baseline that other steps compare changes against, so describe what the project IS, not what recently changed.
- what: one sentence, plain, no adjectives. Name the category (CLI, library, web app, dataset, config repo, coursework, ...).
- audience: who would use it, in one sentence. If it is a personal/config/coursework repo, say so plainly.
- claims: up to 4 concrete things it does or promises, taken from the README. No marketing words.
- stage: experiment | beta | stable | archived | unknown, from version numbers, badges, "beta"/"WIP" notes, release count.
- limitations: things the README admits do not work or are not supported. Empty if none.
- naming: the exact name to use in prose (e.g. "muxa", not "Muxa CLI tool") and its owner/name form.
- avoid: names, employers, internal hostnames or paths in the README that should never appear in a public post. Empty if none.
Write in the language of the README (Korean if the README is Korean).`,
    user: [
      `repo: ${m.repo}`,
      m.description ? `description: ${m.description}` : "",
      m.language ? `language: ${m.language}` : "", m.license ? `license: ${m.license}` : "", m.homepage ? `homepage: ${m.homepage}` : "",
      m.stars !== undefined ? `stars: ${m.stars}` : "", m.topics?.length ? `topics: ${m.topics.join(", ")}` : "",
      m.recentReleaseNotes.length ? `\n## Recent release notes (for stage only)\n${m.recentReleaseNotes.map((n, i) => `### ${i + 1}\n${n.slice(0, 800)}`).join("\n")}` : "",
      `\n## README\n${m.readme.slice(0, 7000)}`,
    ].filter(Boolean).join("\n"),
  };
}

export const LESSON_SCHEMA = {
  type: "object",
  properties: { rule: { type: "string" }, category: { type: "string", enum: ["voice", "structure", "facts", "format", "none"] } },
  required: ["rule", "category"],
  additionalProperties: false,
};

/**
 * 수정 diff(또는 버린 초안과 사유)에서 다음 초안에 재사용할 한 줄 규칙을 뽑는다.
 * 이 글감에만 해당하는 수정(오타, 특정 숫자)이면 category "none"과 빈 rule을 낸다.
 */
export function editLessonPrompt(input: { channel: string; lang: string; before: string; after?: string; dropReason?: string; note?: string; currentGuide?: string }): PromptSpec {
  return {
    schemaName: "edit_lesson",
    schema: LESSON_SCHEMA,
    system: `You turn one editing decision into at most one reusable writing rule for future drafts of the same author.
Rules:
- The rule must generalize beyond this post (about openings, structure, register, link placement, what to avoid, how to state limitations). If the change is specific to this post (a typo, a particular number, a name), return category "none" and an empty rule.
- One sentence, imperative, in the language of the draft. Max 120 characters. No explanation.
- If a current guide already says it, return "none".
- category: voice (register, tone), structure (order, opening, closing), facts (what facts to include or omit), format (length, links, line breaks).`,
    user: [
      `channel: ${input.channel} · language: ${input.lang}`,
      input.currentGuide ? `\n## Current guide\n${input.currentGuide}` : "",
      input.after !== undefined ? `\n## Before (model draft)\n${input.before}\n\n## After (author's edit)\n${input.after}` : `\n## Draft the author dropped\n${input.before}\n\n## Reason\n${input.dropReason ?? ""}${input.note ? `: ${input.note}` : ""}`,
    ].filter(Boolean).join("\n"),
  };
}
