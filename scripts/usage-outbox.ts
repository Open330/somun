/** Local operator tool. Never prints usage payloads or credentials. */
import Database from "better-sqlite3";
import { resolve } from "node:path";

const [action = "status", eventId] = process.argv.slice(2);
if (!["status", "retry"].includes(action) || (action === "retry" && !eventId)) {
  throw new Error("Usage: npm run usage:outbox -- status | retry <eventId>");
}
const db = new Database(resolve(process.env.DATA_DIR ?? "./data", "somun.db"), { fileMustExist: true, readonly: action === "status" });
try {
  db.pragma("busy_timeout = 5000");
  if (action === "retry") {
    const result = db.prepare("UPDATE usage_outbox SET attempts = 0, next_at = ?, last_error = NULL WHERE event_id = ? AND attempts >= 20").run(Date.now(), eventId);
    console.log(JSON.stringify({ requeued: result.changes }));
  } else {
    console.log(JSON.stringify({
      counts: db.prepare("SELECT CASE WHEN attempts >= 20 THEN 'exhausted' ELSE 'pending' END AS status, count(*) AS count FROM usage_outbox GROUP BY status").all(),
      exhausted: db.prepare("SELECT event_id, attempts, created_at FROM usage_outbox WHERE attempts >= 20 ORDER BY created_at LIMIT 100").all(),
    }, null, 2));
  }
} finally { db.close(); }
