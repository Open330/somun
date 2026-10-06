import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { CandidateListItem, JobProgress, ModelAvailability } from "@shared/types";
import { post, useResource } from "../lib/api";
import { dateLocale, t } from "../i18n";
import { channelLabel, fmtDate } from "./ui";
export const JOB_LABELS: Record<JobProgress["kind"], string> = {
  digest: "변경 내용 정리",
  judge: "게시 가치 판단",
  draft: "초안 작성",
  lesson: "문체 규칙 찾기",
  profile: "프로젝트 프로필 만들기",
};

const OPEN_EVENT = "somun:open-work-status";
export const openWorkspaceStatus = () => window.dispatchEvent(new Event(OPEN_EVENT));

export function useWorkspaceStatus() {
  const jobs = useResource<JobProgress[]>("/jobs/status", ["jobs"]);
  const availability = useResource<ModelAvailability>("/model-availability", ["keys", "settings", "jobs"]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, show);
    return () => window.removeEventListener(OPEN_EVENT, show);
  }, []);
  const pending = jobs.data?.some((j) => j.status === "pending" || j.status === "claimed");
  const waiting = availability.data?.models.some((m) => m.state === "waiting");
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      jobs.reload();
      availability.reload();
    };
    const timer = window.setInterval(refresh, pending || waiting ? 5000 : 60000);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pending, waiting, jobs.reload, availability.reload]);
  return { jobs, availability, open, setOpen };
}
type WorkspaceState = ReturnType<typeof useWorkspaceStatus>;

function groupJobs(jobs: JobProgress[]) {
  const groups = new Map<string, JobProgress[]>();
  for (const job of jobs) {
    const key = job.candidateId > 0 ? `candidate:${job.candidateId}` : `profile:${job.repo ?? job.id}`;
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }
  return [...groups.values()].map((jobs) => ({
    jobs: [...jobs].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id),
    status: jobs.some((j) => j.status === "claimed")
      ? "claimed"
      : jobs.some((j) => j.status === "pending")
        ? "pending"
        : jobs.some((j) => j.status === "failed")
          ? "failed"
          : "done",
  }));
}
const statusLabel = (job: JobProgress) =>
  job.status === "claimed"
    ? t("진행 중")
    : job.status === "pending"
      ? job.executor === "local"
        ? t("로컬 워커 대기")
        : t("순서 대기")
      : job.status === "failed"
        ? t("실패")
        : t("완료");

const modelStateLabel = (state: ModelAvailability["models"][number]["state"], short = false) =>
  ({
    ready: t("요청 가능"),
    waiting: t("일시 대기"),
    unknown: short ? t("제공사 한도") : t("제공사 한도 확인 필요"),
    local: short ? t("로컬 워커") : t("로컬 워커 사용"),
    missing: short ? t("연결 필요") : t("모델 연결 필요"),
  })[state];
const modelExplanation = (mode: ModelAvailability["mode"]) =>
  ({
    shared: t("공유 모델의 현재 요청 가능 여부와 내 계정의 실행 한도입니다. 제공사 응답에 따라 이용 상태가 달라질 수 있습니다."),
    user: t("개인 API 키의 남은 한도는 제공사에서 확인해 주세요."),
    local: t("로컬 워커 실행 여부와 구독 한도는 이 화면에서 확인할 수 없습니다."),
    missing: t("모델 설정에서 API 키를 등록하거나 로컬 에이전트를 선택해 주세요."),
  })[mode];

export function WorkStatusButton({ state, mobile = false }: { state: WorkspaceState; mobile?: boolean }) {
  const groups = groupJobs(state.jobs.data ?? []);
  const counts = (status: string) =>
    groups.filter((g) => (status === "failed" ? g.jobs.some((j) => j.status === "failed") : g.status === status)).length;
  const count = groups.filter((g) => g.status !== "done").length;
  const summary = [
    ["claimed", t("진행")],
    ["pending", t("대기")],
    ["failed", t("실패")],
  ]
    .filter(([status]) => counts(status))
    .map(([status, label]) => (status === "pending" ? t("대기 {n}", { n: counts(status) }) : `${label} ${counts(status)}`))
    .join(" · ");
  const current = state.jobs.data?.find((j) => j.status === "claimed") ?? state.jobs.data?.find((j) => j.status === "pending");
  return (
    <button
      className={mobile ? "mobile-work-button" : "workspace-button"}
      aria-expanded={state.open}
      aria-controls="workspace-status"
      onClick={() => state.setOpen(true)}
    >
      <b>
        {t("작업")}
        {mobile && count ? ` ${count}` : ""}
      </b>
      {!mobile && (
        <>
          <span className="small">
            {state.jobs.error
              ? t("상태 확인 필요")
              : state.jobs.data === undefined
                ? t("불러오는 중…")
                : summary || t("진행 중인 작업 없음")}
          </span>
          {current && (
            <span className="tiny work-current">
              {t(JOB_LABELS[current.kind])}
              {current.channel ? ` · ${channelLabel(current.channel)} ${current.lang?.toUpperCase()}` : ""}
            </span>
          )}
          <span className="tiny muted">
            {state.availability.error
              ? t("모델 이용 상태 확인")
              : (state.availability.data?.models
                  .map((m) => `${m.purpose === "draft" ? t("초안") : t("분석")} ${modelStateLabel(m.state, true)}`)
                  .join(" · ") ?? t("작업과 모델 이용 상태 보기"))}
          </span>
        </>
      )}
    </button>
  );
}

export function WorkStatusPanel({ state, candidates }: { state: WorkspaceState; candidates: CandidateListItem[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [retrying, setRetrying] = useState<number | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  useEffect(() => {
    if (state.open && !dialog.current?.open) dialog.current?.showModal();
    else if (!state.open && dialog.current?.open) dialog.current?.close();
  }, [state.open]);
  const titles = new Map(candidates.map((c) => [c.id, c.title]));
  const groups = groupJobs(state.jobs.data ?? []);
  const ongoing = groups.filter((g) => g.status !== "done");
  const completed = groups
    .filter((g) => g.status === "done" && g.jobs.some((j) => (j.finishedAt ?? 0) > Date.now() - 86400000))
    .slice(0, 5);
  const retry = async (id: number) => {
    setRetrying(id);
    setRetryError(null);
    try {
      await post(`/jobs/${id}/retry`);
      state.jobs.reload();
    } catch (error) {
      setRetryError((error as Error).message);
    } finally {
      setRetrying(null);
    }
  };
  const renderGroup = ({ jobs }: ReturnType<typeof groupJobs>[number]) => {
    const first = jobs[0];
    return (
      <li key={`${first.candidateId}:${first.repo ?? first.id}`} className="work-group">
        <div className="row between wrap">
          <b>{titles.get(first.candidateId) ?? first.repo ?? t("글감")}</b>
          {first.candidateId > 0 && (
            <Link to={`/c/${first.candidateId}`} onClick={() => state.setOpen(false)}>
              {t("결과 보기")}
            </Link>
          )}
        </div>
        <ul className="generation-jobs">
          {jobs.map((job) => (
            <li key={job.id}>
              <div className="row between wrap">
                <span>
                  {t(JOB_LABELS[job.kind])}
                  {job.channel ? ` · ${channelLabel(job.channel)} ${job.lang?.toUpperCase()}` : ""}
                </span>
                <span className={`badge ${job.status === "failed" ? "bad" : "outline"}`}>{statusLabel(job)}</span>
              </div>
              <span className="tiny muted">
                {t("접수")} {fmtDate(job.createdAt)}
              </span>
              {job.status === "pending" && job.executor === "local" && (
                <p className="small muted">
                  {t("내 컴퓨터의 워커를 실행해 주세요.")}{" "}
                  <Link to="/settings?tab=model" onClick={() => state.setOpen(false)}>
                    {t("실행 방법")}
                  </Link>
                </p>
              )}
              {job.status === "failed" && (
                <div className="stack">
                  <p className="small">{job.error ?? t("작업을 완료하지 못했습니다.")}</p>
                  <div className="row wrap">
                    <button className="sm" disabled={retrying !== null} onClick={() => void retry(job.id)}>
                      {retrying === job.id ? t("접수 중…") : t("다시 시도")}
                    </button>
                    <Link to="/settings?tab=model" onClick={() => state.setOpen(false)}>
                      {t("모델 설정")}
                    </Link>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </li>
    );
  };
  return (
    <dialog
      ref={dialog}
      id="workspace-status"
      className="workspace-dialog"
      aria-labelledby="workspace-status-title"
      onCancel={() => state.setOpen(false)}
      onClose={() => state.setOpen(false)}
    >
      <div className="row between">
        <h2 id="workspace-status-title">{t("내 계정 작업")}</h2>
        <button className="ghost" autoFocus onClick={() => state.setOpen(false)}>
          {t("닫기")}
        </button>
      </div>
      <p className="small muted">{t("새로고침하거나 화면을 떠나도 접수한 작업은 계속됩니다. 자동으로 시작된 작업도 포함합니다.")}</p>
      {state.jobs.error ? (
        <div className="inline-notice is-error" role="alert">
          <span>{t("생성 상태를 확인하지 못했습니다. 작업은 서버에서 계속될 수 있습니다.")}</span>
          <button onClick={state.jobs.reload}>{t("상태 다시 확인")}</button>
        </div>
      ) : state.jobs.data === undefined ? (
        <p>{t("불러오는 중…")}</p>
      ) : ongoing.length ? (
        <ul className="work-groups">{ongoing.map(renderGroup)}</ul>
      ) : (
        <p>{t("진행 중인 작업 없음")}</p>
      )}
      {retryError && (
        <p role="alert">
          {t("다시 요청하지 못했습니다.")} {retryError}
        </p>
      )}
      {completed.length > 0 && (
        <details>
          <summary>{t("최근 완료 작업")}</summary>
          <ul className="work-groups">{completed.map(renderGroup)}</ul>
        </details>
      )}
      <section className="model-availability" aria-label={t("모델 이용 상태")}>
        <h3>{t("모델 이용 상태")}</h3>
        {state.availability.error ? (
          <div className="inline-notice is-error" role="alert">
            <span>{t("모델 이용 상태를 확인하지 못했습니다.")}</span>
            <button onClick={state.availability.reload}>{t("상태 다시 확인")}</button>
          </div>
        ) : !state.availability.data ? (
          <p>{t("불러오는 중…")}</p>
        ) : (
          <>
            <ul className="generation-jobs">
              {state.availability.data.models.map((model) => (
                <li key={model.purpose}>
                  <b>{model.purpose === "draft" ? t("초안 작성") : t("분석·판단")}</b>
                  <p className="small">{model.model}</p>
                  <span className="small">
                    {modelStateLabel(model.state)}
                    {model.retryAt
                      ? ` · ${t("{when}부터 재시도 가능", { when: new Date(model.retryAt).toLocaleString(dateLocale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) })}`
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
            <p className="small muted">{modelExplanation(state.availability.data.mode)}</p>
            {state.availability.data.sharedUsage && (
              <p className="small muted">
                {t("오늘 공유 모델 실행 {used}/{limit}회 · 대기·실행 최대 {pending}개 · 초기화 {reset}", {
                  used: state.availability.data.sharedUsage.used,
                  limit: state.availability.data.sharedUsage.limit,
                  pending: state.availability.data.sharedUsage.pendingLimit,
                  reset: new Date(state.availability.data.sharedUsage.resetAt).toLocaleString(dateLocale(), {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                })}
              </p>
            )}
          </>
        )}
        <Link to="/settings?tab=model" onClick={() => state.setOpen(false)}>
          {t("모델 설정")}
        </Link>
      </section>
    </dialog>
  );
}
