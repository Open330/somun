import { describe, expect, it } from "vitest";
import type { HomepageCopyUnit, HomepageSource } from "../shared/types.js";
import { postLength } from "./post-length.js";
import { sourceCopyBodies } from "./source-copy.js";

const url = "https://example.com/product/";
const unit = (id: string, heading: string, paragraph: string, parentId?: string, language = "ko"): HomepageCopyUnit => ({ id, heading, paragraph, parentId, language });
const source = (copyUnits: HomepageCopyUnit[], extra: Partial<HomepageSource> = {}): HomepageSource => ({
  url, collectedAt: 1, status: "ok", truncated: false, siteName: "Atlas",
  text: copyUnits.map(u => `${u.heading}\n${u.paragraph}`).join("\n\n"), copyUnits, ...extra,
});
const body = (...units: HomepageCopyUnit[]) => `Atlas\n\n${units.map(u => `${u.heading}\n${u.paragraph}`).join("\n\n")}\n\n${url}`;

describe("original homepage copy candidates", () => {
  it("prefers literal parent-child pairs and excludes their standalone variants", () => {
    const overview = unit("overview", "기기를 연결하고,\n작업을 이어서.", "화면과 파일을 별도 창에서 다루세요.");
    const task = unit("task", "파일 작업", "화면 연결 없이 폴더를 열고 복사하세요. SSH가 필요합니다.", "overview");
    const single = unit("other", "다른 작업", "보고서를 내보냅니다.");
    const input = source([single, overview, task]);
    const before = structuredClone(input);
    expect(sourceCopyBodies(input, "Atlas", url, "ko")).toEqual([body(overview, task), body(single)]);
    expect(input).toEqual(before);
  });

  it("keeps all original paragraph characters and normalizes whitespace only to verify provenance", () => {
    const original = unit("copy", "작업\n방법", "첫 동작입니다.\n\n권한이 있을 때만 둘째 동작을 수행하세요.");
    const input = source([original], { text: "작업   방법 첫 동작입니다. 권한이 있을 때만 둘째 동작을 수행하세요." });
    expect(sourceCopyBodies(input, "Atlas", url, "ko")).toEqual([body(original)]);
    expect(sourceCopyBodies({ ...input, text: "작업 방법 첫 동작입니다." }, "Atlas", url, "ko")).toEqual([]);
    expect(sourceCopyBodies({ ...input, text: "다른 제목 첫 동작입니다. 권한이 있을 때만 둘째 동작을 수행하세요." }, "Atlas", url, "ko")).toEqual([]);
  });

  it("counts the final name and URL using X weighting and never cuts an oversized unit", () => {
    const original = unit("copy", "파일", "폴더를 열고 복사합니다.");
    const input = source([original]);
    const length = postLength("x", body(original));
    expect(sourceCopyBodies(input, "Atlas", url, "ko", length)).toEqual([body(original)]);
    expect(sourceCopyBodies(input, "Atlas", url, "ko", length - 1)).toEqual([]);
    const long = unit("long", "조건", "모든 조건을 보존하세요. ".repeat(100));
    expect(sourceCopyBodies(source([long, original]), "Atlas", url, "ko")).toEqual([body(original)]);
  });

  it("never removes source text to force a single final supplied URL", () => {
    const external = unit("external", "도움말", "https://docs.example.com/ 에서 확인하세요.");
    const duplicate = unit("duplicate", "홈페이지", `${url} 에서 확인하세요.`);
    const eligible = unit("copy", "파일", "파일을 엽니다.");
    expect(sourceCopyBodies(source([external, duplicate, eligible]), "Atlas", url, "ko")).toEqual([body(eligible)]);
  });

  it("does not cut a pair to fit, and can retain independently eligible complete units", () => {
    const parent = unit("parent", "주용도", "보고서를 엽니다.");
    const child = unit("child", "내보내기", "보고서를 파일로 내보냅니다.", "parent");
    const limit = Math.max(postLength("x", body(parent)), postLength("x", body(child)));
    expect(postLength("x", body(parent, child))).toBeGreaterThan(limit);
    expect(sourceCopyBodies(source([parent, child]), "Atlas", url, "ko", limit)).toEqual([body(parent), body(child)]);
  });

  it("rejects ambiguous IDs and never turns invalid parent references into standalone children", () => {
    const parent = unit("parent", "개요", "화면을 엽니다.");
    const child = unit("child", "작업", "입력합니다.", "parent");
    expect(sourceCopyBodies(source([parent, { ...child, id: "parent" }]), "Atlas", url, "ko")).toEqual([]);
    expect(sourceCopyBodies(source([parent, { ...child, id: " " }]), "Atlas", url, "ko")).toEqual([]);
    expect(sourceCopyBodies(source([child, parent]), "Atlas", url, "ko")).toEqual([body(parent)]);
    expect(sourceCopyBodies(source([{ ...child, parentId: "missing" }, parent]), "Atlas", url, "ko")).toEqual([body(parent)]);
    expect(sourceCopyBodies(source([{ ...child, parentId: "child" }]), "Atlas", url, "ko")).toEqual([]);
    expect(sourceCopyBodies(source([parent, child], { text: `${child.heading}\n${child.paragraph}` }), "Atlas", url, "ko")).toEqual([]);
  });

  it("requires matching unit languages, including the referenced parent", () => {
    const parent = unit("parent", "Overview", "Open screens.", undefined, "en");
    const child = unit("child", "입력", "키를 입력합니다.", "parent");
    const independent = unit("ko", "파일", "파일을 엽니다.");
    expect(sourceCopyBodies(source([parent, child, independent]), "Atlas", url, "ko")).toEqual([body(independent)]);
    expect(sourceCopyBodies(source([parent]), "Atlas", url, "en")).toEqual([body(parent)]);
    expect(sourceCopyBodies(source([parent]), "Atlas", url, "ko")).toEqual([]);
  });

  it("requires complete successful source collection and the supplied source URL", () => {
    const input = source([unit("one", "파일", "파일을 엽니다.")]);
    for (const change of [{ status: "failed" as const }, { truncated: true }, { text: undefined }, { copyUnits: undefined }, { url: "https://other.example/" }]) {
      expect(sourceCopyBodies({ ...input, ...change }, "Atlas", url, "ko")).toEqual([]);
    }
    expect(sourceCopyBodies(input, "", url, "ko")).toEqual([]);
    expect(sourceCopyBodies(input, "Atlas", url, "ko", Infinity)).toEqual([]);
  });

  it("requires the canonical public name to agree with siteName without inferring aliases", () => {
    const original = unit("one", "ファイル", "ファイルを開きます。", undefined, "ja");
    expect(sourceCopyBodies(source([original]), "Different", url, "ja")).toEqual([]);
    expect(sourceCopyBodies(source([original], { siteName: "ＡＴＬＡＳ" }), "Atlas", url, "ja")).toEqual([body(original)]);
    expect(sourceCopyBodies(source([original], { siteName: "Atlas (owner/repo)" }), "Atlas", url, "ja")).toEqual([]);
    expect(sourceCopyBodies(source([original], { siteName: undefined }), "Atlas", url, "ja")).toEqual([body(original)]);
  });

  it("deduplicates identical final bodies and caps candidates at eight in original order", () => {
    const units = Array.from({ length: 12 }, (_, i) => unit(`id-${i}`, `작업 ${i}`, "파일을 엽니다."));
    const duplicate = { ...units[0], id: "duplicate" };
    expect(sourceCopyBodies(source([units[0], duplicate, ...units.slice(1)]), "Atlas", url, "ko")).toEqual(units.slice(0, 8).map(u => body(u)));
  });

  it("caps the combined enum at 6000 characters without truncating candidate bodies", () => {
    const units = Array.from({ length: 8 }, (_, i) => unit(`id-${i}`, `Operation ${i}`, "Complete original text. ".repeat(50), undefined, "en"));
    const candidates = sourceCopyBodies(source(units), "Atlas", url, "en", 3000);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThan(8);
    expect(candidates.reduce((sum, candidate) => sum + candidate.length, 0)).toBeLessThanOrEqual(6000);
    expect(candidates).toEqual(units.slice(0, candidates.length).map(u => body(u)));
    expect(candidates.reduce((sum, candidate) => sum + candidate.length, 0) + body(units[candidates.length]).length).toBeGreaterThan(6000);
  });
});

it("prefers contextual passages across the full source before the candidate cap without rewriting them", () => {
  const units = Array.from({ length: 10 }, (_, i) => unit(`id-${i}`, `작업 ${i}`, i === 9 ? "연결 없이 파일을 복사합니다." : "파일을 엽니다."));
  const input = source(units);
  expect(sourceCopyBodies(input, "Atlas", url, "ko", 280, true)).toEqual([body(units[9]), ...units.slice(0, 7).map(u => body(u))]);
  expect(sourceCopyBodies(input, "Atlas", url, "ko")).toEqual(units.slice(0, 8).map(u => body(u)));
});
