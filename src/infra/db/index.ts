import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

/**
 * SQLite 연결. WAL 모드, 외래키 켬. ":memory:"는 테스트용.
 * 마이그레이션은 drizzle/ 폴더의 SQL을 시작 시 적용한다 (drizzle-kit generate로 생성).
 */
export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
  migrate(db, { migrationsFolder });
  return db;
}

export { schema };
