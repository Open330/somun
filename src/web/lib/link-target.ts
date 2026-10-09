import type { Draft } from "@shared/types";

type Version = Pick<Draft, "id" | "version" | "status" | "purpose">;

/** 목적 비교용. 목적이 기록되기 전의 판(null)은 변경사항 글이었다(마이그레이션 0014와 같은 해석). */
export const purposeKey = (d: Pick<Draft, "purpose">) => d.purpose ?? "update";

/**
 * 게시 링크를 달 수 있는 판. 최신 판이 아직 복사 전이고, 그보다 앞서 복사만 하고 링크를 남기지 않은 판이 있을 때만 고른다.
 * - 목적(소개·변경사항)마다 가장 최근 복사본 하나. 같은 목적의 더 새 판에 이미 링크가 있으면 그 앞의 복사본은 지난 것으로 본다.
 * - 기본값은 복사본이다(게시할 수 있었던 글은 복사한 글뿐). 최신 판과 목적이 같은 복사본이 있으면 그것, 없으면 가장 최근 복사본.
 * versions는 새 판부터.
 */
export function linkTargets(
  latest: Version,
  versions: Version[],
  posted: ReadonlySet<number>,
): { options: Version[]; defaultId: number } | null {
  if (latest.status === "copied" || posted.has(latest.id)) return null;
  const copies: Version[] = [];
  const closed = new Set<string>();
  for (const d of versions) {
    if (d.id === latest.id || d.version > latest.version) continue;
    const key = purposeKey(d);
    if (closed.has(key)) continue;
    if (posted.has(d.id)) closed.add(key);
    else if (d.status === "copied") {
      copies.push(d);
      closed.add(key);
    }
  }
  if (!copies.length) return null;
  const preferred = copies.find((c) => purposeKey(c) === purposeKey(latest)) ?? copies[0];
  return { options: [...copies, latest], defaultId: preferred.id };
}
