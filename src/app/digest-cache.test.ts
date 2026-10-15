import { expect, it } from "vitest";
import { digestSourceHash } from "./digest-cache.js";

const source = { repo: "me/tool", repoUrl: "https://github.com/me/tool", releaseNotes: "Adds a capped allowance.", mergedPrDetails: [{ number: 1, title: "Allowance", body: "Only free accounts; disabled accounts are excluded.", url: "https://github.com/me/tool/pull/1" }] };

it("ignores generated summaries, legacy briefs and digest limitations", () => {
  expect(digestSourceHash({ ...source, highlights: ["A generated claim"], highlightsAt: 100, digestRevision: "old", digestSourceHash: "old hash", writingBrief: { requiredConditions: ["Old experiment"] }, unverifiedHighlights: [], limitations: ["A generated caveat"], limitationsSource: "digest" })).toBe(digestSourceHash(source));
});

it("keeps README limitations in the source fingerprint", () => {
  expect(digestSourceHash({ ...source, limitations: ["Requires an account"], limitationsSource: "readme" })).not.toBe(digestSourceHash(source));
  expect(digestSourceHash({ ...source, limitations: ["Requires an account"] })).toBe(digestSourceHash({ ...source, limitations: ["Requires an account"], limitationsSource: "readme" }));
});

it("detects changed PR conditions and later correcting sources", () => {
  expect(digestSourceHash({ ...source, mergedPrDetails: [{ ...source.mergedPrDetails[0], body: "Only paid accounts." }] })).not.toBe(digestSourceHash(source));
  expect(digestSourceHash({ ...source, mergedPrDetails: [{ number: 2, title: "Revert", body: "Reverts the allowance", url: "https://github.com/me/tool/pull/2" }, ...source.mergedPrDetails] })).not.toBe(digestSourceHash(source));
});

it("does not change merely because JSON object keys were serialized differently", () => {
  expect(digestSourceHash({ mergedPrDetails: source.mergedPrDetails.map(({ number, title, body, url }) => ({ url, body, title, number })), releaseNotes: source.releaseNotes, repoUrl: source.repoUrl, repo: source.repo })).toBe(digestSourceHash(source));
});
