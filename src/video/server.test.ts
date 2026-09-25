import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VideoBrief } from "../shared/video.js";
import { parseBridgeTokens, videoServer } from "./server.js";
import { VideoService, type RendererLike } from "./service.js";

const SERVICE = "service-token-0123456789";
const BRIDGE_A = "bridge-a-0123456789abcd";
const BRIDGE_ANY = "bridge-any-0123456789ab";

const brief: VideoBrief = { project: "muxa", repoUrl: "https://github.com/Open330/muxa", lang: "en", durationSec: 10, aspect: "1:1", headline: "h", facts: "releases: 61", grounding: "releases: 61", voice: "plain", bannedPhrases: [] };

const renderer: RendererLike = {
  async inspect(html) { return { samples: [{ t: 500, text: [html.replace(/<[^>]+>/g, "")], overflow: [] }], errors: [], thumbnails: [{ t: 500, jpeg: Buffer.from("x") }] }; },
  async render(_h, _s, _m, out) { writeFileSync(out, Buffer.from("0123456789")); },
};

function setup() {
  const svc = new VideoService(mkdtempSync(join(tmpdir(), "somun-video-srv-")), renderer, { model: "opus", sessionTimeoutSec: 600 });
  const app = videoServer(svc, { serviceToken: SERVICE, bridgeTokens: parseBridgeTokens(`owner-a=${BRIDGE_A},${BRIDGE_ANY}`) });
  const as = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
  return { app, as };
}

const rpc = (method: string, params?: unknown, id: number | null = 1) => JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params });

describe("parseBridgeTokens", () => {
  it("reads owner=token pairs and a bare token as any owner", () => {
    expect(parseBridgeTokens("a=x, y")).toEqual([{ owner: "a", token: "x" }, { owner: "*", token: "y" }]);
  });
});

describe("video server", () => {
  it("requires the service token for renders and validates the brief", async () => {
    const { app, as } = setup();
    expect((await app.request("/v1/renders", { method: "POST", headers: as(BRIDGE_A), body: JSON.stringify({ owner: "a", brief }) })).status).toBe(401);
    expect((await app.request("/v1/renders", { method: "POST", headers: as(SERVICE), body: JSON.stringify({ owner: "a", brief: { ...brief, durationSec: 30 } }) })).status).toBe(400);
    expect((await app.request("/v1/renders", { method: "POST", headers: as(SERVICE), body: JSON.stringify({ owner: "a", brief }) })).status).toBe(201);
  });

  it("hands a render only to a bridge of the same owner, then serves tools and the video", async () => {
    const { app, as } = setup();
    const created = await (await app.request("/v1/renders", { method: "POST", headers: as(SERVICE), body: JSON.stringify({ owner: "owner-b", brief }) })).json() as { id: string };
    expect((await app.request("/v1/sessions/next", { headers: as(BRIDGE_A) })).status).toBe(204);
    expect((await app.request("/v1/sessions/next", { headers: as(SERVICE) })).status).toBe(401);
    const ticket = await (await app.request("/v1/sessions/next?bridge=test", { headers: as(BRIDGE_ANY) })).json() as { token: string; renderId: string };
    expect(ticket.renderId).toBe(created.id);

    const mcp = (body: string, token = ticket.token) => app.request("/mcp", { method: "POST", headers: as(token), body });
    const init = await (await mcp(rpc("initialize", { protocolVersion: "2025-06-18" }))).json() as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect((await mcp(rpc("notifications/initialized", undefined, null))).status).toBe(202);
    const tools = await (await mcp(rpc("tools/list"))).json() as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map((t) => t.name)).toEqual(["check_scene", "render_video"]);

    const denied = await (await mcp(rpc("tools/call", { name: "check_scene", arguments: { html: "<p>61</p>" } }), "not-a-session")).json() as { error: { code: number } };
    expect(denied.error.code).toBe(-32001);
    expect(((await (await mcp(rpc("tools/list"), "not-a-session")).json()) as { error?: unknown }).error).toBeDefined();
    // 배치로 도구 호출을 여럿 실을 수 없다.
    expect(((await (await mcp(JSON.stringify([JSON.parse(rpc("tools/list")), JSON.parse(rpc("ping", undefined, 2))]))).json()) as { error: { message: string } }).error.message).toMatch(/batch/);
    const check = await (await mcp(rpc("tools/call", { name: "check_scene", arguments: { html: "<p>61 releases</p>" } }))).json() as { result: { content: { type: string; text?: string }[] } };
    const summary = JSON.parse(check.result.content[0].text!) as { scene_id: string; renderable: boolean };
    expect(summary.renderable).toBe(true);
    expect(check.result.content.some((c) => c.type === "image")).toBe(true);
    const render = await (await mcp(rpc("tools/call", { name: "render_video", arguments: { scene_id: summary.scene_id } }))).json() as { result: { isError?: boolean } };
    expect(render.result.isError).toBeUndefined();

    const finish = await app.request("/v1/sessions/finish", { method: "POST", headers: as(ticket.token), body: JSON.stringify({ note: "none" }) });
    expect(((await finish.json()) as { status: string }).status).toBe("done");

    const full = await app.request(`/v1/renders/${created.id}/video`, { headers: as(SERVICE) });
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(await full.text()).toBe("0123456789");
    const part = await app.request(`/v1/renders/${created.id}/video`, { headers: { ...as(SERVICE), Range: "bytes=2-4" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(await part.text()).toBe("234");
    expect((await app.request(`/v1/renders/${created.id}/video`, { headers: { ...as(SERVICE), Range: "bytes=20-" } })).status).toBe(416);
    expect((await app.request(`/v1/renders/${created.id}/video`, { headers: as(BRIDGE_ANY) })).status).toBe(401);
  });
});
