/**
 * 발행 효과 추정 (순수). 발행 직후 늘어난 스타에서, 발행 전 7일의 추세가 그대로 이어졌다면 늘었을 만큼을 뺀다.
 * 원래 하루 5개씩 늘던 저장소가 발행 뒤 7일에 40개 늘었다면 발행 효과는 +40이 아니라 +5다.
 */

const DAY = 86_400_000;

export type StarPoint = { at: number; stars: number };
export type PublicationEffect = {
  /** 발행 직전 스냅샷. */
  baseline?: StarPoint;
  /** 발행 후 7일 안의 마지막 스냅샷과 기준선의 차이. */
  observed?: number;
  /** 발행 전 추세(하루 증가량)를 같은 기간에 이어 붙인 기대 증가량. 발행 전 자료가 2일 미만이면 없음. */
  expected?: number;
  /** observed - expected. 추세를 알 수 없으면 없음. */
  excess?: number;
};

/** 추세 기준점: 기준선(발행 직전 스냅샷)보다 2일 이상, 창+3일 이하 앞선 스냅샷 중 가장 이른 것. */
function trendAnchor(before: StarPoint[], baseline: StarPoint, windowDays: number): StarPoint | undefined {
  return before.find((p) => p.at >= baseline.at - (windowDays + 3) * DAY && baseline.at - p.at >= 2 * DAY);
}

/** 발행 전 추세를 계산할 수 있는가(기준선과 기준점이 모두 있는가). publicationEffect와 같은 규칙이다. */
export function hasPrePostTrend(points: { at: number }[], publishedAt: number, windowDays = 7): boolean {
  const before = [...points].sort((a, b) => a.at - b.at).filter((p) => p.at <= publishedAt).map((p) => ({ at: p.at, stars: 0 }));
  const baseline = before.at(-1);
  return Boolean(baseline && trendAnchor(before, baseline, windowDays));
}

export function publicationEffect(points: StarPoint[], publishedAt: number, windowDays = 7): PublicationEffect {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const before = sorted.filter((p) => p.at <= publishedAt);
  const baseline = before.at(-1);
  if (!baseline) return {};
  const after = sorted.filter((p) => p.at > publishedAt && p.at <= publishedAt + windowDays * DAY).at(-1);
  const observed = after ? after.stars - baseline.stars : undefined;
  const anchor = trendAnchor(before, baseline, windowDays);
  if (!after || observed === undefined || !anchor) return { baseline, observed };
  const perDay = (baseline.stars - anchor.stars) / ((baseline.at - anchor.at) / DAY);
  const expected = round1(perDay * ((after.at - baseline.at) / DAY));
  return { baseline, observed, expected, excess: round1(observed - expected) };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * 지금 스타 수와 최근 스타 시각들로 과거 시점의 스타 수를 되짚는다(스타 취소는 모른다).
 * 소문이 스냅샷을 찍기 전에 올린 첫 글도 발행 전 추세를 계산할 수 있게, 발행 8일 전과 1일 전을 만든다.
 */
export function backfillStarPoints(currentStars: number, starTimes: number[], publishedAt: number): StarPoint[] {
  return [8, 1].map((days) => {
    const at = publishedAt - days * DAY;
    return { at, stars: Math.max(0, currentStars - starTimes.filter((t) => t > at).length) };
  });
}

/**
 * 초안에서 최종본까지 고친 양. 단어 단위 편집 거리 / 원래 단어 수, 0(그대로)~1(전부 새로). 학습 효과의 기준 지표.
 * 공백으로 나누므로 한국어는 어절 단위다. 긴 글은 앞부분 MAX_TOKENS개까지만 비교한다.
 */
export function editRatio(before: string, after: string): number {
  const MAX_TOKENS = 600;
  // 낱말 앞뒤의 문장부호(마침표·쉼표·괄호·따옴표)는 떼고 비교한다. 마침표 하나를 붙였다고 그 어절을 새로 쓴 것으로 세지 않게.
  // 기호(+, $, €, 이모지, 화살표)는 뜻을 바꾸므로 남긴다.
  const words = (text: string) => text.split(/\s+/).map((w) => w.replace(/^\p{P}+|\p{P}+$/gu, "").toLowerCase()).filter(Boolean).slice(0, MAX_TOKENS);
  const a = words(before);
  const b = words(after);
  if (a.length === 0) return b.length === 0 ? 0 : 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.min(1, Math.round((prev[b.length] / a.length) * 100) / 100);
}
