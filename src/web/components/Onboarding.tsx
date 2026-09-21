import { Link } from "react-router-dom";
import type { CandidateListItem, ConnectorsView, Publication, SettingsView } from "@shared/types";
import { patch, useResource } from "../lib/api";

/**
 * 첫 실행 체크리스트. 서버 상태로 진행도를 계산하므로 브라우저가 바뀌어도 같다.
 * 다섯 단계가 끝나거나 사용자가 닫으면 사라진다.
 */
export function Onboarding({ rows }: { rows: CandidateListItem[] | undefined }) {
  const { data: conn } = useResource<ConnectorsView>("/connectors", ["sources"]);
  const { data: settings } = useResource<SettingsView>("/settings", ["settings"]);
  const { data: pubs } = useResource<Publication[]>("/publications", ["publications"]);
  if (!conn || !settings || rows === undefined) return null;
  if (settings.ui?.onboardingDismissedAt) return null;

  const connected = conn.github.installations.length > 0 || conn.github.manualTargets.length > 0;
  const watching = conn.github.installations.some((i) => i.watched > 0) || conn.github.manualTargets.length > 0;
  const channels = Object.values(settings.channelLangs).some((l) => l.length > 0);
  const judged = rows.some((c) => c.judgment);
  const posted = (pubs?.length ?? 0) > 0 || rows.some((c) => c.status === "published");
  const firstInst = conn.github.installations[0];
  const steps: { key: string; label: string; hint: string; done: boolean; to: string }[] = [
    { key: "connect", label: "GitHub 연결", hint: "읽기 권한만 요청합니다", done: connected, to: conn.github.installUrl && !connected ? conn.github.installUrl : "/connectors" },
    { key: "watch", label: "저장소 고르기", hint: "지켜볼 것만 고릅니다", done: watching, to: firstInst ? `/github/pick?installation_id=${firstInst.id}` : "/connectors" },
    { key: "channels", label: "채널·언어", hint: "올릴 곳과 언어를 정합니다", done: channels, to: "/settings" },
    { key: "voice", label: "문체 고르기", hint: "프리셋 하나와 내 지침", done: Boolean(settings.voice?.chosenAt), to: "/voice" },
    { key: "judge", label: "첫 판단", hint: "새 글감에서 '판단'을 누릅니다", done: judged, to: "/" },
    { key: "post", label: "첫 발행", hint: "복사해 올리고 URL을 등록합니다", done: posted, to: "/" },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return null;
  const nextKey = steps.find((s) => !s.done)?.key;

  return (
    <div className="onb" role="region" aria-label="시작하기">
      <div className="onb-head">
        <h2>시작하기 · {doneCount}/{steps.length}</h2>
        <button className="ghost sm" onClick={() => void patch("/settings", { ui: { onboardingDismissedAt: Date.now() } })}>닫기</button>
      </div>
      <div className="onb-bar"><i style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>
      <div className="onb-list">
        {steps.map((s) => {
          const cls = `onb-item ${s.done ? "done" : ""} ${s.key === nextKey ? "next" : ""}`;
          const inner = <><span className="tick">{s.done ? "✓" : ""}</span><div><b>{s.label}</b><span>{s.hint}</span></div></>;
          return s.to.startsWith("http") ? <a key={s.key} className={cls} href={s.to}>{inner}</a> : <Link key={s.key} className={cls} to={s.to}>{inner}</Link>;
        })}
      </div>
    </div>
  );
}
