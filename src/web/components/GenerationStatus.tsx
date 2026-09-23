import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { JobProgress } from "@shared/types";
import { post, useResource } from "../lib/api";
import { CHANNEL_LABEL } from "./ui";

const labels: Record<JobProgress["kind"], string> = { digest: "변경 내용 정리", judge: "게시 가치 판단", draft: "초안 작성", lesson: "문체 규칙 찾기", profile: "프로젝트 프로필 만들기" };
export function GenerationStatus({ candidateId, candidateTitles, onChange }: { candidateId?: number; candidateTitles?: Record<number, string>; onChange: () => void }) {
  const { data, error, reload } = useResource<JobProgress[]>(`/jobs/status${candidateId === undefined ? "" : `?candidateId=${candidateId}`}`, ["jobs"]);
  const [retrying, setRetrying] = useState<number | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const signature = data?.map((job) => `${job.id}:${job.status}`).join(",");
  useEffect(() => { if (signature) onChange(); }, [signature, onChange]);
  const pending = (data ?? []).some((job) => job.status === "pending" || job.status === "claimed");
  // SSE is the fast path; polling covers missed events, only while work is in flight and the tab is visible.
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") reload(); }, 5000);
    return () => window.clearInterval(timer);
  }, [pending, reload]);
  if (error) return <div className="inline-notice is-error" role="alert"><span>생성 상태를 확인하지 못했습니다. 작업은 서버에서 계속될 수 있습니다.</span><button onClick={reload}>상태 다시 확인</button></div>;
  const jobs = (data ?? []).filter((job) => candidateId !== undefined || job.status !== "done");
  if (!jobs.length) return null;
  const active = jobs.some((job) => job.status === "pending" || job.status === "claimed");
  return <section className="generation-status" aria-label="생성 진행 상태">
    <div className="row between wrap"><b>{active ? "초안을 준비하고 있어요" : jobs.some((job) => job.status === "failed") ? "생성 상태를 확인해 주세요" : "생성 작업이 완료됐어요"}</b><span className="tiny muted">새로고침해도 상태가 유지됩니다</span></div>
    <p className="small muted">{active ? "모델 응답이나 사용 한도 때문에 기다릴 수 있습니다. 이 화면을 떠나도 접수한 작업은 계속됩니다." : jobs.some((job) => job.status === "failed") ? "실패 이유를 확인한 뒤 다시 시도해 주세요. 이미 완성된 초안은 유지됩니다." : "단계별 처리 결과와 완성된 초안을 확인해 주세요."}</p>
    <ul className="generation-jobs" aria-live="polite">
      {jobs.map((job) => <li key={job.id}>
        <div className="row wrap"><span>{labels[job.kind]}{job.repo ? ` · ${job.repo}` : ""}{job.channel ? ` · ${CHANNEL_LABEL[job.channel]} ${job.lang?.toUpperCase()}` : ""}</span><span className={`badge ${job.status === "failed" ? "bad" : job.status === "done" ? "ok" : "outline"}`}>{job.status === "claimed" ? "진행 중" : job.status === "pending" ? job.executor === "local" ? "로컬 워커 대기" : "순서 대기" : job.status === "done" ? "완료" : "실패"}</span>{candidateId === undefined && job.candidateId > 0 && <Link to={`/c/${job.candidateId}`}>{candidateTitles?.[job.candidateId] ?? "글감 보기"}</Link>}</div>
        {job.status === "pending" && job.executor === "local" && <p className="small muted">내 컴퓨터의 워커를 실행해 주세요. <Link to="/settings?tab=model">실행 방법</Link></p>}
        {job.status === "failed" && <div className="row wrap"><span className="small">{job.error ?? "작업을 완료하지 못했습니다."}</span><button className="sm" disabled={retrying !== null} onClick={async () => { setRetrying(job.id); setRetryError(null); try { await post(`/jobs/${job.id}/retry`); reload(); } catch (err) { setRetryError((err as Error).message); } finally { setRetrying(null); } }}>{retrying === job.id ? "접수 중…" : "다시 시도"}</button><Link className="small" to="/settings?tab=model">모델 설정</Link></div>}
      </li>)}
    </ul>
    {retryError && <p role="alert" className="small">다시 요청하지 못했습니다. {retryError}</p>}
  </section>;
}
