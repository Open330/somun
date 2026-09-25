import { EventEmitter } from "node:events";
import type { Db } from "../infra/db/index.js";
import type { Logger } from "../infra/logger.js";
import type { ChangeEvent } from "../shared/types.js";
import type { UsageReporter } from "../infra/usage.js";
import type { SecretBox } from "../infra/secrets.js";
import type { VideoClient } from "../infra/video.js";

/** 유스케이스가 받는 실행 문맥. HTTP·크론·스크립트 어디서 부르든 같다. */
export type AppContext = {
  db: Db;
  log: Logger;
  env: {
    githubToken?: string; geminiKeys?: string; publicUrl?: string;
    /**
     * 서버의 특권 자원을 쓸 수 있는 소유자(운영자). 비우면 제한 없음(단일 사용자 배포).
     * 목록 밖 소유자는 서버 GITHUB_TOKEN으로 공개 저장소만 읽고, 사설망 주소(피드·모델 baseUrl)로 요청할 수 없고, 서버 키 풀 상태를 보지 못한다.
     */
    trustedOwners?: string[];
    /** DB에 저장하는 비밀값 암호화. 없으면 평문. */
    secrets?: SecretBox;
    /** 영상 서버. 없으면 영상 기능이 꺼진다. */
    video?: VideoClient;
  };
  bus: EventEmitter;
  usage: UsageReporter;
};

/** 운영자 권한(서버 토큰의 비공개 저장소, 사설망 주소, 키 풀 상태)을 쓸 수 있는가. */
export function isTrusted(ctx: AppContext, ownerId: string): boolean {
  return ctx.env.trustedOwners === undefined || ctx.env.trustedOwners.includes(ownerId);
}

export function emit(ctx: AppContext, ownerId: string, ev: ChangeEvent): void {
  ctx.bus.emit("change", { ownerId, ...ev });
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
  }
}

export class GenerationConflictError extends Error {}

/** 인증은 됐지만 이 작업을 할 권한이 없다(403). */
export class ForbiddenError extends Error {}

/** 바깥 서비스(영상 서버)에 닿지 못했다(503). */
export class UnavailableError extends Error {}
