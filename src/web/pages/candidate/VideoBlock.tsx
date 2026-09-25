import { useEffect, useState } from "react";
import type { Draft } from "@shared/types";
import { Link } from "react-router-dom";
import { DEFAULT_VIDEO_DURATION, renderUnsettled, VIDEO_ASPECTS, VIDEO_DURATIONS, type VideoAspect, type VideoConfigView, type VideoItem } from "@shared/video";
import { channelLabel, fmtDate } from "../../components/ui";
import { apiBlob, post, useResource } from "../../lib/api";
import { t } from "../../i18n";

/**
 * 글감 → 짧은 영상. 영상 서버가 설정돼 있을 때만 보인다.
 * 연출은 사용자의 컴퓨터에서 bridge가 띄운 Claude Code가 하므로, bridge가 꺼져 있으면 "대기"에 머문다.
 */
function phaseText(v: VideoItem): string {
  if (v.status === "done") return t("완료");
  if (v.status === "failed") return t("실패");
  const p = v.phase;
  const pct = /^Rendering (\d+)%$/.exec(p);
  if (pct) return t("렌더링 {n}%", { n: pct[1] });
  const known: Record<string, string> = {
    "Waiting for a local Claude Code bridge": t("로컬 Claude Code bridge를 기다리는 중"),
    "Writing the scene": t("장면을 쓰는 중"),
    "Checking the scene": t("장면을 검사하는 중"),
    "Fixing the scene": t("검사에서 나온 문제를 고치는 중"),
    "Scene passed the check": t("검사 통과, 렌더링 준비 중"),
    Rendering: t("렌더링 중"),
  };
  return known[p] ?? p;
}

const draftStatus = (s: Draft["status"]) => (s === "copied" ? t("복사함") : s === "edited" ? t("수정함") : t("제안"));

function Player({ video, repo }: { video: VideoItem; repo: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true, made: string | null = null;
    apiBlob(`/videos/${video.id}/file`).then((b) => { if (!alive) return; made = URL.createObjectURL(b); setUrl(made); }).catch(() => alive && setFailed(true));
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [video.id]);
  if (failed) return <p className="small muted">{t("영상 파일을 불러오지 못했습니다.")}</p>;
  if (!url) return <div className="video-frame" style={{ aspectRatio: video.aspect === "1:1" ? "1 / 1" : "16 / 9" }} />;
  return (
    <>
      <video className="video-frame" src={url} controls playsInline style={{ aspectRatio: video.aspect === "1:1" ? "1 / 1" : "16 / 9" }} />
      <a className="btn sm" href={url} download={`${repo.split("/").pop()}-${video.id}.mp4`}>{t("MP4 내려받기")}</a>
    </>
  );
}

export default function VideoBlock({ cid, repo, drafts }: { cid: number; repo: string; drafts: Draft[] }) {
  const { data: cfg, reload: reloadCfg } = useResource<VideoConfigView>("/video", []);
  const enabled = Boolean(cfg?.enabled);
  const { data: videos, reload } = useResource<VideoItem[]>(enabled ? `/candidates/${cid}/videos` : null, []);
  const [duration, setDuration] = useState<number>(DEFAULT_VIDEO_DURATION);
  const [aspect, setAspect] = useState<VideoAspect>("16:9");
  const [draftId, setDraftId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = videos?.some(renderUnsettled) ?? false;

  // 진행 중이거나 연출 메모를 기다리는 영상이 있으면 5초마다 상태를 다시 받는다(서버가 영상 서버에 물어 갱신한다).
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => { reload(); reloadCfg(); }, 5000);
    return () => clearInterval(timer);
  }, [open, reload, reloadCfg]);

  if (!enabled) return null;
  const usable = drafts.filter((d) => d.status !== "dropped").sort((a, b) => b.updatedAt - a.updatedAt);

  const start = async () => {
    setBusy(true); setError(null);
    try {
      await post(`/candidates/${cid}/videos`, { durationSec: duration, aspect, draftId: draftId ? Number(draftId) : undefined });
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="side-block video-block">
      <h2>{t("짧은 영상")}</h2>
      <p className="small muted" style={{ marginTop: 0 }}>{t("근거 사실과 고른 초안으로 {n}초 안팎의 영상을 만듭니다. 화면에 나오는 숫자는 초안과 같은 근거로 검사합니다.", { n: duration })}</p>
      <div className="row wrap" style={{ gap: 8 }}>
        <div className="seg" role="group" aria-label={t("길이")}>{VIDEO_DURATIONS.map((d) => <button key={d} aria-pressed={d === duration} className={d === duration ? "active" : ""} onClick={() => setDuration(d)}>{t("{n}초", { n: d })}</button>)}</div>
        <div className="seg" role="group" aria-label={t("비율")}>{VIDEO_ASPECTS.map((a) => <button key={a} aria-pressed={a === aspect} className={a === aspect ? "active" : ""} onClick={() => setAspect(a)}>{a}</button>)}</div>
        <select value={draftId} onChange={(e) => setDraftId(e.target.value)} aria-label={t("대본으로 쓸 초안")}>
          <option value="">{t("대본: 자동 (검수한 짧은 초안)")}</option>
          {usable.map((d) => <option key={d.id} value={d.id}>{`${channelLabel(d.channel)} · ${d.lang.toUpperCase()} v${d.version} · ${draftStatus(d.status)}`}</option>)}
        </select>
        <button className="primary sm" disabled={busy} onClick={() => void start()}>{busy ? t("요청하는 중…") : t("영상 만들기")}</button>
      </div>
      <p className="tiny muted" style={{ margin: 0 }}>
        {cfg?.bridgeConnected ? <><span className="badge ok">{t("bridge 연결됨")}</span> {t("요청하면 내 컴퓨터의 Claude Code가 바로 시작합니다.")}</> : <><span className="badge outline">{t("bridge 없음")}</span> {t("연결된 bridge가 없어 요청은 대기합니다.")} <Link to="/settings?tab=model">{t("설정 › 모델에서 토큰 만들기")}</Link></>}
      </p>
      {error && <p className="small" style={{ color: "var(--danger)" }}>{error}</p>}
      {videos?.length ? (
        <div className="stack" style={{ marginTop: 12 }}>
          {videos.map((v) => (
            <div key={v.id} className="video-item">
              <div className="row between small">
                <span><span className={`badge ${v.status === "done" ? "ok" : v.status === "failed" ? "bad" : ""}`}>{renderUnsettled(v) && <span className="dot" />}{phaseText(v)}</span> <span className="muted">{t("{n}초", { n: v.durationSec })} · {v.aspect} · {v.lang.toUpperCase()}</span></span>
                <span className="muted">{fmtDate(v.createdAt)}</span>
              </div>
              {v.status === "queued" && !cfg?.bridgeConnected && <p className="tiny muted">{t("bridge가 연결되면 시작합니다.")}</p>}
              {v.status === "done" && <Player video={v} repo={repo} />}
              {v.note && <p className="tiny muted" style={{ whiteSpace: "pre-line" }}><b>{t("연출 메모")}</b> {v.note}</p>}
              {v.error && <p className="tiny" style={{ color: "var(--danger)" }}>{v.error}</p>}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
