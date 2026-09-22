import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolve } from "node:path";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/**
 * SQLite 연결. WAL 모드, 외래키 켬. ":memory:"는 테스트용.
 * 마이그레이션은 작업 디렉터리의 drizzle/ SQL을 시작 시 적용한다 (drizzle-kit generate로 생성).
 */
export function openDb(file: string, migrationsDir = process.env.MIGRATIONS_DIR ?? "drizzle"): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  // 개발(tsx)과 빌드(dist/) 어디서 실행하든 작업 디렉터리 기준 drizzle/ 를 쓴다.
  migrate(db, { migrationsFolder: resolve(migrationsDir) });
  return db;
}

export { schema };
