import { createHash } from "node:crypto";
import type { Evidence, WritingBrief } from "../shared/types.js";

type BriefEvidence = Pick<Evidence, "repo" | "highlights" | "mergedPrDetails">;

/** 요약 작업 대기 중 원문이 바뀌었는지 확인하는 메타데이터. 글의 숫자 근거가 아니다. */
export function sourceSnapshot(e: BriefEvidence): string {
  return `PR source snapshot: ${createHash("sha256").update(JSON.stringify([e.repo, e.mergedPrDetails ?? []])).digest("hex")}`;
}

/** 참조 형식과 원문 존재만 검사한다. 행동·조건의 의미적 정확성을 인증하지 않는다. */
export function parseWritingBrief(value: unknown, e: BriefEvidence): WritingBrief | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Partial<WritingBrief>;
  if (typeof r.highlight !== "string" || !e.highlights?.includes(r.highlight)) return undefined;
  if (typeof r.readerAction !== "string" || !r.readerAction.trim() || r.readerAction.length > 400 || /[\r\n]/.test(r.readerAction)) return undefined;
  if (!Array.isArray(r.sourcePrNumbers) || !r.sourcePrNumbers.length || r.sourcePrNumbers.length > 3 || new Set(r.sourcePrNumbers).size !== r.sourcePrNumbers.length) return undefined;
  const sources = r.sourcePrNumbers.map((number) => Number.isSafeInteger(number) && number > 0 ? e.mergedPrDetails?.find((p) => p.number === number) : undefined);
  if (sources.some((p) => !p?.body.trim() || p.bodyTruncated) || sources.reduce((n, p) => n + (p?.body.length ?? 0), 0) > 48000) return undefined;
  if (!Array.isArray(r.requiredConditions) || r.requiredConditions.length > 6) return undefined;
  const requiredConditions: WritingBrief["requiredConditions"] = [];
  for (const condition of r.requiredConditions) {
    if (!condition || typeof condition !== "object" || typeof condition.quote !== "string" || !condition.quote.trim() || condition.quote.length > 600) return undefined;
    const source = sources.find((p) => p?.number === condition.sourcePrNumber);
    if (!source?.body.includes(condition.quote)) return undefined;
    requiredConditions.push({ sourcePrNumber: condition.sourcePrNumber, quote: condition.quote });
  }
  return { highlight: r.highlight, readerAction: r.readerAction.trim(), sourcePrNumbers: r.sourcePrNumbers, requiredConditions, sourceDigest: sourceSnapshot(e) };
}

/** 원문이 달라진 저장 brief는 재사용하지 않는다. */
export function currentWritingBrief(e: BriefEvidence & { writingBrief?: WritingBrief }): WritingBrief | undefined {
  const brief = parseWritingBrief(e.writingBrief, e);
  return brief && brief.sourceDigest === e.writingBrief?.sourceDigest ? brief : undefined;
}
