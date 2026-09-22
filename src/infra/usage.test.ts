import pino from "pino";
import { afterEach, expect, it, vi } from "vitest";
import { openDb, schema } from "./db/index.js";
import { UsageReporter } from "./usage.js";

afterEach(() => vi.unstubAllGlobals());
it("does not let exhausted rows starve eligible usage events", async () => {
  const db = openDb(":memory:");
  try {
    const now = Date.now();
    db.insert(schema.usageOutbox).values(Array.from({ length: 100 }, (_, i) => ({ eventId: `exhausted-${i}`, payload: {}, attempts: 20, nextAt: now - 1, createdAt: now }))).run();
    db.insert(schema.usageOutbox).values({ eventId: "eligible", payload: { eventId: "eligible" }, attempts: 0, nextAt: now - 1, createdAt: now - 1000 }).run();
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const reporter = new UsageReporter(db, pino({ level: "silent" }), { apiUrl: "https://example.test", serviceId: "test", serviceKey: "test" });
    expect(await reporter.flush()).toEqual({ sent: 1, failed: 0 });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).events).toEqual([{ eventId: "eligible" }]);
    expect(db.select().from(schema.usageOutbox).all()).toHaveLength(100);
  } finally { db.$client.close(); }
});

it("shares one in-flight batch across timer and shutdown flushes", async () => {
  const db = openDb(":memory:");
  try {
    db.insert(schema.usageOutbox).values({ eventId: "one", payload: { eventId: "one" }, attempts: 0, nextAt: 0, createdAt: 0 }).run();
    let release!: (r: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    const reporter = new UsageReporter(db, pino({ level: "silent" }), { apiUrl: "https://example.test", serviceId: "test", serviceKey: "test" });
    const first = reporter.flush();
    const second = reporter.flush();
    expect(fetcher).toHaveBeenCalledOnce();
    release(new Response('{}'));
    expect(await first).toEqual({ sent: 1, failed: 0 });
    expect(await second).toEqual({ sent: 1, failed: 0 });
    expect(await reporter.flush()).toEqual({ sent: 0, failed: 0 });
  } finally { db.$client.close(); }
});
