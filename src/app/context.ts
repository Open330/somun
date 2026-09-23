import { EventEmitter } from "node:events";
import type { Db } from "../infra/db/index.js";
import type { Logger } from "../infra/logger.js";
import type { ChangeEvent } from "../shared/types.js";
import type { UsageReporter } from "../infra/usage.js";

/** 유스케이스가 받는 실행 문맥. HTTP·크론·스크립트 어디서 부르든 같다. */
export type AppContext = {
  db: Db;
  log: Logger;
  env: {
    githubToken?: string; geminiKeys?: string; publicUrl?: string;
    /** 서버 GITHUB_TOKEN으로 비공개 저장소까지 읽을 수 있는 소유자. 비우면 제한 없음(단일 사용자 배포). 목록 밖 소유자는 공개 저장소만 읽는다. */
    githubTokenOwners?: string[];
  };
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
