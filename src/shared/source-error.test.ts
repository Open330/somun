import { expect, it } from "vitest";
import { sourceError } from "./source-error.js";

it("separates partial permission and skipped repositories from generic failures", () => {
  expect(sourceError("GitHub permission missing: a/b (pull requests); a/c (contents)")).toEqual({ kind: "permission", detail: "a/b (pull requests); a/c (contents)" });
  expect(sourceError("GitHub repositories skipped (private): a/secret")).toEqual({ kind: "skipped", detail: "a/secret" });
  expect(sourceError("GitHub repository unavailable: a/b").kind).toBe("access");
});
