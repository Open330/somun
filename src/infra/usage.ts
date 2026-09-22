import { randomUUID } from "node:crypto";
import { and, asc, eq, lt } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { schema } from "./db/index.js";
import type { Logger } from "./logger.js";

/**
 * LLM 사용량을 jiun-api에 보고한다. 계약: jiun-api/docs/USAGE_EVENTS.md
 * - 프롬프트·응답·키는 보내지 않는다. 토큰 수와 라벨만.
 * - 보고는 부가 기능이다. 실패가 원래 요청으로 번지지 않는다 (throw 금지).
 * - 먼저 outbox에 적고, 전송이 확인된 행만 지운다. 재시도는 같은 eventId로.
 */
export type UsageProvider = "openai" | "anthropic" | "google" | "cloudflare" | "openrouter" | "local";
export type UsageEvent = {
  eventId: string; userId?: string; occurredAt: string; provider: UsageProvider; model: string; apiKeyLabel?: string;
  inputTokens: number; outputTokens: number; cachedInputTokens: number; totalTokens: number; latencyMs?: number; status: "success" | "error" | "cancelled";
};

const LABEL = /^[a-z0-9_-]{1,32}$/;
const OBJECT_ID = /^[a-f0-9]{24}$/;
const BATCH = 100;
const MAX_ATTEMPTS = 20;

export class UsageReporter {
  private inFlight: Promise<{ sent: number; failed: number }> | null = null;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly db: Db, private readonly log: Logger, private readonly cfg: { apiUrl: string; serviceId: string; serviceKey?: string }) {}

  get enabled(): boolean { return Boolean(this.cfg.serviceKey); }

  /** ownerId "https://api.jiun.dev|<sub>" → jiun-api userId. 토큰·익명 모드는 익명으로. */
  static userIdOf(ownerId: string): string | undefined {
    const sub = ownerId.split("|")[1];
    return sub && OBJECT_ID.test(sub) ? sub : undefined;
  }

  /** 기록만 한다. 전송은 flush가. */
  record(ev: Omit<UsageEvent, "eventId"> & { eventId?: string }): void {
    if (!this.enabled) return;
    const eventId = ev.eventId ?? `${this.cfg.serviceId}:${randomUUID()}`;
    const label = ev.apiKeyLabel && LABEL.test(ev.apiKeyLabel) ? ev.apiKeyLabel : undefined;
    const n = (x: number) => (Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
    const payload: UsageEvent = { ...ev, eventId, apiKeyLabel: label, inputTokens: n(ev.inputTokens), outputTokens: n(ev.outputTokens), cachedInputTokens: n(ev.cachedInputTokens), totalTokens: n(ev.totalTokens) };
    if (!payload.userId) delete payload.userId;
    if (!payload.apiKeyLabel) delete payload.apiKeyLabel;
    try {
      this.db.insert(schema.usageOutbox).values({ eventId, payload: payload as unknown as Record<string, unknown>, attempts: 0, nextAt: Date.now(), createdAt: Date.now() }).onConflictDoNothing().run();
      this.kick();
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, "usage outbox insert failed");
    }
  }

  private kick() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 2000);
  }

  /** 대기열을 보낸다. 성공한 행은 지우고, 실패한 행은 지수 백오프로 미룬다. */
  flush(): Promise<{ sent: number; failed: number }> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.inFlight) this.inFlight = this.sendBatch().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async sendBatch(): Promise<{ sent: number; failed: number }> {
    if (!this.enabled) return { sent: 0, failed: 0 };
    const now = Date.now();
    const rows = this.db.select().from(schema.usageOutbox).where(and(lt(schema.usageOutbox.nextAt, now + 1), lt(schema.usageOutbox.attempts, MAX_ATTEMPTS))).orderBy(asc(schema.usageOutbox.createdAt)).limit(BATCH).all();
    if (rows.length === 0) return { sent: 0, failed: 0 };
    try {
      const res = await fetch(`${this.cfg.apiUrl}/usage/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Service-Key": this.cfg.serviceKey! },
        body: JSON.stringify({ serviceId: this.cfg.serviceId, events: rows.map((r) => r.payload) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`usage ${res.status}: ${(await res.text()).slice(0, 200)}`);
      for (const r of rows) this.db.delete(schema.usageOutbox).where(eq(schema.usageOutbox.eventId, r.eventId)).run();
      const j = (await res.json().catch(() => ({}))) as { accepted?: number; duplicates?: number };
      this.log.info({ sent: rows.length, accepted: j.accepted, duplicates: j.duplicates }, "usage reported");
      return { sent: rows.length, failed: 0 };
    } catch (e) {
      for (const r of rows) {
        const attempts = r.attempts + 1;
        this.db.update(schema.usageOutbox).set({ attempts, nextAt: now + Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts, 7)), lastError: (e as Error).message.slice(0, 300) }).where(eq(schema.usageOutbox.eventId, r.eventId)).run();
      }
      this.log.warn({ err: (e as Error).message, rows: rows.length }, "usage report failed; queued for retry");
      return { sent: 0, failed: rows.length };
    }
  }
}
