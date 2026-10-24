import type { HomepageCopyUnit, HomepageSource } from "../shared/types.js";
import { postLength } from "./post-length.js";
import { normalizeForMatch } from "./text-match.js";

const whitespace = (text: string) => text.replace(/\s+/g, " ").trim();

/** Mechanical source candidates only; membership does not certify relevance or factual scope. */
export function sourceCopyBodies(source: HomepageSource, publicName: string, url: string, lang: string, maxChars = 280, preferContext = false): string[] {
  const name = publicName.trim();
  if (source.status !== "ok" || source.truncated || !source.text || source.url !== url || !/^https?:\/\/\S+$/i.test(url)
    || !name || !lang || !Number.isFinite(maxChars) || maxChars <= 0 || !source.copyUnits?.length) return [];
  if (source.siteName !== undefined && normalizeForMatch(source.siteName) !== normalizeForMatch(name)) return [];

  const units = source.copyUnits;
  const byId = new Map<string, { unit: HomepageCopyUnit; index: number }>();
  for (const [index, unit] of units.entries()) {
    if (typeof unit.id !== "string" || !unit.id.trim() || byId.has(unit.id)) return [];
    byId.set(unit.id, { unit, index });
  }
  const text = whitespace(source.text);
  const valid = new Set<string>();
  for (const [index, unit] of units.entries()) {
    if (unit.language !== lang || typeof unit.heading !== "string" || typeof unit.paragraph !== "string"
      || !whitespace(unit.heading) || !whitespace(unit.paragraph)
      || !text.includes(whitespace(unit.heading)) || !text.includes(whitespace(unit.paragraph))) continue;
    if (unit.parentId !== undefined) {
      const parent = byId.get(unit.parentId);
      if (!parent || parent.index >= index || !valid.has(parent.unit.id) || parent.unit.language !== unit.language) continue;
    }
    valid.add(unit.id);
  }

  const original = (unit: HomepageCopyUnit) => `${unit.heading}\n${unit.paragraph}`;
  const bodyOf = (...parts: HomepageCopyUnit[]) => `${name}\n\n${parts.map(original).join("\n\n")}\n\n${url}`;
  const fits = (body: string) => {
    const links = body.match(/https?:\/\/\S+/gi) ?? [];
    return links.length === 1 && links[0] === url && postLength("x", body) <= maxChars;
  };
  const pairs: string[] = [];
  const covered = new Set<string>();
  for (const unit of units) {
    if (!valid.has(unit.id) || unit.parentId === undefined) continue;
    const parent = byId.get(unit.parentId)!.unit;
    const body = bodyOf(parent, unit);
    if (!fits(body)) continue;
    pairs.push(body);
    covered.add(parent.id);
    covered.add(unit.id);
  }
  const singles = units.filter(unit => valid.has(unit.id) && !covered.has(unit.id)).map(unit => bodyOf(unit)).filter(fits);
  const result: string[] = [];
  const seen = new Set<string>();
  let characters = 0;
  const candidates = [...pairs, ...singles];
  // A context cue is a relevance hint, never a semantic or factual verdict.
  const hasContext = (body: string) => /\b(?:without|when|if)\b|없이|경우|다면|때[는도만, .]/i.test(body);
  if (preferContext) candidates.sort((a, b) => Number(hasContext(b)) - Number(hasContext(a)));
  for (const body of candidates) {
    if (seen.has(body) || characters + body.length > 6000) continue;
    result.push(body);
    seen.add(body);
    characters += body.length;
    if (result.length === 8) break;
  }
  return result;
}
