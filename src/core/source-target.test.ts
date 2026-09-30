import { expect, it } from "vitest";
import { normalizeGithubTarget } from "./source-target.js";
import { publicationChannel } from "./publication-url.js";
import { sourceError } from "../shared/source-error.js";

it.each(["Open330/somun", " https://github.com/Open330/somun/ ", "https://github.com/Open330/somun.git"])("normalizes %s to the same repository", (input) => {
  expect(normalizeGithubTarget(input)).toBe("Open330/somun");
});
it.each(["https://github.com.evil.test/a/b", "https://github.com/a/b/tree/main", "https://github.com/a/b?x=1", "a/..", "owner//repo", "", "https://user:pass@github.com/a/b"])("rejects unsupported GitHub input %s", (input) => {
  expect(normalizeGithubTarget(input)).toBeNull();
});
it("preserves owner-wide collection", () => expect(normalizeGithubTarget("Open330")).toBe("Open330"));
it("recognizes channel hosts without mistaking lookalikes or custom domains", () => {
  expect(publicationChannel("https://www.linkedin.com/posts/test")).toBe("linkedin");
  expect(publicationChannel("https://threads.com/@me/post/1")).toBe("threads");
  expect(publicationChannel("https://twitter.com/me/status/1")).toBe("x");
  expect(publicationChannel("https://linkedin.com.evil.test/post")).toBeUndefined();
  expect(publicationChannel("https://my.blog/post")).toBeUndefined();
});
it("classifies legacy collection errors without exposing their raw text", () => {
  expect(sourceError("No GitHub token. Install the GitHub App or set GITHUB_TOKEN.").kind).toBe("auth");
  expect(sourceError("GitHub /repos/me/a → 401").kind).toBe("auth");
  expect(sourceError("GitHub repository unavailable: me/a").kind).toBe("access");
  expect(sourceError("GitHub rate limit hit on /repos/me/a (reset 2026-10-01T00:00:00.000Z)")).toEqual({ kind: "rate", retryAt: "2026-10-01T00:00:00.000Z" });
  expect(sourceError("unrecognized private server response").kind).toBe("unknown");
});
