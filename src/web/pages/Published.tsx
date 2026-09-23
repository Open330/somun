import { useState } from "react";
import { Link } from "react-router-dom";
import type { PerformanceSummary, PublicationWithMetrics } from "@shared/types";
import { VOICE_PRESETS } from "@core/voice";
import { channelLabel, ErrorState, MetricChart, Skeleton, fmtDate } from "../components/ui";
import { post, useResource } from "../lib/api";
import { t } from "../i18n";

export default function Published() {
  const { data: rows, error, reload } = useResource<PublicationWithMetrics[]>("/publications", ["publications", "candidates"]);
  const { data: summary } = useResource<PerformanceSummary>("/publications/summary", ["publications", "candidates"]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  if (error) return <ErrorState title={t("발행 기록을 불러오지 못했습니다")} message={error} onRetry={reload} />;
  return (
    <>
      <div className="page-head"><div><h1>{t("발행 기록")}</h1><p className="lede">{t("직접 게시한 글을 모아보고, 게시 후 어떤 변화가 있었는지 확인하세요.")}</p></div>{rows && rows.length > 0 && <div className="toolbar"><button disabled={refreshing} onClick={async () => { setRefreshing(true); setRefreshError(null); try { await post("/publications/refresh"); reload(); } catch (err) { setRefreshError(`${t("반응을 가져오지 못했습니다.")} ${(err as Error).message}`); } finally { setRefreshing(false); } }}>{refreshing ? t("확인 중…") : t("반응 새로 받기")}</button></div>}</div>
      {refreshError && <div className="inline-notice is-error" role="alert">{refreshError}</div>}
      {rows === undefined ? <Skeleton rows={3} /> : rows.length === 0 ? (
        <div className="state-panel">
          <p style={{ marginBottom: 12 }}>{t("아직 발행한 글이 없습니다.")}</p>
          <p className="small muted" style={{ marginBottom: 14 }}>{t("초안을 검토해 원하는 채널에 올리고, 초안 화면에 게시 링크를 남겨주세요. 여기에 발행 기록과 지표가 쌓입니다.")}</p>
          <Link to="/" className="btn primary">{t("글감에서 초안 고르기")}</Link>
        </div>
      ) : (
        <>
        {summary && (summary.byChannel.length > 1 || summary.byVoice.length > 1) && (
          <div className="perf">
            <div className="perf-col">
              <div className="tiny muted" style={{ marginBottom: 6 }}>{t("채널별 · 발행 7일 뒤")}</div>
              {summary.byChannel.map((g) => <div key={g.key} className="perf-row"><span>{channelLabel(g.key)} <span className="muted">{g.count}</span></span><span className="mono">{starText(g)}{g.avgUniques !== undefined ? ` · ${t("방문 {n}", { n: g.avgUniques })}` : ""}{g.avgLikes !== undefined ? ` · ${t("반응 {n}", { n: g.avgLikes })}` : ""}</span></div>)}
            </div>
            <div className="perf-col">
              <div className="tiny muted" style={{ marginBottom: 6 }}>{t("문체별 · 발행 7일 뒤")}</div>
              {summary.byVoice.map((g) => <div key={g.key} className="perf-row"><span>{g.key === "unknown" ? t("문체 미기록") : t(VOICE_PRESETS.find((v) => v.id === g.key)?.name ?? g.key)} <span className="muted">{g.count}</span></span><span className="mono">{starText(g)}{g.avgLikes !== undefined ? ` · ${t("반응 {n}", { n: g.avgLikes })}` : ""}</span></div>)}
            </div>
          </div>
        )}
        <div className="rows">
          {rows.map((p) => {
            const delta = p.latestStars !== undefined && p.baselineStars !== undefined ? p.latestStars - p.baselineStars : undefined;
            return (
              <div key={p.id} className="pub">
                <span className="badge outline">{channelLabel(p.channel)}</span>
                <div style={{ minWidth: 0 }}>
                  <Link to={`/c/${p.candidateId}`} style={{ fontWeight: 600, color: "var(--ink)" }}>{p.candidateTitle}</Link>
                  <div className="tiny muted">{fmtDate(p.publishedAt)} · <a href={p.url} target="_blank" rel="noreferrer">{p.url.replace(/^https?:\/\//, "").slice(0, 60)}</a></div>
                </div>
                <div className="row" style={{ gap: 10 }}>
                  <div className="small muted" style={{ textAlign: "right" }}>
                    <div>{t("스타")} {p.baselineStars ?? "?"} → {p.latestStars ?? "?"} {delta !== undefined && <span className={`delta ${delta > 0 ? "up" : ""}`}>{delta > 0 ? `+${delta}` : delta}</span>}</div>
                    {p.excessStars7d !== undefined && <div className="tiny muted" title={t("발행 후 7일 증가에서, 발행 전 7일 추세가 이어졌다면 늘었을 만큼을 뺀 값입니다.")}>{t("추세 대비 {excess} (7일 {observed}, 기대 {expected})", { excess: signed(p.excessStars7d), observed: signed(p.starDelta7d ?? 0), expected: signed(p.expectedStarDelta7d ?? 0) })}</div>}
                    {p.series.at(-1)?.uniques !== undefined && <div>{t("방문자 14일 {n}", { n: p.series.at(-1)?.uniques })}</div>}
                  </div>
                  <MetricChart series={p.series} publishedAt={p.publishedAt} baseline={p.baselineStars} />
                </div>
                {p.autoStats ? <span className="small muted" title={`${t("자동 수집")} (${p.autoStats.source}) · ${p.autoStatsAt ? fmtDate(p.autoStatsAt) : ""}`}>{p.autoStats.score !== undefined ? t("점수 {score} · 댓글 {comments}", { score: p.autoStats.score, comments: p.autoStats.comments ?? 0 }) : `♥ ${p.autoStats.likes ?? 0} · ↻ ${p.autoStats.reposts ?? 0} · ${t("답글 {n}", { n: p.autoStats.comments ?? 0 })}${p.autoStats.views ? ` · ${t("조회 {n}", { n: p.autoStats.views })}` : ""}`} <span className="badge ok">{t("자동")}</span></span> : <ManualStats id={p.id} stats={p.manualStats} />}
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
  const [error, setError] = useState<string | null>(null);
  const [v, setV] = useState({ likes: stats?.likes ?? 0, comments: stats?.comments ?? 0, reposts: stats?.reposts ?? 0 });
  if (!open) return <button className="ghost sm" onClick={() => { setError(null); setOpen(true); }}>{stats ? `${t("반응")} ${stats.likes ?? 0}·${stats.comments ?? 0}·${stats.reposts ?? 0}` : t("반응 입력")}</button>;
  return (
    <div className="row small" style={{ gap: 6 }}>
      {(["likes", "comments", "reposts"] as const).map((k) => <input key={k} type="number" value={v[k]} style={{ width: 64 }} title={k} onChange={(ev) => setV({ ...v, [k]: Number(ev.target.value) })} />)}
      <button className="sm" onClick={async () => { setError(null); try { await post(`/publications/${id}/stats`, v); setOpen(false); } catch (err) { setError((err as Error).message); } }}>{t("저장")}</button>
      {error && <span role="alert" className="tiny">{t("저장하지 못했습니다.")} {error}</span>}
    </div>
  );
}

const signed = (n: number) => `${n > 0 ? "+" : ""}${n}`;
/** 추세를 알면 발행 효과(추세 대비), 모르면 7일 증가만. */
function starText(g: { avgStarDelta?: number; avgExcessStars?: number }): string {
  if (g.avgExcessStars !== undefined) return t("추세 대비 스타 {n}", { n: signed(g.avgExcessStars) });
  return g.avgStarDelta !== undefined ? t("스타 {n}", { n: signed(g.avgStarDelta) }) : t("스타 -");
}
