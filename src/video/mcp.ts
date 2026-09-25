import { MAX_SCENE_BYTES, VideoError, type VideoService } from "./service.js";

/**
 * 연출 모델이 부르는 도구(MCP, Streamable HTTP의 JSON 응답 방식). 세션 토큰 하나가 렌더 하나에 묶인다.
 * 필요한 메서드만 구현한다: initialize, tools/list, tools/call, ping. 알림은 202로 받는다.
 */
type RpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };
type RpcResponse = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const TOOLS = [
  {
    name: "check_scene",
    description: "Load the HTML film under the virtual clock and report the text visible at each sampled second, script errors, blocked requests, and problems (numbers not in the facts, banned phrases, exclamation marks, text outside the frame), plus a few frames. Returns a scene_id. A scene with no blocking problems can be rendered.",
    inputSchema: { type: "object", properties: { html: { type: "string", description: `The complete HTML document (at most ${MAX_SCENE_BYTES} bytes).` } }, required: ["html"], additionalProperties: false },
  },
  {
    name: "render_video",
    description: "Render a scene that passed check_scene to the final MP4. Call this once, with the scene_id of the last clean check.",
    inputSchema: { type: "object", properties: { scene_id: { type: "string" } }, required: ["scene_id"], additionalProperties: false },
  },
];

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

async function callTool(service: VideoService, token: string, name: string, args: Record<string, unknown>): Promise<{ content: Content[]; isError?: boolean }> {
  try {
    if (name === "check_scene") {
      if (typeof args.html !== "string" || !args.html.trim()) throw new VideoError("html is required");
      const r = await service.checkScene(token, args.html);
      const summary = {
        scene_id: r.sceneId,
        renderable: r.clean,
        problems: r.problems.map((p) => `${p.kind}: ${p.detail}`),
        visible_text: r.visible.map((v) => `${(v.t / 1000).toFixed(1)}s ${v.text.join(" | ") || "(nothing)"}`),
      };
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 1) }, ...r.thumbnails.map((th): Content => ({ type: "image", data: th.jpeg.toString("base64"), mimeType: "image/jpeg" }))] };
    }
    if (name === "render_video") {
      if (typeof args.scene_id !== "string") throw new VideoError("scene_id is required");
      const r = await service.renderScene(token, args.scene_id);
      return { content: [{ type: "text", text: `Rendered ${r.seconds}s video. Now reply with the short note and stop.` }] };
    }
    throw new VideoError(`unknown tool ${name}`);
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

async function handle(service: VideoService, token: string, req: RpcRequest): Promise<RpcResponse | null> {
  const id = req.id ?? null;
  if (req.id === undefined) return null; // 알림
  switch (req.method) {
    case "initialize":
      return { jsonrpc: "2.0", id, result: { protocolVersion: (req.params?.protocolVersion as string) ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "somun-video", version: "0.1.0" } } };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call":
      return { jsonrpc: "2.0", id, result: await callTool(service, token, String(req.params?.name ?? ""), (req.params?.arguments as Record<string, unknown>) ?? {}) };
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${req.method}` } };
  }
}

/** 요청 본문(단건 또는 배치) → 응답. 응답할 것이 없으면(알림만) null. */
export async function handleMcp(service: VideoService, token: string, body: unknown): Promise<RpcResponse | RpcResponse[] | null> {
  const bad = (m: string): RpcResponse => ({ jsonrpc: "2.0", id: null, error: { code: -32600, message: m } });
  const one = (x: unknown) => (x && typeof x === "object" && typeof (x as RpcRequest).method === "string" ? handle(service, token, x as RpcRequest) : Promise.resolve(bad("invalid request")));
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(one))).filter((x): x is RpcResponse => x !== null);
    return out.length ? out : null;
  }
  return one(body);
}
