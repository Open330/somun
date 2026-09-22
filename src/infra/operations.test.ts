import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { openDb, schema } from "./db/index.js";

it("backs up without overwriting and requeues only the requested exhausted event", () => {
  const dir = mkdtempSync(join(tmpdir(), "somun-ops-"));
  const db = openDb(join(dir, "somun.db"));
  const run = (script: string, ...args: string[]) => execFileSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), `scripts/${script}.ts`, ...args], { env: { ...process.env, DATA_DIR: dir }, encoding: "utf8", stdio: "pipe" });
  try {
    db.insert(schema.usageOutbox).values([
      { eventId: "failed", payload: { secret: "not-for-output" }, attempts: 20, nextAt: 0, createdAt: 0 },
      { eventId: "pending", payload: {}, attempts: 1, nextAt: 0, createdAt: 0 },
    ]).run();
    const status = run("usage-outbox", "status");
    expect(status).toContain("failed"); expect(status).not.toContain("not-for-output");
    expect(JSON.parse(run("usage-outbox", "retry", "pending"))).toEqual({ requeued: 0 });
    expect(JSON.parse(run("usage-outbox", "retry", "failed"))).toEqual({ requeued: 1 });
    expect(db.select().from(schema.usageOutbox).all().map((r) => [r.eventId, r.attempts])).toEqual([["failed", 0], ["pending", 1]]);
    const backup = join(dir, "backup.db");
    run("backup-db", backup);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(() => run("backup-db", backup)).toThrow();
    const restored = openDb(backup);
    try { expect(restored.select().from(schema.usageOutbox).all()).toHaveLength(2); } finally { restored.$client.close(); }
  } finally { db.$client.close(); rmSync(dir, { recursive: true, force: true }); }
}, 20_000);
