import { eq } from "drizzle-orm";
import { DEFAULT_CHANNEL_LANGS, type Channel } from "../core/channels.js";
import { DEFAULT_BANNED_PHRASES } from "../core/lint.js";
import { DEFAULT_VOICE_PRESET } from "../core/voice.js";
import { schema } from "../infra/db/index.js";
import type { Settings, SettingsView } from "../shared/types.js";
import { emit, type AppContext } from "./context.js";

export const DEFAULT_SETTINGS: Settings = {
  rubricWeights: { runnable: 1, numbers: 1, lesson: 1, novelty: 1, audience: 1 },
  draftThreshold: 6,
  deferThreshold: 4,
  channelLangs: DEFAULT_CHANNEL_LANGS,
  bannedPhrases: DEFAULT_BANNED_PHRASES,
  llm: { provider: "gemini", model: "gemini-3.5-flash-lite" },
  watch: { mode: "manual", recentDays: 30 },
  voice: { preset: DEFAULT_VOICE_PRESET, guide: "", useExamples: false },
};

/** 구 설정(enabledChannels: x_en, x_ko, ...)을 channelLangs로 옮긴다. */
function migrateLegacy(data: Partial<Settings> & { enabledChannels?: string[] }): Partial<Settings> {
  if (data.channelLangs || !data.enabledChannels) return data;
  const langs: Partial<Record<Channel, string[]>> = {};
  const add = (ch: Channel, lang: string) => { langs[ch] = [...new Set([...(langs[ch] ?? []), lang])]; };
  for (const c of data.enabledChannels) {
    if (c === "x_en") add("x", "en"); else if (c === "x_ko") add("x", "ko"); else if (c === "linkedin_ko") add("linkedin", "ko");
    else if (c === "threads") add("threads", "ko"); else if (c === "show_hn") add("show_hn", "en"); else if (c === "show_gn") add("show_gn", "ko"); else if (c === "blog_outline") add("blog", "ko");
  }
  const { enabledChannels: _drop, ...rest } = data;
  void _drop;
  return { ...rest, channelLangs: langs };
}

export function getSettings(ctx: AppContext, ownerId: string): Settings {
  const row = ctx.db.select().from(schema.settings).where(eq(schema.settings.ownerId, ownerId)).get();
  return { ...DEFAULT_SETTINGS, ...migrateLegacy((row?.data as Partial<Settings>) ?? {}) };
}

export function getSettingsView(ctx: AppContext, ownerId: string): SettingsView {
  const s = getSettings(ctx, ownerId);
  const { apiKey, ...llm } = s.llm;
  const notify = s.notify ? { weekly: s.notify.weekly, lastSentAt: s.notify.lastSentAt, discordWebhookSet: Boolean(s.notify.discordWebhookUrl) } : undefined;
  return { ...s, notify, llm: { ...llm, apiKeySet: Boolean(apiKey), apiKeyHint: apiKey ? apiKey.slice(-4) : undefined } };
}

export function updateSettings(ctx: AppContext, ownerId: string, patch: Partial<Settings>, keepApiKey = true): SettingsView {
  const current = getSettings(ctx, ownerId);
  const next: Settings = { ...current, ...patch };
  // 웹훅 URL은 빈 문자열이면 지우고, 없으면 기존 값을 지킨다.
  if (patch.notify) next.notify = { ...current.notify, weekly: patch.notify.weekly, discordWebhookUrl: patch.notify.discordWebhookUrl === "" ? undefined : patch.notify.discordWebhookUrl ?? current.notify?.discordWebhookUrl, lastSentAt: current.notify?.lastSentAt };
  if (patch.llm) next.llm = { ...patch.llm, apiKey: patch.llm.apiKey || (keepApiKey ? current.llm.apiKey : undefined) };
  ctx.db.insert(schema.settings).values({ ownerId, data: next as unknown as Record<string, unknown>, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: schema.settings.ownerId, set: { data: next as unknown as Record<string, unknown>, updatedAt: Date.now() } }).run();
  emit(ctx, ownerId, { resource: "settings" });
  return getSettingsView(ctx, ownerId);
}
