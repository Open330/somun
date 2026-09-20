import type { Doc } from "../../convex/_generated/dataModel";

export const CHANNEL_LABEL: Record<string, string> = {
  x_en: "X (en)",
  x_ko: "X (ko)",
  threads: "Threads",
  linkedin_ko: "LinkedIn",
  show_hn: "Show HN",
  show_gn: "Show GN",
  blog_outline: "블로그 개요",
};

export const TYPE_LABEL: Record<string, string> = {
  release: "릴리스",
  "new-repo": "새 저장소",
  milestone: "마일스톤",
  blog: "블로그",
  "in-progress": "진행 중",
};

export const REASONS = [
  ["wrong_facts", "사실이 틀림"],
  ["voice", "문체가 아님"],
  ["wrong_channel", "채널이 안 맞음"],
  ["not_yet", "아직 이름"],
  ["not_worth", "글감 아님"],
  ["other", "기타"],
] as const;

export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function DecisionBadge({ j }: { j: Doc<"judgments"> | null | undefined }) {
  if (!j) return <span className="badge">판단 전</span>;
  const d = j.overriddenDecision ?? j.decision;
  const cls = d === "draft" ? "ok" : d === "defer" ? "warn" : d === "drop" ? "bad" : "";
  const label = d === "draft" ? "초안" : d === "defer" ? "보류" : d === "drop" ? "버림" : "묻기만";
  return <span className={`badge ${cls}`}>{label}{j.overriddenDecision ? " (수동)" : ""}</span>;
}

export function LintBadges({ lint }: { lint: { rule: string; ok: boolean; detail?: string }[] }) {
  const bad = lint.filter((l) => !l.ok);
  if (bad.length === 0) return <span className="badge ok">린트 통과</span>;
  return (
    <>
      {bad.map((l) => (
        <span key={l.rule} className="badge bad" title={l.detail}>
          {l.rule}{l.detail ? `: ${l.detail}` : ""}
        </span>
      ))}
    </>
  );
}

export function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const max = Math.max(...values), min = Math.min(...values);
  const span = Math.max(1, max - min);
  return (
    <div className="spark">
      {values.map((v, i) => (
        <i key={i} style={{ height: `${6 + ((v - min) / span) * 30}px` }} title={String(v)} />
      ))}
    </div>
  );
}
