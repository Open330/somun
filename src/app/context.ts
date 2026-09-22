import { EventEmitter } from "node:events";
import type { Db } from "../infra/db/index.js";
import type { Logger } from "../infra/logger.js";
import type { ChangeEvent } from "../shared/types.js";
import type { UsageReporter } from "../infra/usage.js";

/** 유스케이스가 받는 실행 문맥. HTTP·크론·스크립트 어디서 부르든 같다. */
export type AppContext = {
  db: Db;
  log: Logger;
  env: { githubToken?: string; geminiKeys?: string; publicUrl?: string };
  bus: EventEmitter;
  usage: UsageReporter;
};

export function emit(ctx: AppContext, ownerId: string, ev: ChangeEvent): void {
  ctx.bus.emit("change", { ownerId, ...ev });
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
  }
}

export class GenerationConflictError extends Error {}
