import { useState } from "react";
import { Link } from "react-router-dom";
import type { PerformanceSummary, PublicationWithMetrics } from "@shared/types";
import { VOICE_PRESETS } from "@core/voice";
import { CHANNEL_LABEL, MetricChart, Skeleton, fmtDate } from "../components/ui";
import { post, useResource } from "../lib/api";

export default function Published() {
  const { data: rows } = useResource<PublicationWithMetrics[]>("/publications", ["publications", "candidates"]);
  const { data: summary } = useResource<PerformanceSummary>("/publications/summary", ["publications", "candidates"]);
  return (
    <>
      <div className="page-head"><div><h1>발행</h1><p className="lede">올린 글과 그 뒤의 스타·방문자 변화. 세로선이 발행 시점, 점선이 발행 전 기준선입니다. X와 Show HN 반응은 매일 자동으로 받고, LinkedIn·Threads·GeekNews는 직접 입력합니다.</p></div>{rows && rows.length > 0 && <div className="toolbar"><button className="sm" onClick={async () => { await post("/publications/refresh"); }}>반응 새로 받기</button></div>}</div>
      {rows === undefined ? <Skeleton rows={3} /> : rows.length === 0 ? (
        <div className="empty">
          <p style={{ marginBottom: 12 }}>아직 발행한 글이 없습니다.</p>
          <p className="small muted" style={{ marginBottom: 14 }}>검수할 초안을 열어 복사하고, 올린 뒤 "올렸어요"에 URL을 붙여 넣으면 여기서 추이가 보입니다.</p>
          <Link to="/" className="btn primary">검수할 초안 보기</Link>
        </div>
      ) : (
        <>
        {summary && (summary.byChannel.length > 1 || summary.byVoice.length > 1) && (
          <div className="perf">
            <div className="perf-col">
              <div className="tiny muted" style={{ marginBottom: 6 }}>채널별 · 발행 7일 뒤</div>
              {summary.byChannel.map((g) => <div key={g.key} className="perf-row"><span>{CHANNEL_LABEL[g.key] ?? g.key} <span className="muted">{g.count}</span></span><span className="mono">{g.avgStarDelta !== undefined ? `스타 ${g.avgStarDelta > 0 ? "+" : ""}${g.avgStarDelta}` : "스타 -"}{g.avgUniques !== undefined ? ` · 방문 ${g.avgUniques}` : ""}{g.avgLikes !== undefined ? ` · 반응 ${g.avgLikes}` : ""}</span></div>)}
            </div>
            <div className="perf-col">
              <div className="tiny muted" style={{ marginBottom: 6 }}>문체별 · 발행 7일 뒤</div>
              {summary.byVoice.map((g) => <div key={g.key} className="perf-row"><span>{VOICE_PRESETS.find((v) => v.id === g.key)?.name ?? (g.key === "unknown" ? "문체 미기록" : g.key)} <span className="muted">{g.count}</span></span><span className="mono">{g.avgStarDelta !== undefined ? `스타 ${g.avgStarDelta > 0 ? "+" : ""}${g.avgStarDelta}` : "스타 -"}{g.avgLikes !== undefined ? ` · 반응 ${g.avgLikes}` : ""}</span></div>)}
            </div>
          </div>
        )}
        <div className="rows">
          {rows.map((p) => {
            const delta = p.latestStars !== undefined && p.baselineStars !== undefined ? p.latestStars - p.baselineStars : undefined;
            return (
              <div key={p.id} className="pub">
                <span className="badge outline">{CHANNEL_LABEL[p.channel] ?? p.channel}</span>
                <div style={{ minWidth: 0 }}>
                  <Link to={`/c/${p.candidateId}`} style={{ fontWeight: 600, color: "var(--ink)" }}>{p.candidateTitle}</Link>
                  <div className="tiny muted">{fmtDate(p.publishedAt)} · <a href={p.url} target="_blank" rel="noreferrer">{p.url.replace(/^https?:\/\//, "").slice(0, 60)}</a></div>
                </div>
                <div className="row" style={{ gap: 10 }}>
                  <div className="small muted" style={{ textAlign: "right" }}>
                    <div>스타 {p.baselineStars ?? "?"} → {p.latestStars ?? "?"} {delta !== undefined && <span className={`delta ${delta > 0 ? "up" : ""}`}>{delta > 0 ? `+${delta}` : delta}</span>}</div>
                    {p.series.at(-1)?.uniques !== undefined && <div>방문자 14일 {p.series.at(-1)?.uniques}</div>}
                  </div>
                  <MetricChart series={p.series} publishedAt={p.publishedAt} baseline={p.baselineStars} />
                </div>
                {p.autoStats ? <span className="small muted" title={`자동 수집 (${p.autoStats.source}) · ${p.autoStatsAt ? fmtDate(p.autoStatsAt) : ""}`}>{p.autoStats.score !== undefined ? `점수 ${p.autoStats.score} · 댓글 ${p.autoStats.comments ?? 0}` : `♥ ${p.autoStats.likes ?? 0} · ↻ ${p.autoStats.reposts ?? 0} · 답글 ${p.autoStats.comments ?? 0}${p.autoStats.views ? ` · 조회 ${p.autoStats.views}` : ""}`} <span className="badge ok">자동</span></span> : <ManualStats id={p.id} stats={p.manualStats} />}
              </div>
            );
          })}
        </div>
        </>
      )}
    </>
  );
}

function ManualStats({ id, stats }: { id: number; stats?: { likes?: number; comments?: number; reposts?: number } }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ likes: stats?.likes ?? 0, comments: stats?.comments ?? 0, reposts: stats?.reposts ?? 0 });
  if (!open) return <button className="ghost sm" onClick={() => setOpen(true)}>{stats ? `반응 ${stats.likes ?? 0}·${stats.comments ?? 0}·${stats.reposts ?? 0}` : "반응 입력"}</button>;
  return (
    <div className="row small" style={{ gap: 6 }}>
      {(["likes", "comments", "reposts"] as const).map((k) => <input key={k} type="number" value={v[k]} style={{ width: 64 }} title={k} onChange={(ev) => setV({ ...v, [k]: Number(ev.target.value) })} />)}
      <button className="sm" onClick={async () => { await post(`/publications/${id}/stats`, v); setOpen(false); }}>저장</button>
    </div>
  );
}
