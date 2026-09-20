import { eq } from "drizzle-orm";
import { DEFAULT_ENABLED_CHANNELS } from "../core/channels.js";
import { DEFAULT_BANNED_PHRASES } from "../core/lint.js";
import { schema } from "../infra/db/index.js";
import type { Settings, SettingsView } from "../shared/types.js";
import { emit, type AppContext } from "./context.js";

export const DEFAULT_SETTINGS: Settings = {
  rubricWeights: { runnable: 1, numbers: 1, lesson: 1, novelty: 1, audience: 1 },
  draftThreshold: 6,
  deferThreshold: 4,
  enabledChannels: DEFAULT_ENABLED_CHANNELS,
  bannedPhrases: DEFAULT_BANNED_PHRASES,
  llm: { provider: "gemini", model: "gemini-3.5-flash-lite" },
};

export function getSettings(ctx: AppContext, ownerId: string): Settings {
  const row = ctx.db.select().from(schema.settings).where(eq(schema.settings.ownerId, ownerId)).get();
  return { ...DEFAULT_SETTINGS, ...((row?.data as Partial<Settings>) ?? {}) };
}

export function getSettingsView(ctx: AppContext, ownerId: string): SettingsView {
  const s = getSettings(ctx, ownerId);
  const { apiKey, ...llm } = s.llm;
  return { ...s, llm: { ...llm, apiKeySet: Boolean(apiKey), apiKeyHint: apiKey ? apiKey.slice(-4) : undefined } };
}

export function updateSettings(ctx: AppContext, ownerId: string, patch: Partial<Settings>, keepApiKey = true): SettingsView {
  const current = getSettings(ctx, ownerId);
  const next: Settings = { ...current, ...patch };
  if (patch.llm) next.llm = { ...patch.llm, apiKey: patch.llm.apiKey || (keepApiKey ? current.llm.apiKey : undefined) };
  ctx.db.insert(schema.settings).values({ ownerId, data: next as unknown as Record<string, unknown>, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: schema.settings.ownerId, set: { data: next as unknown as Record<string, unknown>, updatedAt: Date.now() } }).run();
  emit(ctx, ownerId, { resource: "settings" });
  return getSettingsView(ctx, ownerId);
}
