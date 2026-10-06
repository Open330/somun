import { Cron } from "croner";
import { collectAll } from "./collect.js";
import type { AppContext } from "./context.js";
import { processNewCandidates } from "./pipeline.js";
import { sendWeeklySummaries } from "./notify.js";
import { refreshReactions } from "./reactions.js";
import { pruneFinishedJobs } from "./jobs.js";
import { pruneInstallRecords } from "./connectors.js";

/** 예약 작업의 한 단계. 실패는 기록하고 넘어간다: 한 단계의 예외가 다음 단계를 건너뛰게 하거나 프로세스를 내리면 안 된다. */
export async function step(ctx: AppContext, name: string, run: () => Promise<void> | void): Promise<void> {
  try { await run(); }
  catch (err) { ctx.log.error({ step: name, err: err instanceof Error ? err.message : String(err) }, "scheduled step failed"); }
}

/** 매일 수집 → (수집 안에서) 다이제스트·판단·초안. 기본 00:00 UTC = 09:00 KST. */
export function startScheduler(ctx: AppContext, pattern: string): { stop: () => void } {
  const daily = new Cron(pattern, { protect: true, timezone: "UTC" }, async () => {
    await step(ctx, "collect", async () => {
      ctx.log.info("scheduled collect start");
      const r = await collectAll(ctx);
      ctx.log.info({ sources: Object.keys(r).length }, "scheduled collect done");
    });
    await step(ctx, "reactions", async () => {
      const k = await refreshReactions(ctx);
      if (k) ctx.log.info({ n: k }, "reactions refreshed");
    });
    await step(ctx, "prune", () => {
      const pruned = pruneFinishedJobs(ctx) + pruneInstallRecords(ctx);
      if (pruned) ctx.log.info({ n: pruned }, "finished job prompts and install records pruned");
    });
  });
  // 쿼터에 막혀 남은 new 후보를 매시간 다시 태운다 (키 쿨다운이 풀리면 이어진다).
  const sweep = new Cron("7 * * * *", { protect: true, timezone: "UTC" }, () => step(ctx, "sweep", async () => {
    const n = await processNewCandidates(ctx);
    if (n) ctx.log.info({ n }, "hourly sweep processed new candidates");
  }));
  // 월요일 09:00 KST = 일요일 24:00 UTC. 주간 요약.
  const weekly = new Cron("0 0 * * 1", { protect: true, timezone: "UTC" }, () => step(ctx, "weekly", async () => {
    const n = await sendWeeklySummaries(ctx);
    if (n) ctx.log.info({ n }, "weekly summaries sent");
  }));
  return { stop: () => { daily.stop(); sweep.stop(); weekly.stop(); } };
}
