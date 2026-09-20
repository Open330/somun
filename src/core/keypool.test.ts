import { describe, expect, it } from "vitest";
import { classifyGeminiError, nextPtMidnight, ptDayKey } from "./keypool.js";

describe("keypool", () => {
  it("day quota cools down until PT midnight", () => {
    const now = Date.UTC(2026, 8, 20, 10, 0, 0); // 03:00 PT
    const c = classifyGeminiError(429, JSON.stringify({ error: { details: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", retryDelay: "3600s" }] } }), now);
    expect(c.reason).toBe("quota:day");
    expect(ptDayKey(c.cooldownUntil)).not.toBe(ptDayKey(now));
    expect(c.cooldownUntil - now).toBeLessThanOrEqual(24 * 3600 * 1000);
  });
  it("minute quota uses retryDelay", () => {
    const now = 1_000_000;
    const c = classifyGeminiError(429, '{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel","retryDelay":"12s"}', now);
    expect(c.reason).toBe("quota:minute");
    expect(c.cooldownUntil).toBe(now + 12_000);
  });
  it("invalid key cools for an hour", () => {
    expect(classifyGeminiError(403, "", 0).cooldownUntil).toBe(3_600_000);
  });
  it("5xx never cools a key down", () => {
    expect(classifyGeminiError(503, "high demand", 1000).cooldownUntil).toBe(1000);
  });
  it("nextPtMidnight lands on the next day", () => {
    const now = Date.UTC(2026, 8, 20, 10, 0, 0);
    expect(ptDayKey(nextPtMidnight(now))).toBe("2026-09-21");
    expect(ptDayKey(nextPtMidnight(now) - 60_000)).toBe("2026-09-20");
  });
});
