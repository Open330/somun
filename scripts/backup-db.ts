/** Consistent online SQLite backup, including committed WAL pages. */
import Database from "better-sqlite3";
import { chmodSync, closeSync, openSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const destination = process.argv[2];
if (!destination) throw new Error("Usage: npm run db:backup -- /absolute/path/to/new-backup.db");
const source = resolve(process.env.DATA_DIR ?? "./data", "somun.db");
const target = resolve(destination);
if (source === target) throw new Error("Backup must use a different file");
const db = new Database(source, { readonly: true, fileMustExist: true });
try {
  // Reserve an owner-only destination and refuse to overwrite existing backups.
  closeSync(openSync(target, "wx", 0o600));
  try {
    await db.backup(target);
    chmodSync(target, 0o600);
    console.log(`Backup created: ${target}`);
  } catch (error) { unlinkSync(target); throw error; }
} finally { db.close(); }
