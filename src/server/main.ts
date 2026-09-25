import { serve } from "@hono/node-server";
import { EventEmitter } from "node:events";
import type { AppContext } from "../app/context.js";
import { startGenerationWorker } from "../app/generation-worker.js";
import { startScheduler } from "../app/scheduler.js";
import { openDb } from "../infra/db/index.js";
import { migrateLegacyCandidates } from "../app/candidates.js";
import { backfillLedger } from "../app/ledger.js";
import { assertSecretsReadable, resealSecrets } from "../app/settings.js";
import { resealGithubApp } from "../app/connectors.js";
import { logger } from "../infra/logger.js";
import { UsageReporter } from "../infra/usage.js";
import { SecretBox } from "../infra/secrets.js";
import { VideoClient } from "../infra/video.js";
import { syncBridgeTokens } from "../app/bridges.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const db = openDb(config.dbFile);
const usage = new UsageReporter(db, logger, { apiUrl: config.JIUN_API_URL, serviceId: config.JIUN_USAGE_SERVICE_ID, serviceKey: config.JIUN_USAGE_KEY });
// 여러 사람이 로그인하는 배포(JWT)에서는 서버의 특권 자원(서버 토큰의 비공개 저장소, 사설망 주소, 키 풀 상태)을 운영자에게만 준다.
const trustedOwners = config.AUTH_JWKS_URL
  // 익명(인증 없음) 요청의 "local"은 운영자가 아니다. 공유 토큰을 가진 쪽만 운영자로 본다.
  ? [config.SOMUN_ADMIN_OWNER_ID, config.SOMUN_TOKEN ? config.SOMUN_TOKEN_OWNER_ID || "local" : undefined].filter((x): x is string => Boolean(x))
  : undefined;
const ctx: AppContext = { db, log: logger, env: { githubToken: config.GITHUB_TOKEN, geminiKeys: config.GEMINI_API_KEYS, publicUrl: config.SOMUN_PUBLIC_URL, trustedOwners, secrets: new SecretBox(config.SOMUN_SECRET_KEY), video: config.SOMUN_VIDEO_URL && config.SOMUN_VIDEO_TOKEN ? new VideoClient(config.SOMUN_VIDEO_URL, config.SOMUN_VIDEO_TOKEN, config.SOMUN_VIDEO_PUBLIC_URL ?? config.SOMUN_VIDEO_URL) : undefined }, bus: new EventEmitter(), usage };
// 글감 단위 변경(신호별 → 저장소 × 10일 창). 한 번만 실제로 일한다.
{
  const r = migrateLegacyCandidates(ctx);
  if (r.merged || r.renamed) logger.info(r, "legacy candidates migrated to repo windows");
  const n = backfillLedger(ctx);
  if (n) logger.info({ n }, "change ledger backfilled from existing highlights");
  // 비밀값 암호화: 키가 맞는지 먼저 확인(틀리면 여기서 종료). 키가 있으면 남은 평문을 봉인한다. 키가 없으면 평문으로 저장된다고 알린다.
  assertSecretsReadable(ctx);
  if (ctx.env.secrets?.enabled) {
    const sealed = resealSecrets(ctx) + (resealGithubApp(ctx) ? 1 : 0);
    if (sealed) logger.info({ sealed }, "plaintext secrets encrypted at rest");
  } else logger.warn("SOMUN_SECRET_KEY is not set: API keys and webhook URLs are stored in plaintext");

}
// 못 보낸 사용량은 5분마다 다시 보낸다.
const usageFlush = setInterval(() => void usage.flush(), 5 * 60_000);
// bridge 토큰 목록을 영상 서버와 맞춘다. 폐기할 때 영상 서버에 닿지 않았어도 늦어도 5분 안에 막힌다.
const syncBridges = () => void syncBridgeTokens(ctx).catch((err: Error) => logger.warn({ err: err.message }, "bridge token sync failed"));
if (ctx.env.video) syncBridges();
const bridgeSync = ctx.env.video ? setInterval(syncBridges, 5 * 60_000) : undefined;
ctx.bus.setMaxListeners(100);

const generationWorker = startGenerationWorker(ctx);
const cron = startScheduler(ctx, config.CRON);
const app = createApp(ctx, config);
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info({ port: info.port, db: config.dbFile, cron: config.CRON, auth: config.anonymous ? "anonymous" : config.SOMUN_TOKEN ? "token" : "jwt" }, "somun up");
logger.info({ usage: usage.enabled ? "on" : "off (JIUN_USAGE_KEY unset)" }, "usage reporting");
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    cron.stop();
    clearInterval(usageFlush);
    clearInterval(bridgeSync);
    void generationWorker.stop().then(() => usage.flush()).finally(() => server.close(() => process.exit(0)));
  });
}
