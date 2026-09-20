import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// 매일 09:00 KST = 00:00 UTC. 수집 → (수집 액션 안에서) 판단·초안까지 이어진다.
crons.daily("collect all sources", { hourUTC: 0, minuteUTC: 0 }, internal.collect.runAll, {});

export default crons;
