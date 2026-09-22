import { join } from "node:path";
import { openDb } from "./index.js";

// 서버를 실행하거나 인증 설정을 요구하지 않고 SQL 마이그레이션만 적용한다.
const file = join(process.env.DATA_DIR ?? "./data", "somun.db");
const db = openDb(file);
db.$client.close();
console.log(`Migrations applied: ${file}`);
