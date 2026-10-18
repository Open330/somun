import { sourceConditionParagraphs, type EvidenceLike, type ProfileLike } from "./prompts.js";

export type ConditionSource = { kind: "readme" | "release" | "pr" | "profile"; ref: string; text: string; url?: string; incomplete?: boolean };

const REVIEW_ONLY_CONDITION = /\buntil\b|fail[- ]open|\b(?:when|if)\b[^.!?\n]{0,80}\b(?:enabled|configured|disabled|available|purchasable)\b|활성화|설정해야/i;

/** 검토 전용 탐지. 생성 프롬프트의 발췌 정책은 변경하지 않는다. */
export function reviewConditionParagraphs(text: string): string[] {
  return text.split(/\r?\n[\t ]*\r?\n/).filter((paragraph) => sourceConditionParagraphs(paragraph).length > 0 || REVIEW_ONLY_CONDITION.test(paragraph));
}

/** 원자료와 유효 프로필 제약. 생성된 highlights는 확인 근거로 쓰지 않는다. */
export function conditionSources(e: EvidenceLike & { limitationsSource?: "readme" | "digest" }, profile?: ProfileLike): ConditionSource[] {
  const sources: ConditionSource[] = [];
  const readme = [e.readmeForChecks, e.readmeExcerpt].find((text) => text?.trim());
  if (readme) sources.push({ kind: "readme", ref: "README", text: readme, url: e.repoUrl });
  for (const release of e.windowReleaseNotes ?? []) sources.push({ kind: "release", ref: release.tag, text: release.notes, url: e.repoUrl });
  if (e.releaseNotes && !sources.some((source) => source.kind === "release" && source.text === e.releaseNotes)) sources.push({ kind: "release", ref: e.version ?? "", text: e.releaseNotes, url: e.repoUrl });
  for (const pr of e.mergedPrDetails ?? []) sources.push({ kind: "pr", ref: `#${pr.number} ${pr.title}`, text: pr.body, url: pr.url, incomplete: pr.bodyTruncated || !pr.body.trim() });
  if (profile?.limitations.length) sources.push({ kind: "profile", ref: "", text: profile.limitations.join("\n\n") });
  if (e.limitationsSource === "readme" && e.limitations?.length) sources.push({ kind: "readme", ref: "", text: e.limitations.join("\n\n"), url: e.repoUrl });
  return sources;
}

/** 보조 후보이며 완전한 조건 탐지나 의미 판정이 아니다. */
export function conditionCandidates(sources: ConditionSource[]) {
  return sources.map(({ text, ...source }) => ({ ...source, excerpts: source.kind === "profile" ? text.split(/\r?\n[\t ]*\r?\n/).filter((paragraph) => paragraph.trim()) : reviewConditionParagraphs(text) }))
    .filter((source) => source.incomplete || source.excerpts.length > 0);
}
