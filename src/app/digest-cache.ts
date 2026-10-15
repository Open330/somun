import { createHash } from "node:crypto";
import type { Evidence } from "../shared/types.js";

/** 저장된 원자료만 비교한다. windowFacts를 합친 프롬프트나 생성 결과는 입력하지 않는다. */
export function digestSourceHash(evidence: unknown): string {
  const ev = evidence as Evidence;
  const keys = ["repo", "repoUrl", "description", "version", "releaseNotes", "stars", "forks", "commitCount", "releaseCount", "firstReleaseAt", "language", "license", "homepage", "npmPackage", "npmMonthlyDownloads", "demoAsset", "readmeExcerpt", "experimental", "mergedPrTitles", "ompSummary", "commitSubjects", "mergedPrDetails", "milestones", "windowReleaseNotes", "readmeForChecks"] as const satisfies readonly (keyof Evidence)[];
  const source: Record<string, unknown> = Object.fromEntries(keys.map((key) => [key, ev[key]]));
  if (ev.limitationsSource !== "digest" && ev.limitations?.length) source.limitations = ev.limitations;
  const ordered = (v: unknown): unknown => Array.isArray(v) ? v.map(ordered)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, value]) => [k, ordered(value)])) : v;
  return createHash("sha256").update(JSON.stringify(ordered(source))).digest("hex");
}
