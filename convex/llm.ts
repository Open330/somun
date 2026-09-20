"use node";
import Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { getOwnerId } from "./owner";
import { CHANNELS, type Channel } from "./lib/channels";

declare const process: { env: Record<string, string | undefined> };

/**
 * 판단(judge)과 초안(draft). 둘 다 Claude API 단일 호출이며 구조화 출력을 쓴다.
 * 원칙: 사실은 Evidence 블록에서만, 문장은 채널 규칙과 사용자 예시를 따른다.
 */

const client = () => new Anthropic();

const JUDGE_SYSTEM = `You are the editor for a developer who builds far more than they announce.
Your job is to decide whether a unit of recent work is worth a public post, and to say why in a way the developer can argue with.
You are skeptical of hype and of "AI-made" as a selling point. You care about: can a reader run it in a minute, is there a real number, is there a lesson or a reversal, is it new relative to what was already published, and can you name who would care and on which channel.
Score each criterion 0, 1, or 2. Be stingy with 2s. Write reasoning as 3-5 plain sentences in Korean, first sentence being the verdict.`;

const judgeSchema = z.object({
  scores: z.object({ runnable: z.number().min(0).max(2), numbers: z.number().min(0).max(2), lesson: z.number().min(0).max(2), novelty: z.number().min(0).max(2), audience: z.number().min(0).max(2) }),
  reasoning: z.string(),
  suggestedChannels: z.array(z.enum(["x_en", "x_ko", "threads", "linkedin_ko", "show_hn", "show_gn", "blog_outline"])),
  angle: z.string().describe("The one-sentence angle a post should take, or empty if none."),
});

function evidenceBlock(c: { title: string; type: string; evidence: Record<string, unknown> }, extra?: string): string {
  const e = c.evidence;
  const lines = [
    `# Candidate: ${c.title} (${c.type})`,
    `repo: ${e.repo} — ${e.repoUrl}`,
    e.description ? `description: ${e.description}` : "",
    e.version ? `latest version: ${e.version}` : "",
    e.firstReleaseAt ? `first release: ${e.firstReleaseAt}` : "",
    e.releaseCount !== undefined ? `releases: ${e.releaseCount}` : "",
    e.commitCount !== undefined ? `commits: ${e.commitCount}` : "",
    e.stars !== undefined ? `stars: ${e.stars}, forks: ${e.forks ?? 0}` : "",
    e.language ? `language: ${e.language}, license: ${e.license ?? "?"}` : "",
    e.homepage ? `homepage: ${e.homepage}` : "",
    e.npmPackage ? `npm: ${e.npmPackage}, downloads last month: ${e.npmMonthlyDownloads}` : "",
    e.demoAsset ? `demo asset in README: ${e.demoAsset}` : "demo asset: none found in README",
    Array.isArray(e.limitations) && e.limitations.length ? `limitations (from README):\n- ${(e.limitations as string[]).join("\n- ")}` : "limitations: none stated in README",
    Array.isArray(e.mergedPrTitles) && e.mergedPrTitles.length ? `merged PRs since last release:\n- ${(e.mergedPrTitles as string[]).join("\n- ")}` : "",
    e.releaseNotes ? `release notes:\n${e.releaseNotes}` : "",
    e.readmeExcerpt ? `README excerpt:\n${e.readmeExcerpt}` : "",
    e.ompSummary ? `agent session summary:\n${e.ompSummary}` : "",
    extra ?? "",
  ];
  return lines.filter(Boolean).join("\n");
}

type JudgeResult = { total: number; decision: "draft" | "defer" | "ask" } | null;

export const judgeCandidate = internalAction({
  args: { candidateId: v.id("candidates") },
  handler: async (ctx, { candidateId }): Promise<JudgeResult> => {
    const c = await ctx.runQuery(internal.candidates.getInternal, { id: candidateId });
    if (!c) return null;
    const settings = await ctx.runQuery(internal.settings.getForOwner, { ownerId: c.ownerId });
    const recent = await ctx.runQuery(internal.candidates.recentPublishedTitles, { ownerId: c.ownerId, days: 30 });
    const feedback = await ctx.runQuery(internal.drafts.recentFeedback, { ownerId: c.ownerId, limit: 10 });
    const model = process.env.SOMUN_MODEL ?? settings.model;

    const feedbackText = feedback.length
      ? `Recent editor feedback (most recent first). Use it to calibrate:\n${feedback.map((f: { targetType: string; reason: string; note?: string }) => `- [${f.targetType}] ${f.reason}${f.note ? `: ${f.note}` : ""}`).join("\n")}`
      : "";
    const user: string = [
      evidenceBlock(c as never),
      recent.length ? `\nPublished in the last 30 days (novelty check):\n- ${recent.join("\n- ")}` : "\nNothing published in the last 30 days.",
      `\nEnabled channels: ${settings.enabledChannels.join(", ")}`,
      feedbackText,
    ].join("\n");

    const res = await client().messages.parse({
      model,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: zodOutputFormat(judgeSchema) },
      system: [{ type: "text", text: JUDGE_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    });
    if (res.stop_reason === "refusal") throw new Error("judge refused");
    if (!res.parsed_output) throw new Error("judge output did not parse");
    const parsed = res.parsed_output;
    const w = settings.rubricWeights;
    const total = parsed.scores.runnable * w.runnable + parsed.scores.numbers * w.numbers + parsed.scores.lesson * w.lesson + parsed.scores.novelty * w.novelty + parsed.scores.audience * w.audience;
    const decision = total >= settings.draftThreshold ? "draft" : total >= settings.deferThreshold ? "defer" : "ask";
    const suggested = parsed.suggestedChannels.filter((ch: Channel) => settings.enabledChannels.includes(ch));
    const reasoning = parsed.angle ? `${parsed.reasoning}\n\n각도: ${parsed.angle}` : parsed.reasoning;
    await ctx.runMutation(internal.candidates.recordJudgment, { candidateId, scores: parsed.scores, total, reasoning, decision, suggestedChannels: suggested, model });
    if (decision === "draft") await ctx.scheduler.runAfter(0, internal.llm.draftCandidate, { candidateId, channels: suggested.length ? suggested : settings.enabledChannels });
    return { total, decision };
  },
});

export const judgePending = internalAction({
  args: { ownerId: v.optional(v.string()) },
  handler: async (ctx, { ownerId }): Promise<{ judged: number }> => {
    const pending = await ctx.runQuery(internal.candidates.listByStatus, { status: "new", ownerId });
    for (const c of pending) {
      try {
        await ctx.runAction(internal.llm.judgeCandidate, { candidateId: c._id });
      } catch (e) {
        console.error(`judge ${c._id} failed`, e);
      }
    }
    return { judged: pending.length };
  },
});

const DRAFT_SYSTEM = `You write first drafts of public posts for a developer who dislikes self-promotion and dislikes AI-sounding text even more.
Hard rules:
- Every fact, number, and link must come from the Evidence block. Never invent a number. If a number is missing, write [숫자 확인] or [number needed] in its place.
- Never mention that the code was written with AI or agents unless the Evidence says the tool itself is about agents.
- Include exactly one real limitation from Evidence when the channel asks for one.
- No emoji, no exclamation marks, no press-release phrases, no bullet lists made of emoji.
- Match the voice of the Examples: sentence length, register, how they open and close. Examples are for voice, not for facts.
- Write in the channel's language. Return only the JSON.`;

const draftSchema = z.object({ title: z.string().optional(), body: z.string() });

export const draftCandidate = internalAction({
  args: { candidateId: v.id("candidates"), channels: v.array(v.string()) },
  handler: async (ctx, { candidateId, channels }): Promise<Record<string, string> | null> => {
    const c = await ctx.runQuery(internal.candidates.getInternal, { id: candidateId });
    if (!c) return null;
    const settings = await ctx.runQuery(internal.settings.getForOwner, { ownerId: c.ownerId });
    const model = process.env.SOMUN_MODEL ?? settings.model;
    const evidence = evidenceBlock(c as never);
    const results: Record<string, string> = {};
    for (const chRaw of channels) {
      const ch = chRaw as Channel;
      const spec = CHANNELS[ch];
      if (!spec) continue;
      const examples = await ctx.runQuery(internal.drafts.examplesFor, { ownerId: c.ownerId, channel: ch, limit: 4 });
      const exampleText = examples.length
        ? `## Examples of the voice to match (${spec.lang})\n` + examples.map((e: { source: string; title?: string; body: string }, i: number) => `### Example ${i + 1}${e.source === "seed" ? " (best practice)" : " (author's own)"}\n${e.title ? `Title: ${e.title}\n` : ""}${e.body}`).join("\n\n")
        : "";
      const user = [
        `## Channel: ${spec.label}`,
        `Rules: ${spec.rules}`,
        spec.maxChars ? `Max length: ${spec.maxChars} characters.` : "",
        spec.hasTitle ? `A title is required (max ${spec.titleMaxChars} chars).` : "No title.",
        "",
        "## Evidence",
        evidence,
        "",
        exampleText,
      ].filter((l) => l !== undefined).join("\n");
      try {
        const res = await client().messages.parse({
          model,
          max_tokens: 4000,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium", format: zodOutputFormat(draftSchema) },
          system: [{ type: "text", text: DRAFT_SYSTEM, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: user }],
        });
        if (res.stop_reason === "refusal") throw new Error("draft refused");
        if (!res.parsed_output) throw new Error("draft output did not parse");
        const parsed = res.parsed_output;
        await ctx.runMutation(internal.drafts.record, { candidateId, channel: ch, title: spec.hasTitle ? parsed.title : undefined, body: parsed.body.trim(), model, bannedPhrases: settings.bannedPhrases });
        results[ch] = "ok";
      } catch (e) {
        results[ch] = (e as Error).message;
        console.error(`draft ${ch} for ${candidateId} failed`, e);
      }
    }
    return results;
  },
});

/** 화면 버튼: 이 후보를 (다시) 판단하거나, 특정 채널 초안을 (다시) 만든다. */
export const rejudge = action({
  args: { candidateId: v.id("candidates") },
  handler: async (ctx, { candidateId }): Promise<JudgeResult> => {
    const ownerId = await getOwnerId(ctx);
    const c = await ctx.runQuery(internal.candidates.getInternal, { id: candidateId });
    if (!c || c.ownerId !== ownerId) throw new Error("candidate not found");
    return await ctx.runAction(internal.llm.judgeCandidate, { candidateId });
  },
});

export const redraft = action({
  args: { candidateId: v.id("candidates"), channels: v.array(v.string()) },
  handler: async (ctx, { candidateId, channels }): Promise<Record<string, string> | null> => {
    const ownerId = await getOwnerId(ctx);
    const c = await ctx.runQuery(internal.candidates.getInternal, { id: candidateId });
    if (!c || c.ownerId !== ownerId) throw new Error("candidate not found");
    return await ctx.runAction(internal.llm.draftCandidate, { candidateId, channels });
  },
});
