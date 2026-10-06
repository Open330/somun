import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { AppContext } from "./context.js";
import { step } from "./scheduler.js";

it("logs a failing scheduled step and lets the next step run", async () => {
  const error = vi.fn();
  const ctx = { log: { error, info: vi.fn() }, bus: new EventEmitter() } as unknown as AppContext;
  const ran: string[] = [];
  await step(ctx, "collect", async () => { throw new Error("rate limited"); });
  await step(ctx, "reactions", () => { ran.push("reactions"); });
  expect(ran).toEqual(["reactions"]);
  expect(error).toHaveBeenCalledWith({ step: "collect", err: "rate limited" }, "scheduled step failed");
});
