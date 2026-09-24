import { expect, it } from "vitest";
import { SecretBox } from "./secrets.js";

it("seals and opens with the same key, and refuses a wrong or missing key", () => {
  const box = new SecretBox("k1");
  const sealed = box.seal("sk-live-123");
  expect(sealed).toMatch(/^enc:v1:/);
  expect(sealed).not.toContain("sk-live-123");
  expect(box.open(sealed)).toBe("sk-live-123");
  expect(box.seal(sealed)).toBe(sealed);
  expect(() => new SecretBox("k2").open(sealed)).toThrow();
  expect(() => new SecretBox().open(sealed)).toThrow(/SOMUN_SECRET_KEY/);
});

it("passes plaintext through so existing rows keep working", () => {
  expect(new SecretBox("k1").open("plain-value")).toBe("plain-value");
  expect(new SecretBox().seal("plain-value")).toBe("plain-value");
});

it("fails fast at startup when stored secrets cannot be opened with the configured key", async () => {
  const { EventEmitter } = await import("node:events");
  const pino = (await import("pino")).default;
  const { openDb } = await import("./db/index.js");
  const { assertSecretsReadable, updateSettings, getSettings } = await import("../app/settings.js");
  const db = openDb(":memory:");
  const ctx = (box: SecretBox) => ({ db, log: pino({ level: "silent" }), env: { secrets: box }, bus: new EventEmitter(), usage: {} as never });
  updateSettings(ctx(new SecretBox("right-key-123456")), "me", { llm: { provider: "openai", apiKey: "sk-1" } });
  expect(getSettings(ctx(new SecretBox("right-key-123456")), "me").llm.apiKey).toBe("sk-1");
  expect(() => assertSecretsReadable(ctx(new SecretBox("wrong-key-1234567")))).toThrow(/SOMUN_SECRET_KEY/);
  expect(() => assertSecretsReadable(ctx(new SecretBox()))).toThrow(/SOMUN_SECRET_KEY/);
  db.$client.close();
});
