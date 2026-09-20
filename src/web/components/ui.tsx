import { useEffect, useState, type ReactNode } from "react";
import type { Candidate, Judgment } from "@shared/types";

export const CHANNEL_LABEL: Record<string, string> = { x_en: "X (en)", x_ko: "X (ko)", threads: "Threads", linkedin_ko: "LinkedIn", show_hn: "Show HN", show_gn: "Show GN", blog_outline: "블로그 개요" };
export const TYPE_LABEL: Record<string, string> = { release: "릴리스", "new-repo": "새 저장소", milestone: "마일스톤", blog: "블로그", "in-progress": "진행 중" };
export const CRITERIA: [keyof Judgment["scores"], string, string][] = [
  ["runnable", "실행 가능", "링크 눌러 1분 안에 써볼 수 있는가"],
  ["numbers", "숫자", "측정치, 전후 비교가 있는가"],
  ["lesson", "배움", "실패, 되돌린 결정, 의외의 사실이 있는가"],
  ["novelty", "새로움", "최근 30일 발행물과 겹치지 않는가"],
  ["audience", "청중", "누가 어느 채널에서 관심 가질지 말할 수 있는가"],
];
export const REASONS = [["wrong_facts", "사실이 틀림"], ["voice", "문체가 아님"], ["wrong_channel", "채널이 안 맞음"], ["not_yet", "아직 이름"], ["not_worth", "글감 아님"], ["other", "기타"]] as const;

export function fmtDate(ts: number): string {
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}
export function relTime(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

/** 후보의 한 가지 상태. 배지 하나로 끝낸다. */
export type Stage = { key: "review" | "working" | "deferred" | "ask" | "published" | "dropped"; label: string; tone: "ok" | "warn" | "" | "bad"; busy?: boolean };
export function stageOf(c: Pick<Candidate, "status" | "evidence" | "latestJudgmentId"> & { judgment?: Judgment | null }): Stage {
  if (c.status === "dropped") return { key: "dropped", label: "버림", tone: "bad" };
  if (c.status === "published") return { key: "published", label: "발행됨", tone: "ok" };
  if (c.status === "drafted") return { key: "review", label: "검수 대기", tone: "ok" };
  if (c.status === "deferred") return { key: "deferred", label: "보류", tone: "warn" };
  if (!c.evidence.highlightsAt) return { key: "working", label: "다이제스트 중", tone: "", busy: true };
  if (!c.latestJudgmentId) return { key: "working", label: "판단 중", tone: "", busy: true };
  const d = c.judgment?.overriddenDecision ?? c.judgment?.decision;
  if (d === "ask") return { key: "ask", label: "묻기만", tone: "" };
  return { key: "working", label: "초안 작성 중", tone: "", busy: true };
}
export function StageChip({ stage }: { stage: Stage }) {
  return <span className={`badge ${stage.tone}`}>{stage.busy && <i className="dot" />}{stage.label}</span>;
}

/** 5항목 미터. 각 항목 0~2. */
export function Meter({ scores, compact }: { scores: Judgment["scores"]; compact?: boolean }) {
  return (
    <div className={`meter ${compact ? "compact" : ""}`}>
      {CRITERIA.map(([k, label, hint]) => (
        <div key={k} className="meter-item" title={hint}>
          <span className="meter-label">{label}</span>
          <span className="meter-bar"><i className={scores[k] >= 1 ? "on" : ""} /><i className={scores[k] >= 2 ? "on" : ""} /></span>
        </div>
      ))}
    </div>
  );
}

export function LintBadges({ lint }: { lint: { rule: string; ok: boolean; detail?: string }[] }) {
  const bad = lint.filter((l) => !l.ok);
  if (bad.length === 0) return <span className="badge ok">린트 통과</span>;
  const label: Record<string, string> = { banned_phrases: "금지 표현", no_emoji_bullets: "이모지 목록", has_number: "숫자 없음", has_limitation: "한계 없음", has_number_or_limit: "숫자·한계 없음", has_link: "링크 없음", no_exclamation: "감탄부호", length: "길이 초과", title_length: "제목 길이", no_vote_request: "투표 요청", no_placeholder: "빈 숫자" };
  return <>{bad.map((l) => <span key={l.rule} className="badge bad" title={l.detail}>{label[l.rule] ?? l.rule}{l.detail && l.rule === "length" ? ` ${l.detail}` : ""}</span>)}</>;
}

export function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const max = Math.max(...values), min = Math.min(...values), span = Math.max(1, max - min);
  return <div className="spark">{values.map((v, i) => <i key={i} style={{ height: `${6 + ((v - min) / span) * 30}px` }} title={String(v)} />)}</div>;
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return <div className="stack">{Array.from({ length: rows }, (_, i) => <div key={i} className="skel" />)}</div>;
}

/** 간단한 오버플로 메뉴 (⋯). */
export function Menu({ items }: { items: { label: string; onClick: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  return (
    <span className="menu-wrap" onClick={(e) => e.stopPropagation()}>
      <button className="ghost sm" aria-label="더 보기" onClick={() => setOpen((o) => !o)}>⋯</button>
      {open && <div className="menu">{items.map((it) => <button key={it.label} className={`menu-item ${it.danger ? "danger" : ""}`} onClick={() => { setOpen(false); it.onClick(); }}>{it.label}</button>)}</div>}
    </span>
  );
}

export function Toast({ msg }: { msg: string | null }) {
  return msg ? <div className="toast" role="status">{msg}</div> : null;
}
export function useToast(): [string | null, (m: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  return [msg, (m) => { setMsg(m); setTimeout(() => setMsg(null), 1800); }];
}

export function Section({ title, count, children, hint }: { title: string; count?: number; hint?: string; children: ReactNode }) {
  return (
    <section className="tri">
      <div className="tri-head"><h2>{title}{count !== undefined && <span className="tri-count">{count}</span>}</h2>{hint && <span className="tiny muted">{hint}</span>}</div>
      {children}
    </section>
  );
}
