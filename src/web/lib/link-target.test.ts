import { expect, it } from "vitest";
import type { Draft } from "@shared/types";
import { linkTargets } from "./link-target";

type V = Pick<Draft, "id" | "version" | "status" | "purpose">;
const v = (version: number, status: Draft["status"], purpose?: Draft["purpose"]): V => ({ id: version * 10, version, status, purpose });
const newestFirst = (...vs: V[]) => [...vs].sort((a, b) => b.version - a.version);

it("defaults to the copy after a same-purpose redraft", () => {
  const v1 = v(1, "copied", "update"),
    v2 = v(2, "proposed", "update");
  expect(linkTargets(v2, newestFirst(v1, v2), new Set())).toEqual({ options: [v1, v2], defaultId: v1.id });
});

it("still defaults to the copy when the newer version has another purpose", () => {
  const v1 = v(1, "copied", "introduction"),
    v2 = v(2, "proposed", "update");
  expect(linkTargets(v2, newestFirst(v1, v2), new Set())?.defaultId).toBe(v1.id);
});

it("offers the newest unposted copy of each purpose and prefers the latest version's purpose", () => {
  const v1 = v(1, "copied", "update"),
    v2 = v(2, "copied", "introduction"),
    v3 = v(3, "proposed", "update");
  const r = linkTargets(v3, newestFirst(v1, v2, v3), new Set());
  expect(r?.options.map((o) => o.version)).toEqual([2, 1, 3]);
  expect(r?.defaultId).toBe(v1.id);
});

it("treats a legacy draft without a purpose as an update", () => {
  const v1 = v(1, "copied", undefined),
    v2 = v(2, "proposed", "update"),
    v3 = v(3, "copied", "introduction");
  expect(linkTargets(v2, newestFirst(v1, v2), new Set())?.defaultId).toBe(v1.id);
  expect(linkTargets(v(4, "proposed", "update"), newestFirst(v1, v2, v3, v(4, "proposed", "update")), new Set())?.defaultId).toBe(v1.id);
});

it("ignores copies superseded by a posted version of the same purpose", () => {
  const v1 = v(1, "copied", "introduction"),
    v2 = v(2, "copied", "update"),
    v3 = v(3, "edited", "introduction"),
    v4 = v(4, "proposed", "update");
  const r = linkTargets(v4, newestFirst(v1, v2, v3, v4), new Set([v3.id]));
  expect(r?.options.map((o) => o.version)).toEqual([2, 4]);
});

it("offers nothing when the latest version is copied or posted, or no copy is waiting", () => {
  const v1 = v(1, "copied", "update");
  expect(linkTargets(v(2, "copied", "update"), newestFirst(v1, v(2, "copied", "update")), new Set())).toBeNull();
  expect(linkTargets(v(2, "proposed", "update"), newestFirst(v1, v(2, "proposed", "update")), new Set([20]))).toBeNull();
  expect(linkTargets(v(2, "proposed", "update"), newestFirst(v1, v(2, "proposed", "update")), new Set([v1.id]))).toBeNull();
});
