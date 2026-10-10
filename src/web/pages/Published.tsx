import { useState } from "react";
import { Link } from "react-router-dom";
import type { PerformanceSummary, PublicationStats, PublicationWithMetrics } from "@shared/types";
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
      <header className="page-head workspace-head">
        <div>
          <h1>{t("발행 기록")}</h1>
          <p className="lede">{t("직접 게시한 글을 모아보고, 게시 후 어떤 변화가 있었는지 확인하세요.")}</p>
        </div>
        {rows && rows.length > 0 && (
          <div className="toolbar">
            <button
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                setRefreshError(null);
                try {
                  await post("/publications/refresh");
                  reload();
                } catch (err) {
                  setRefreshError(`${t("반응을 가져오지 못했습니다.")} ${(err as Error).message}`);
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              {refreshing ? t("확인 중…") : t("반응 새로 받기")}
            </button>
          </div>
        )}
      </header>
      {refreshError && (
        <div className="inline-notice is-error" role="alert">
          {refreshError}
        </div>
      )}
      {rows === undefined ? (
        <Skeleton rows={3} />
      ) : rows.length === 0 ? (
        <div className="state-panel">
          <h2>{t("아직 발행한 글이 없습니다.")}</h2>
          <p>{t("초안을 검토해 원하는 채널에 올리고, 초안 화면에 게시 링크를 남겨주세요. 여기에 발행 기록과 지표가 쌓입니다.")}</p>
          <Link to="/" className="btn primary">
            {t("글감에서 초안 고르기")}
          </Link>
        </div>
      ) : (
        <>
          {summary && (summary.byChannel.length > 1 || summary.byVoice.length > 1) && (
            <div className="perf">
              <div className="perf-col">
                <div className="tiny muted mb-6">{t("채널별 · 7일 스타 관측")}</div>
                {summary.byChannel.map((g) => (
                  <div key={g.key} className="stack gap-4 mb-10">
                    <div className="perf-row">
                      <span>
                        {channelLabel(g.key)} <span className="muted">{g.count}</span>
                      </span>
                      <span className="mono">{starText(g)}</span>
                    </div>
                    <div className="row wrap gap-6 tiny muted">
                      <span className="badge outline">{t("관측 완료 {n}건", { n: g.measured ?? 0 })}</span>
                      {Boolean(g.pending) && <span className="badge outline">{t("관측 중 {n}건", { n: g.pending ?? 0 })}</span>}
                      {Boolean(g.unattributed) && (
                        <span className="badge outline">{t("기여 구분 불가 {n}건", { n: g.unattributed ?? 0 })}</span>
                      )}
                      {g.avgLikes !== undefined && <span>{t("누적 반응 평균 {n}", { n: g.avgLikes })}</span>}
                    </div>
                  </div>
                ))}
              </div>
              <div className="perf-col">
                <div className="tiny muted mb-6">{t("문체별 · 7일 스타 관측")}</div>
                {summary.byVoice.map((g) => (
                  <div key={g.key} className="perf-row">
                    <span>
                      {g.key === "unknown" ? t("문체 미기록") : t(VOICE_PRESETS.find((v) => v.id === g.key)?.name ?? g.key)}{" "}
                      <span className="muted">{g.count}</span>
                    </span>
                    <span className="mono">
                      {starText(g)}
                      {g.avgLikes !== undefined ? ` · ${t("누적 반응 평균 {n}", { n: g.avgLikes })}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {rows.length > 0 && !rows.some((p) => p.series.some((s) => s.uniques !== undefined)) && (
            <p className="tiny muted">
              {t(
                "방문자 수는 GitHub 트래픽 API에서 가져옵니다. 저장소 관리 권한이 있는 토큰으로 수집할 때만 표시되며, 소문 GitHub App에는 이 권한을 요청하지 않습니다.",
              )}
            </p>
          )}
          <p className="tiny muted">
            {t("통계는 관측 결과이며 홍보의 인과 효과를 입증하지 않습니다. 같은 저장소의 동시 게시물은 채널별 스타 평균에서 제외합니다.")}
          </p>
          <div className="rows">
            {rows.map((p) => {
              const delta = p.latestStars !== undefined && p.baselineStars !== undefined ? p.latestStars - p.baselineStars : undefined;
              return (
                <div key={p.id} className="pub">
                  <span className="badge outline">{channelLabel(p.channel)}</span>
                  <div className="min-w-0">
                    <Link to={`/c/${p.candidateId}${p.draftId ? `?draft=${p.draftId}` : ""}`} className="pub-title">
                      {p.candidateTitle}
                    </Link>
                    <div className="tiny muted">
                      {fmtDate(p.publishedAt)} ·{" "}
                      {p.url ? (
                        <a href={p.url} target="_blank" rel="noreferrer">
                          {p.url.replace(/^https?:\/\//, "").slice(0, 60)}
                        </a>
                      ) : (
                        <span>{t("게시 확인됨 · 링크 미등록")}</span>
                      )}
                    </div>
                  </div>
                  <div className="row gap-10">
                    <div className="small muted pub-stars">
                      {p.observationStatus === "pending" && <div>{t("7일 관측 중 · 추천 성과에서 제외")}</div>}
                      {p.observationStatus === "insufficient" && <div>{t("7일 관측 자료 부족 · 추천 성과에서 제외")}</div>}
                      {Boolean(p.sharedWith) && <div>{t("동시 게시 · 채널별 스타 기여 구분 불가")}</div>}
                      <div>
                        {t("스타")} {p.baselineStars ?? "?"} → {p.latestStars ?? "?"}{" "}
                        {delta !== undefined && (
                          <span className={`delta ${delta > 0 ? "up" : ""}`} title={t("발행 직전부터 지금까지 늘어난 스타")}>
                            ({t("변화 {n}", { n: delta > 0 ? `+${delta}` : String(delta) })})
                          </span>
                        )}
                      </div>
                      {p.excessStars7d !== undefined && (
                        <div
                          className="tiny muted"
                          title={t("발행 후 7일 증가에서, 발행 전 7일 추세가 이어졌다면 늘었을 만큼을 뺀 값입니다.")}
                        >
                          {t("추세 대비 {excess} (7일 {observed}, 기대 {expected})", {
                            excess: signed(p.excessStars7d),
                            observed: signed(p.starDelta7d ?? 0),
                            expected: signed(p.expectedStarDelta7d ?? 0),
                          })}
                        </div>
                      )}
                      {p.series.at(-1)?.uniques !== undefined && <div>{t("방문자 14일 {n}", { n: p.series.at(-1)?.uniques })}</div>}
                    </div>
                    <MetricChart series={p.series} publishedAt={p.publishedAt} baseline={p.baselineStars} />
                  </div>
                  {p.autoStats ? (
                    <span
                      className="small muted"
                      title={`${t("자동 수집")} (${p.autoStats.source}) · ${p.autoStatsAt ? fmtDate(p.autoStatsAt) : ""}`}
                    >
                      {p.autoStats.score !== undefined
                        ? t("점수 {score} · 댓글 {comments}", { score: p.autoStats.score, comments: p.autoStats.comments ?? 0 })
                        : `♥ ${p.autoStats.likes ?? 0} · ↻ ${p.autoStats.reposts ?? 0} · ${t("답글 {n}", { n: p.autoStats.comments ?? 0 })}${p.autoStats.views ? ` · ${t("조회 {n}", { n: p.autoStats.views })}` : ""}`}{" "}
                      <span className="badge ok">{t("자동")}</span>
                    </span>
                  ) : null}
                  <ManualStats id={p.id} stats={p.manualStats} />
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

const STAT_LABELS = {
  likes: "좋아요 수",
  comments: "댓글 수",
  reposts: "리포스트 수",
  visits: "게시글 방문 수",
  installs: "게시글 설치 수",
  signups: "게시글 가입 수",
} as const;
const STAT_KEYS = Object.keys(STAT_LABELS) as (keyof PublicationStats)[];

function ManualStats({ id, stats }: { id: number; stats?: PublicationStats }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState(
    () =>
      Object.fromEntries(STAT_KEYS.map((k) => [k, stats?.[k] === undefined ? "" : String(stats[k])])) as Record<
        keyof PublicationStats,
        string
      >,
  );
  const [saved, setSaved] = useState<{ source?: PublicationStats; value: PublicationStats }>();
  const displayed = saved && saved.source === stats ? saved.value : stats;
  const invalid = STAT_KEYS.some((k) => values[k] !== "" && (!Number.isSafeInteger(Number(values[k])) || Number(values[k]) < 0));
  return (
    <div className="publication-stats stack gap-6">
      {displayed && (
        <p className="small muted m-0">
          {t("직접 기록")}:{" "}
          {STAT_KEYS.filter((k) => displayed[k] !== undefined)
            .map((k) => `${t(STAT_LABELS[k])} ${displayed[k]}`)
            .join(" · ") || t("미측정")}
        </p>
      )}
      {!open ? (
        <button
          className="ghost sm"
          onClick={() => {
            setError(null);
            setValues(
              Object.fromEntries(STAT_KEYS.map((k) => [k, displayed?.[k] === undefined ? "" : String(displayed[k])])) as Record<
                keyof PublicationStats,
                string
              >,
            );
            setOpen(true);
          }}
        >
          {t("성과·반응 입력")}
        </button>
      ) : (
        <>
          <p className="tiny muted m-0">
            {t("외부 분석에서 확인한 게시글별 수치를 입력하세요. 비워 두면 미측정이며 자동 수집한 값이 아닙니다.")}
          </p>
          <div className="row wrap gap-8">
            {STAT_KEYS.map((k) => (
              <label className="field" key={k}>
                <span>{t(STAT_LABELS[k])}</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={values[k]}
                  className="num-input"
                  onChange={(ev) => setValues({ ...values, [k]: ev.target.value })}
                />
              </label>
            ))}
          </div>
          <div className="toolbar">
            <button
              className="sm"
              disabled={invalid}
              onClick={async () => {
                setError(null);
                const input = Object.fromEntries(STAT_KEYS.filter((k) => values[k] !== "").map((k) => [k, Number(values[k])]));
                try {
                  await post(`/publications/${id}/stats`, input);
                  setSaved({ source: stats, value: input });
                  setOpen(false);
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              {t("저장")}
            </button>
            <button className="ghost sm" onClick={() => setOpen(false)}>
              {t("취소")}
            </button>
          </div>
          {error && (
            <span role="alert" className="tiny">
              {t("저장하지 못했습니다.")} {error}
            </span>
          )}
        </>
      )}
    </div>
  );
}

const signed = (n: number) => `${n > 0 ? "+" : ""}${n}`;
/** 추세를 알면 발행 효과(추세 대비), 모르면 7일 증가만. */
function starText(g: { avgStarDelta?: number; avgExcessStars?: number }): string {
  if (g.avgExcessStars !== undefined) return t("추세 대비 스타 {n}", { n: signed(g.avgExcessStars) });
  return g.avgStarDelta !== undefined ? t("스타 {n}", { n: signed(g.avgStarDelta) }) : t("스타 -");
}
