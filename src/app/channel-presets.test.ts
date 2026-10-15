import { DIGEST_REVISION } from "../core/prompts.js";
import { EventEmitter } from 'node:events';
import pino from 'pino';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDb, schema } from '../infra/db/index.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { channelSpec, enabledTargets, type CustomChannel } from '../core/channels.js';
import { lintDraft } from '../core/lint.js';
import { voiceGuideFor, channelTag } from '../core/voice.js';
import { applyResult, buildPrompt, primaryTarget } from './pipeline.js';
import { readDraft, repairPrompt } from './draft-repair.js';
import { applyLesson } from './learning.js';
import { pickWeeklyAll } from './weekly-pick.js';
import { getSettings } from './settings.js';
import type { AppContext } from './context.js';

let ctx: AppContext;
let app: ReturnType<typeof createApp>;
const preset: CustomChannel = { ...channelSpec('threads'), id: 'custom_newsletter', label: 'Newsletter', identity: { audience: 'Maintainers', purpose: 'Weekly changes', tone: 'Direct', structure: 'Summary and evidence' }, hasTitle: true, titleMaxChars: 30, maxChars: 200, maxSentences: 3, linkPlacement: 'body', rules: 'Use facts only.' };
const headers = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };
beforeEach(() => {
 ctx = { db: openDb(':memory:'), log: pino({ level: 'silent' }), env: {}, bus: new EventEmitter(), usage: { record() {} } } as unknown as AppContext;
 app = createApp(ctx, loadConfig({ SOMUN_TOKEN: 'test' }));
});
afterEach(() => ctx.db.$client.close());
const save = (patch: unknown, target = app) => target.request('/api/settings', { method: 'PATCH', headers, body: JSON.stringify(patch) });

it('creates, edits and disables an owned preset without losing its identity or other settings', async () => {
 expect((await save({ customChannels: [preset], channelLangs: { x: ['ko'], [preset.id]: ['en'] } })).status).toBe(200);
 expect(enabledTargets(getSettings(ctx, 'local').channelLangs, getSettings(ctx, 'local').customChannels)).toEqual([{ channel: 'x', lang: 'ko' }, { channel: preset.id, lang: 'en' }]);
 expect((await save({ customChannels: [{ ...preset, label: 'Weekly notes' }] })).status).toBe(200);
 expect(channelSpec(preset.id, getSettings(ctx, 'local').customChannels).label).toBe('Weekly notes');
 expect(channelSpec(preset.id, getSettings(ctx, 'local').customChannels).maxSentences).toBe(3);
 expect((await save({ customChannels: [{ ...preset, maxSentences: undefined }] })).status).toBe(200);
 expect(channelSpec(preset.id, getSettings(ctx, 'local').customChannels).maxSentences).toBeUndefined();
 expect((await save({ channelLangs: { [preset.id]: [] } })).status).toBe(200);
 expect(enabledTargets(getSettings(ctx, 'local').channelLangs, getSettings(ctx, 'local').customChannels)).toEqual([]);
 expect(getSettings(ctx, 'local').customChannels).toHaveLength(1);
 expect((await save({ customChannels: [], channelLangs: {} })).status).toBe(400);
});

it('rejects another account’s preset, unknown channels and invalid configurations atomically', async () => {
 expect((await save({ customChannels: [preset], channelLangs: { [preset.id]: ['en'] } })).status).toBe(200);
 const other = createApp(ctx, loadConfig({ SOMUN_TOKEN: 'test', SOMUN_TOKEN_OWNER_ID: 'other' }));
 expect((await save({ channelLangs: { [preset.id]: ['en'] } }, other)).status).toBe(400);
 expect((await other.request('/api/candidates/1/redraft', { method: 'POST', headers, body: JSON.stringify({ targets: [{ channel: preset.id, lang: 'en' }] }) })).status).toBe(400);
 for (const customChannels of [[preset, preset], [{ ...preset, label: '   ' }], [{ ...preset, composeUrl: 'javascript:alert(1)' }], [{ ...preset, titleMaxChars: undefined }], [{ ...preset, maxChars: 1 }], [{ ...preset, maxSentences: 0 }], [{ ...preset, maxSentences: 1.5 }], [{ ...preset, maxSentences: 51 }]]) {
  expect((await save({ customChannels })).status).toBe(400);
 }
 expect(getSettings(ctx, 'local').customChannels).toEqual([preset]);
 expect(getSettings(ctx, 'other').customChannels).toBeUndefined();
});

it('carries identity, title, limits and channel-specific learning through generation and repair', async () => {
 await save({ customChannels: [preset], channelLangs: { [preset.id]: ['en'] } });
 const candidateId = Number(ctx.db.insert(schema.candidates).values({ ownerId: 'local', repo: 'me/tool', title: 'Tool update', type: 'release', key: 'k', evidence: { repo: 'me/tool', repoUrl: 'https://github.com/me/tool', highlights: ['Supports watch mode.'], highlightsAt: 1 }, createdAt: 1, updatedAt: 1 }).run().lastInsertRowid);
 const prompt = buildPrompt(ctx, 'local', 'draft', candidateId, preset.id, 'en');
 for (const text of ['Newsletter', 'Maintainers', 'Weekly changes', 'Summary and evidence', 'Use facts only.']) expect(prompt.user).toContain(text);
 expect(JSON.stringify(buildPrompt(ctx, 'local', 'judge', candidateId).schema)).toContain(preset.id);
 const result = applyResult(ctx, 'local', { kind: 'draft', candidateId, channel: preset.id, lang: 'en', model: 'fixture', result: { title: 'Watch mode', body: 'Supports watch mode. https://github.com/me/tool' } });
 const draft = ctx.db.select().from(schema.drafts).get()!;
 expect(draft.title).toBe('Watch mode');
 expect(draft.lint.find((l) => l.rule === 'length')?.ok).toBe(true);
 expect(readDraft(preset.id, draft, [preset]).title).toBe('Watch mode');
 expect(repairPrompt({ id: 1, candidateId, channel: preset.id, user: prompt.user }, draft, [], [preset])).toContain('Title: Watch mode');
 expect(lintDraft(preset.id, 'x'.repeat(31), 'x'.repeat(201), [], {}, 'en', preset).filter((l) => ['length', 'title_length', 'has_link'].includes(l.rule)).every((l) => !l.ok)).toBe(true);
 const suggestion = applyLesson(ctx, 'local', result.draftId!, 'edit', { rule: 'Use one heading.', category: 'structure' })!;
 expect(suggestion.rule).toBe(`${channelTag(preset.id)} Use one heading.`);
 expect(voiceGuideFor({ guide: suggestion.rule }, 'en', 'x')).not.toContain('Use one heading.');
 expect(voiceGuideFor({ guide: suggestion.rule }, 'en', preset.id)).toContain('Use one heading.');
 expect((await app.request('/api/publications', { method: 'POST', headers, body: JSON.stringify({ candidateId, draftId: draft.id, channel: preset.id, lang: 'en', url: 'https://www.linkedin.com/posts/test' }) })).status).toBe(200);
});

it('does not require an introduction link in the Threads body or a custom first-reply body', () => {
 for (const spec of [channelSpec('threads'), { ...preset, linkPlacement: 'reply' as const }, { ...preset, linkPlacement: 'none' as const }]) {
  expect(lintDraft(spec.id, undefined, 'A short question?', [], { preferLink: 'https://example.com' }, 'en', spec).some((l) => ['preferred_link', 'has_link'].includes(l.rule))).toBe(false);
 }
});

it('prepares the weekly pick when only a personal channel is enabled', async () => {
 await save({ customChannels: [preset], channelLangs: { [preset.id]: ['en'] }, llm: { provider: 'local-agent' } });
 const settings = getSettings(ctx, 'local');
 expect(primaryTarget(ctx, 'local', settings)).toEqual({ channel: preset.id, lang: 'en' });
 const now = Date.now();
 ctx.db.insert(schema.candidates).values({ ownerId: 'local', repo: 'me/tool', title: 'Update', type: 'release', key: 'weekly', evidence: { highlights: ['Watch mode'], highlightsAt: now, digestRevision: DIGEST_REVISION }, createdAt: now, updatedAt: now }).run();
 expect(pickWeeklyAll(ctx, now)).toBe(1);
 expect(ctx.db.select().from(schema.llmJobs).get()?.channel).toBe(preset.id);
});
