import { Cron } from "croner";
import { collectAll } from "./collect.js";
import type { AppContext } from "./context.js";

/** 매일 수집 → (수집 안에서) 다이제스트·판단·초안. 기본 00:00 UTC = 09:00 KST. */
export function startScheduler(ctx: AppContext, pattern: string): Cron {
  return new Cron(pattern, { protect: true, timezone: "UTC" }, async () => {
    ctx.log.info("scheduled collect start");
    const r = await collectAll(ctx);
    ctx.log.info({ sources: Object.keys(r).length }, "scheduled collect done");
  });
}
