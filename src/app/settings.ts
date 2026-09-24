import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { DEFAULT_CHANNEL_LANGS, type Channel } from "../core/channels.js";
import { DEFAULT_BANNED_PHRASES } from "../core/lint.js";
import { DEFAULT_VOICE_PRESET } from "../core/voice.js";
import { schema } from "../infra/db/index.js";
import { PLAIN_BOX, SecretBox } from "../infra/secrets.js";
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
  voice: { preset: DEFAULT_VOICE_PRESET, guide: "", useExamples: true },
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

const box = (ctx: AppContext) => ctx.env.secrets ?? PLAIN_BOX;

/** 저장 형태 ↔ 쓰는 형태. 비밀값(API 키, 웹훅 URL)만 봉인한다. */
function sealSecrets(ctx: AppContext, s: Settings): Settings {
  return {
    ...s,
    llm: s.llm.apiKey ? { ...s.llm, apiKey: box(ctx).seal(s.llm.apiKey) } : s.llm,
    notify: s.notify?.discordWebhookUrl ? { ...s.notify, discordWebhookUrl: box(ctx).seal(s.notify.discordWebhookUrl) } : s.notify,
  };
}
function openSecrets(ctx: AppContext, s: Settings): Settings {
  return {
    ...s,
    llm: s.llm.apiKey ? { ...s.llm, apiKey: box(ctx).open(s.llm.apiKey) } : s.llm,
    notify: s.notify?.discordWebhookUrl ? { ...s.notify, discordWebhookUrl: box(ctx).open(s.notify.discordWebhookUrl) } : s.notify,
  };
}

export function getSettings(ctx: AppContext, ownerId: string): Settings {
  const row = ctx.db.select().from(schema.settings).where(eq(schema.settings.ownerId, ownerId)).get();
  return openSecrets(ctx, { ...DEFAULT_SETTINGS, ...migrateLegacy((row?.data as Partial<Settings>) ?? {}) });
}

function saveSettings(ctx: AppContext, ownerId: string, next: Settings): void {
  const data = sealSecrets(ctx, next) as unknown as Record<string, unknown>;
  ctx.db.insert(schema.settings).values({ ownerId, data, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: schema.settings.ownerId, set: { data, updatedAt: Date.now() } }).run();
}

/**
 * 저장된 비밀값을 모두 열어 본다. 키가 없거나 다르면 여기서 멈춘다(요청마다 500이 나는 대신 시작할 때 알린다).
 */
export function assertSecretsReadable(ctx: AppContext): void {
  const app = ctx.db.select().from(schema.appState).where(eq(schema.appState.key, "github_app")).get();
  if (app) {
    try { JSON.parse(box(ctx).open(app.value)); }
    catch (e) { throw new Error(`stored GitHub App credentials cannot be decrypted (${(e as Error).message}). SOMUN_SECRET_KEY must be the key that encrypted them.`); }
  }
  for (const row of ctx.db.select({ ownerId: schema.settings.ownerId }).from(schema.settings).all()) {
    try { getSettings(ctx, row.ownerId); }
    catch (e) { throw new Error(`stored secrets cannot be decrypted (${(e as Error).message}). SOMUN_SECRET_KEY must be the key that encrypted them.`); }
  }
}

/**
 * 암호화 키를 새로 설정한 뒤 처음 시작할 때, 평문으로 남아 있는 비밀값을 봉인해 다시 저장한다. 바꾼 계정 수를 돌려준다.
 */
export function resealSecrets(ctx: AppContext): number {
  if (!box(ctx).enabled) return 0;
  let n = 0;
  for (const row of ctx.db.select().from(schema.settings).all()) {
    const d = row.data as Partial<Settings>;
    const plain = (d.llm?.apiKey && !SecretBox.isSealed(d.llm.apiKey)) || (d.notify?.discordWebhookUrl && !SecretBox.isSealed(d.notify.discordWebhookUrl));
    if (!plain) continue;
    saveSettings(ctx, row.ownerId, getSettings(ctx, row.ownerId));
    n++;
  }
  return n;
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
  // 화면 상태는 항목별로 합친다(언어를 바꿔도 온보딩 닫은 시각이 지워지지 않게).
  if (patch.ui) next.ui = { ...current.ui, ...patch.ui };
  if (patch.llm) next.llm = { ...patch.llm, apiKey: patch.llm.apiKey || (keepApiKey ? current.llm.apiKey : undefined) };
  saveSettings(ctx, ownerId, next);
  emit(ctx, ownerId, { resource: "settings" });
  return getSettingsView(ctx, ownerId);
}

/** 문체 설정의 짧은 지문. 초안에 남겨 두고 학습 효과를 설정 버전별로 비교한다. */
export function styleKeyOf(voice: Settings["voice"]): string {
  return createHash("sha256").update(JSON.stringify([voice.preset, voice.guide.trim(), voice.useExamples])).digest("hex").slice(0, 8);
}
