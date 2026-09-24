import { afterEach, expect, it, vi } from "vitest";
import { appManifest, authorizedGithubUser } from "./app.js";

afterEach(() => vi.unstubAllGlobals());
const cfg = { appId: "1", privateKeyPem: "", clientId: "Iv1.x", clientSecret: "s" };

it("exchanges the install code for the GitHub user and revokes the user token afterwards", async () => {
  const calls: { url: string; method?: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method });
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      expect(JSON.parse(String(init?.body))).toEqual({ client_id: "Iv1.x", client_secret: "s", code: "c" });
      return new Response(JSON.stringify({ access_token: "ghu_x" }));
    }
    if (url === "https://api.github.com/user") return new Response(JSON.stringify({ id: 42, login: "alice" }));
    return new Response(null, { status: 204 });
  }));
  expect(await authorizedGithubUser(cfg, "c")).toEqual({ id: 42, login: "alice" });
  await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/applications/Iv1.x/token"))).toBe(true));
});

it("fails closed on a bad code or missing client credentials", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "bad_verification_code" }))));
  expect(await authorizedGithubUser(cfg, "bad")).toBeNull();
  expect(await authorizedGithubUser({ appId: "1", privateKeyPem: "" }, "c")).toBeNull();
});

it("asks GitHub to authorize the user during installation, without the setup URL it disables", () => {
  const m = appManifest("https://somun.test");
  expect(m).toMatchObject({ request_oauth_on_install: true, callback_urls: ["https://somun.test/github/setup"] });
  expect(m).not.toHaveProperty("setup_url");
});
