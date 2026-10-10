import { readFileSync } from "node:fs";
import { summarizeStudy } from "../src/experiments/user-study.js";
const file = process.argv[2];
if (!file || process.argv.length !== 3) throw new Error("사용법: npx tsx scripts/user-study.ts <평가.json>");
console.log(JSON.stringify(summarizeStudy(JSON.parse(readFileSync(file, "utf8"))), null, 2));
