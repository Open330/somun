import { afterEach, expect, it, vi } from "vitest";
import { assertPublicUrl, isBlockedAddress, publicFetch, UnsafeUrlError } from "./net.js";

afterEach(() => vi.unstubAllGlobals());
const resolveTo = (address: string) => async () => [{ address }];

it.each(["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"])("blocks %s", (ip) => {
  expect(isBlockedAddress(ip)).toBe(true);
});

it.each(["1.1.1.1", "140.82.112.3", "2606:4700::1111"])("allows %s", (ip) => {
  expect(isBlockedAddress(ip)).toBe(false);
});

it("rejects non-http schemes, credentials, and names that resolve to private addresses", async () => {
  await expect(assertPublicUrl("file:///etc/passwd")).rejects.toBeInstanceOf(UnsafeUrlError);
  await expect(assertPublicUrl("https://user:pw@example.com/")).rejects.toBeInstanceOf(UnsafeUrlError);
  await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data")).rejects.toBeInstanceOf(UnsafeUrlError);
  await expect(assertPublicUrl("https://internal.example/", resolveTo("10.0.0.5"))).rejects.toBeInstanceOf(UnsafeUrlError);
  await expect(assertPublicUrl("https://blog.example/feed", resolveTo("93.184.216.34"))).resolves.toBeInstanceOf(URL);
});

it("re-checks every redirect target", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8790/api/me" } })));
  await expect(publicFetch("https://1.1.1.1/feed")).rejects.toBeInstanceOf(UnsafeUrlError);
});
