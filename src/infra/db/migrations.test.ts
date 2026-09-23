import { mkdtempSync, mkdirSync, readFileSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDb, schema } from "./index.js";

it("upgrades a pre-lease database without losing data and is safe to rerun", () => {
  const dir = mkdtempSync(join(tmpdir(), "somun-upgrade-"));
  const migrations = join(dir, "old-migrations");
  mkdirSync(join(migrations, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 7);
  writeFileSync(join(migrations, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) copyFileSync(`drizzle/${entry.tag}.sql`, join(migrations, `${entry.tag}.sql`));
  const file = join(dir, "somun.db");
  try {
    const old = openDb(file, migrations);
    try {
      old.$client.prepare("INSERT INTO settings (owner_id, data, updated_at) VALUES (?, ?, ?)").run("owner", '{"watch":{"mode":"manual","recentDays":30}}', 1);
      old.$client.prepare("INSERT INTO llm_jobs (owner_id, kind, candidate_id, system, user, schema_json, status, runner, created_at, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("owner", "digest", 1, "system", "user", "{}", "claimed", "old-worker", 1, 1);
    } finally { old.$client.close(); }
    for (let n = 0; n < 2; n++) {
      const db = openDb(file);
      try {
        expect(db.select().from(schema.settings).get()?.ownerId).toBe("owner");
        expect(db.select().from(schema.llmJobs).get()).toMatchObject({ status: "pending", runner: null, claimToken: null, attempts: 0, executor: "local", continuation: null });
        expect(db.$client.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: 11 });
        expect(db.$client.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
        expect(db.$client.pragma("foreign_key_check")).toEqual([]);
      } finally { db.$client.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("keeps the migration schema aligned with the latest generation snapshot", () => {
  const db = openDb(":memory:");
  const snapshot = JSON.parse(readFileSync("drizzle/meta/0010_snapshot.json", "utf8")) as { tables: Record<string, { columns: Record<string, unknown> }> };
  try {
    for (const [name, table] of Object.entries(snapshot.tables)) {
      const columns = db.$client.prepare("SELECT name FROM pragma_table_info(?)").all(name) as { name: string }[];
      expect(columns.map((c) => c.name).sort(), name).toEqual(Object.keys(table.columns).sort());
    }
  } finally { db.$client.close(); }
});

it("restores an online SQLite backup including committed WAL data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "somun-backup-"));
  const source = openDb(join(dir, "source.db"));
  try {
    source.insert(schema.settings).values({ ownerId: "backup-owner", data: { watch: { mode: "manual", recentDays: 30 } }, updatedAt: 123 }).run();
    await source.$client.backup(join(dir, "backup.db"));
    const restored = openDb(join(dir, "backup.db"));
    try {
      expect(restored.select().from(schema.settings).get()?.ownerId).toBe("backup-owner");
      expect(restored.$client.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(restored.$client.pragma("foreign_key_check")).toEqual([]);
    } finally { restored.$client.close(); }
  } finally { source.$client.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("moves the legacy angle suffix out of judgment reasoning when upgrading to 0010", () => {
  const dir = mkdtempSync(join(tmpdir(), "somun-angle-"));
  const migrations = join(dir, "old-migrations");
  mkdirSync(join(migrations, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 10);
  writeFileSync(join(migrations, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) copyFileSync(`drizzle/${entry.tag}.sql`, join(migrations, `${entry.tag}.sql`));
  const file = join(dir, "somun.db");
  try {
    const old = openDb(file, migrations);
    try {
      const insert = old.$client.prepare("INSERT INTO judgments (owner_id, candidate_id, scores, total, reasoning, decision, suggested_channels, model, created_at) VALUES ('o', 1, '{}', 6, ?, 'draft', '[]', 'm', 1)");
      insert.run("올릴 만합니다.\n\n각도: 기다리는 에이전트를 놓치던 문제");
      insert.run("각도가 없는 판단.");
      insert.run("빈 각도.\n\n각도: ");
    } finally { old.$client.close(); }
    const db = openDb(file);
    try {
      expect(db.select({ reasoning: schema.judgments.reasoning, angle: schema.judgments.angle }).from(schema.judgments).all()).toEqual([
        { reasoning: "올릴 만합니다.", angle: "기다리는 에이전트를 놓치던 문제" },
        { reasoning: "각도가 없는 판단.", angle: null },
        { reasoning: "빈 각도.", angle: null },
      ]);
    } finally { db.$client.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
