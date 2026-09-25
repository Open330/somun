import { serve } from "@hono/node-server";
import { z } from "zod";
import { logger } from "../infra/logger.js";
import { Renderer } from "./renderer.js";
import { parseBridgeTokens, videoServer } from "./server.js";
import { VideoService } from "./service.js";

/**
 * 영상 서버 진입점. somun과 따로 뜬다(Chromium·ffmpeg가 무거워 somun 이미지와 나눈다).
 *   npm run video-server
 * 모델은 이 서버에서 돌지 않는다: 사용자의 컴퓨터에서 bridge(scripts/video-bridge.ts)가 Claude Code를 띄워 이 서버의 도구를 부른다.
 */
const env = z.object({
  VIDEO_HOST: z.string().default("127.0.0.1"),
  VIDEO_PORT: z.coerce.number().default(8791),
  VIDEO_DATA_DIR: z.string().default("./data/video"),
  VIDEO_SERVICE_TOKEN: z.string().min(16, "VIDEO_SERVICE_TOKEN (somun → video server) must be at least 16 characters"),
  VIDEO_BRIDGE_TOKENS: z.string().min(16, "VIDEO_BRIDGE_TOKENS: a token, or owner=token pairs separated by commas"),
  VIDEO_DIRECTOR_MODEL: z.string().default("opus"),
  VIDEO_SESSION_TIMEOUT_SEC: z.coerce.number().int().min(60).max(3600).default(900),
  FFMPEG_PATH: z.string().optional(),
  CHROMIUM_PATH: z.string().optional(),
}).parse(process.env);

const bridgeTokens = parseBridgeTokens(env.VIDEO_BRIDGE_TOKENS);
if (bridgeTokens.some((b) => b.token.length < 16)) throw new Error("each bridge token must be at least 16 characters");

const renderer = new Renderer({ ffmpegPath: env.FFMPEG_PATH, executablePath: env.CHROMIUM_PATH });
const service = new VideoService(env.VIDEO_DATA_DIR, renderer, { model: env.VIDEO_DIRECTOR_MODEL, sessionTimeoutSec: env.VIDEO_SESSION_TIMEOUT_SEC });
const app = videoServer(service, { serviceToken: env.VIDEO_SERVICE_TOKEN, bridgeTokens });

const server = serve({ fetch: app.fetch, hostname: env.VIDEO_HOST, port: env.VIDEO_PORT }, (info) => logger.info({ host: env.VIDEO_HOST, port: info.port, bridges: bridgeTokens.map((b) => b.owner) }, "video server listening"));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { server.close(); void renderer.close().finally(() => process.exit(0)); });
