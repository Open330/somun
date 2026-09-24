import { afterEach, expect, it, vi } from "vitest";
import { assertPublicUrl, guardedLookup, isBlockedAddress, isBlockedError, publicFetch, UnsafeUrlError } from "./net.js";

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

it("rejects a literal private address before any request is made", async () => {
  await expect(publicFetch("http://127.0.0.1:8790/api/me")).rejects.toBeInstanceOf(UnsafeUrlError);
});

it.each(["::ffff:7f00:1", "::ffff:a9fe:a9fe", "::7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "2002:a9fe:a9fe::1", "2001:db8::1"])("blocks IPv4-embedding IPv6 form %s", (ip) => {
  expect(isBlockedAddress(ip)).toBe(true);
});

it("rejects bracketed IPv6 literals that the URL parser rewrites to hex", async () => {
  for (const u of ["http://[::ffff:127.0.0.1]:8790/api/me", "http://[::ffff:a9fe:a9fe]/latest/meta-data", "http://[::127.0.0.1]/"]) {
    await expect(assertPublicUrl(u)).rejects.toBeInstanceOf(UnsafeUrlError);
  }
});

it("allows public hosts in 192.0.0.0/16 such as WordPress.com, and 6to4 of a public address", () => {
  expect(isBlockedAddress("192.0.78.9")).toBe(false);
  expect(isBlockedAddress("2002:0101:0101::1")).toBe(false);
  expect(isBlockedAddress("192.0.2.10")).toBe(true);
});

it("refuses the connection when the name resolves to a blocked address at connect time", async () => {
  const result = await new Promise<{ err: NodeJS.ErrnoException | null }>((resolve) => guardedLookup("localhost", { all: true }, (err) => resolve({ err })));
  expect(result.err?.code).toBe("EBLOCKED");
  expect(isBlockedError(new TypeError("fetch failed", { cause: result.err }))).toBe(true);
});
