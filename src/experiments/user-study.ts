import { z } from "zod";

const task = z.object({
  status: z.enum(["not-started", "completed", "abandoned"]),
  seconds: z.number().positive().finite().nullable(),
  source: z.string(),
  finalText: z.string(),
  importantFactCorrections: z.number().int().nonnegative().nullable(),
  publishable: z.boolean().nullable(),
  published: z.boolean().nullable(),
  reason: z.string(),
}).strict().superRefine((t, ctx) => {
  if (t.status === "completed" && (!t.source.trim() || !t.finalText.trim() || t.publishable === null || t.importantFactCorrections === null))
    ctx.addIssue({ code: "custom", message: "완료 과업은 근거·최종 글·게시 가능 여부·중요 사실 수정 수가 필요합니다." });
  if (t.status === "abandoned" && !t.reason.trim()) ctx.addIssue({ code: "custom", message: "중단 이유가 필요합니다." });
  if (t.status === "not-started" && [t.seconds, t.importantFactCorrections, t.publishable, t.published].some((v) => v !== null))
    ctx.addIssue({ code: "custom", message: "미시작 과업의 측정값은 null이어야 합니다." });
});
export const studySchema = z.object({
  version: z.literal(1),
  participants: z.array(z.object({
    id: z.string().min(1),
    channel: z.string().min(1),
    language: z.string().min(1),
    order: z.enum(["manual-first", "somun-first"]),
    comparableSources: z.boolean().nullable(),
    manual: task,
    somun: task,
    returnUse: z.object({ opportunity: z.boolean().nullable(), used: z.boolean().nullable(), reason: z.string() }).strict()
      .superRefine((r, ctx) => { if (r.opportunity !== true && r.used !== null) ctx.addIssue({ code: "custom", message: "다음 변경 기회가 없으면 재사용은 null입니다." }); }),
  }).strict()),
}).strict().superRefine((s, ctx) => {
  if (new Set(s.participants.map((p) => p.id)).size !== s.participants.length) ctx.addIssue({ code: "custom", message: "참가자 ID가 중복됩니다." });
});
export function summarizeStudy(input: unknown) {
  const study = studySchema.parse(input);
  const pairs = study.participants.map((p) => {
    const eligible = p.comparableSources === true && [p.manual, p.somun].every((t) => t.status === "completed" && t.publishable === true && t.seconds !== null);
    return { id: p.id, order: p.order, manualStatus: p.manual.status, somunStatus: p.somun.status,
      savedPercent: eligible ? Math.round((1 - p.somun.seconds! / p.manual.seconds!) * 1000) / 10 : null };
  });
  const savings = pairs.flatMap((p) => p.savedPercent === null ? [] : [p.savedPercent]).sort((a, b) => a - b);
  const median = savings.length ? (savings[Math.floor((savings.length - 1) / 2)] + savings[Math.floor(savings.length / 2)]) / 2 : null;
  const summarize = (method: "manual" | "somun") => {
    const tasks = study.participants.map((p) => p[method]);
    const observed = tasks.filter((t) => t.status !== "not-started");
    return { started: observed.length, completed: tasks.filter((t) => t.status === "completed").length,
      abandoned: tasks.filter((t) => t.status === "abandoned").map((t) => t.reason),
      publishable: observed.filter((t) => t.publishable === true).length,
      importantFactCorrections: observed.reduce((n, t) => n + (t.importantFactCorrections ?? 0), 0),
      factCorrectionsUnmeasured: observed.filter((t) => t.importantFactCorrections === null).length,
      timeUnmeasured: observed.filter((t) => t.seconds === null).length };
  };
  const opportunities = study.participants.filter((p) => p.returnUse.opportunity === true);
  return { plannedParticipants: study.participants.length, observedParticipants: study.participants.filter((p) => p.manual.status !== "not-started" || p.somun.status !== "not-started").length,
    pairedPublishableTimedParticipants: savings.length, medianSavedPercent: median, pairs,
    manual: summarize("manual"), somun: summarize("somun"),
    returnUse: { opportunities: opportunities.length, used: opportunities.filter((p) => p.returnUse.used === true).length,
      notUsed: opportunities.filter((p) => p.returnUse.used === false).length, unmeasured: opportunities.filter((p) => p.returnUse.used === null).length },
    limitation: "게시 가능한 완료 과업의 짝만 시간 비교에 포함합니다. 중단·미측정은 별도 보고하며, 소수 표본의 기술 통계는 일반적 효과나 인과관계를 입증하지 않습니다." };
}
