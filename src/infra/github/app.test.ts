import { afterEach, expect, it, vi } from "vitest";
import { appManifest, userCanAccessInstallation } from "./app.js";

afterEach(() => vi.unstubAllGlobals());
const cfg = { appId: "1", privateKeyPem: "", clientId: "Iv1.x", clientSecret: "s" };

it("exchanges the install code for a user token and looks for the installation among that user's installations", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      expect(JSON.parse(String(init?.body))).toEqual({ client_id: "Iv1.x", client_secret: "s", code: "c" });
      return new Response(JSON.stringify({ access_token: "ghu_x" }));
    }
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer ghu_x");
    return new Response(JSON.stringify({ installations: [{ id: 3 }, { id: 7 }] }));
  }));
  expect(await userCanAccessInstallation(cfg, "c", 7)).toBe(true);
  expect(await userCanAccessInstallation(cfg, "c", 99)).toBe(false);
  expect(calls.filter((u) => u.includes("/user/installations"))).toHaveLength(2);
});

it("fails closed on a bad code or missing client credentials", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "bad_verification_code" }))));
  expect(await userCanAccessInstallation(cfg, "bad", 7)).toBe(false);
  expect(await userCanAccessInstallation({ appId: "1", privateKeyPem: "" }, "c", 7)).toBe(false);
});

it("asks GitHub to authorize the user during installation", () => {
  expect(appManifest("https://somun.test")).toMatchObject({ request_oauth_on_install: true, callback_urls: ["https://somun.test/github/setup"] });
});
