import { z } from "zod";

/** 환경변수 → 검증된 설정 객체. 잘못된 값은 기동 시점에 실패한다. */
const schema = z.object({
  PORT: z.coerce.number().default(8790),
  DATA_DIR: z.string().default("./data"),
  LOG_LEVEL: z.string().default("info"),
  SOMUN_ALLOW_ANONYMOUS: z.enum(["true", "false"]).default("false"),
  SOMUN_TOKEN: z.string().optional(),
  /** 토큰 요청이 대행할 소유자. 운영자 한 명이 OAuth로 쓰는 배포에서 스크립트·워커가 같은 데이터를 보게 한다. 비우면 "local". */
  SOMUN_TOKEN_OWNER_ID: z.string().optional(),
  /** 알림 링크에 쓰는 공개 주소. */
  SOMUN_PUBLIC_URL: z.string().url().optional(),
  AUTH_ISSUER: z.string().url().optional(),
  AUTH_JWKS_URL: z.string().url().optional(),
  AUTH_AUDIENCE: z.string().default("somun"),
  GITHUB_TOKEN: z.string().optional(),
  GEMINI_API_KEYS: z.string().optional(),
  /** UTC cron. 기본 00:00 UTC = 09:00 KST */
  CRON: z.string().default("0 0 * * *"),
  WEB_DIST: z.string().default("./dist/web"),
  /** jiun-api 사용량 보고. 키가 없으면 보고하지 않는다 (로컬 개발). */
  JIUN_API_URL: z.string().url().default("https://api.jiun.dev"),
  JIUN_USAGE_SERVICE_ID: z.string().default("somun"),
  JIUN_USAGE_KEY: z.string().optional(),
});

export type Config = z.infer<typeof schema> & { dbFile: string; anonymous: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  if (parsed.SOMUN_ALLOW_ANONYMOUS !== "true" && !parsed.SOMUN_TOKEN && !parsed.AUTH_JWKS_URL) {
    throw new Error("인증 방식이 없습니다. SOMUN_ALLOW_ANONYMOUS=true, SOMUN_TOKEN, 또는 AUTH_JWKS_URL 중 하나가 필요합니다.");
  }
  return { ...parsed, dbFile: `${parsed.DATA_DIR}/somun.db`, anonymous: parsed.SOMUN_ALLOW_ANONYMOUS === "true" };
}
