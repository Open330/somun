import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { studySchema, summarizeStudy } from "./user-study.js";
const template = () => JSON.parse(readFileSync("experiments/user-study.template.json", "utf8"));
const complete = (seconds: number | null) => ({ status: "completed", seconds, source: "https://example.test/source", finalText: "근거를 검토한 최종 글", importantFactCorrections: 0, publishable: true, published: false, reason: "" });
describe("실제 사용자 과업 집계", () => {
  it("비어 있는 양식을 실제 평가나 0초 절약으로 집계하지 않는다", () => {
    const s = summarizeStudy(template());
    expect(s.observedParticipants).toBe(0); expect(s.medianSavedPercent).toBeNull(); expect(s.returnUse.opportunities).toBe(0);
  });
  it("직접 작성이 더 빠른 참가자도 중앙값에 포함한다", () => {
    const t = template();
    for (const [i, time] of [50, 120].entries()) Object.assign(t.participants[i], { comparableSources: true, manual: complete(100), somun: complete(time) });
    const s = summarizeStudy(t); expect(s.pairs.slice(0, 2).map((p) => p.savedPercent)).toEqual([50, -20]); expect(s.medianSavedPercent).toBe(15);
  });
  it("중단·미측정·게시 불가·다른 난도를 시간 절약 분모에 넣지 않는다", () => {
    const t = template();
    for (const p of t.participants) Object.assign(p, { comparableSources: true, manual: complete(100), somun: complete(50) });
    t.participants[0].somun = { ...complete(20), status: "abandoned", reason: "근거 확인 실패", publishable: false };
    t.participants[1].somun.seconds = null; t.participants[2].somun.publishable = false; t.participants[3].comparableSources = false;
    t.participants[4].somun.importantFactCorrections = 2;
    const s = summarizeStudy(t); expect(s.pairedPublishableTimedParticipants).toBe(2); expect(s.somun.abandoned).toEqual(["근거 확인 실패"]); expect(s.somun.timeUnmeasured).toBe(1); expect(s.somun.importantFactCorrections).toBe(2);
  });
  it("재사용 기회·미사용·미측정을 구분한다", () => {
    const t = template();
    t.participants[0].returnUse = { opportunity: true, used: true, reason: "" };
    t.participants[1].returnUse = { opportunity: true, used: false, reason: "직접 작성이 빠름" };
    t.participants[2].returnUse = { opportunity: true, used: null, reason: "응답 대기" };
    expect(summarizeStudy(t).returnUse).toEqual({ opportunities: 3, used: 1, notUsed: 1, unmeasured: 1 });
  });
  it("중복 참가자·불완전한 완료·모순된 재사용·미시작 수치를 거부한다", () => {
    const a = template(); a.participants[1].id = a.participants[0].id; expect(studySchema.safeParse(a).success).toBe(false);
    const b = template(); b.participants[0].somun.status = "completed"; expect(studySchema.safeParse(b).success).toBe(false);
    const c = template(); c.participants[0].returnUse.used = false; expect(studySchema.safeParse(c).success).toBe(false);
    const d = template(); d.participants[0].manual.seconds = 0; expect(studySchema.safeParse(d).success).toBe(false);
  });
});
