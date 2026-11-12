import { sourceConditionParagraphs, type EvidenceLike, type ProfileLike } from "./prompts.js";

export type ConditionSource = { kind: "readme" | "homepage" | "release" | "pr" | "profile"; ref: string; text: string; url?: string; incomplete?: boolean };

const REVIEW_ONLY_CONDITION = /\buntil\b|fail[- ]open|\b(?:when|if)\b[^.!?\n]{0,80}\b(?:enabled|configured|disabled|available|purchasable)\b|활성화|설정해야/i;

/** 검토 전용 탐지. 생성 프롬프트의 발췌 정책은 변경하지 않는다. */
export function reviewConditionParagraphs(text: string): string[] {
  return text.split(/\r?\n[\t ]*\r?\n/).filter((paragraph) => sourceConditionParagraphs(paragraph).length > 0 || REVIEW_ONLY_CONDITION.test(paragraph));
}

/** 원자료와 유효 프로필 제약. 생성된 highlights는 확인 근거로 쓰지 않는다. */
/**
 * 첫 소개 초안이 실제로 근거로 쓰는 자료: 홈페이지·README·프로필 한계. 릴리스 노트와 PR은 소개 초안에 넘기지 않으므로 확인 대상도 아니다.
 * Tend 운영 초안은 확인할 원문이 29개(PR 20)였다(2026-11-12).
 */
export function introductionEvidence<T extends EvidenceLike>(e: T): T {
  return readmeBased(e) ? { ...e, windowReleaseNotes: undefined, releaseNotes: undefined, mergedPrDetails: undefined } : e;
}

/** README가 있어야 소개 초안이 README를 근거로 쓴다. 없으면 PR·릴리스가 근거이므로 그 조건도 확인 대상이다. */
export const readmeBased = (e: EvidenceLike) => Boolean([e.readmeForChecks, e.readmeExcerpt].find((text) => text?.trim()));

export function conditionSources(e: EvidenceLike & { limitationsSource?: "readme" | "digest" }, profile?: ProfileLike): ConditionSource[] {
  const sources: ConditionSource[] = [];
  const homepage = e.homepageSource;
  if (homepage?.status === "ok" && homepage.url === e.homepage && homepage.text?.trim()) sources.push({ kind: "homepage", ref: "Homepage", text: homepage.text, url: homepage.finalUrl ?? homepage.url, incomplete: homepage.truncated });
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
