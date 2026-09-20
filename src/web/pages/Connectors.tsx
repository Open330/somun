import { useState } from "react";
import type { ConnectorsView, Source } from "@shared/types";
import { fmtDate, relTime } from "../components/ui";
import { del, post, useResource } from "../lib/api";

/** 무엇을 읽는가. GitHub(권한 허용 또는 저장소 지정), 세션 업로더. 앱 자체는 운영자가 준비한다. */
export default function Connectors() {
  const { data: v } = useResource<ConnectorsView>("/connectors", ["sources", "candidates"]);
  const { data: sources } = useResource<Source[]>("/sources", ["sources"]);
  const { data: app } = useResource<{ configured: boolean; slug?: string; installUrl?: string }>("/github/app", []);
  const [targets, setTargets] = useState("");
  const [busy, setBusy] = useState(false);
  if (!v) return <div className="empty">불러오는 중…</div>;
  const manualSources = (sources ?? []).filter((s) => s.kind === "github" && !s.options?.installationId);
  const origin = window.location.origin;
  const token = (() => { try { return localStorage.getItem("somun.token"); } catch { return null; } })();

  return (
    <>
      <div className="page-head"><div><h1>연결</h1><p className="lede">소문이 읽는 곳. 프롬프트 원문은 사용자의 컴퓨터를 떠나지 않습니다.</p></div></div>

      <h2>GitHub</h2>
      <div className="card stack" style={{ gap: 14 }}>
        <div className="row between wrap">
          <div>
            <h3>저장소 읽기 권한 {v.github.installations.length ? <span className="badge ok">허용됨</span> : v.github.mode === "token" ? <span className="badge warn">서버 토큰</span> : <span className="badge">아직</span>}</h3>
            <p className="small muted" style={{ margin: 0 }}>조직이나 저장소에 읽기 권한을 주면 릴리스·PR·커밋·스타를 읽고, push와 release가 생기는 즉시 글감을 갱신합니다. 쓰기 권한은 요청하지 않습니다.</p>
          </div>
          {app?.installUrl && <a className="btn primary" href={app.installUrl}>{v.github.installations.length ? "다른 계정·저장소 추가" : "GitHub 권한 허용"}</a>}
        </div>
        {v.github.installations.length > 0 && (
          <div className="list">{v.github.installations.map((i) => <div key={i.id} className="row between small"><span><span className="badge outline">{i.account}</span> 접근 가능 {i.repos}개 · 지켜보는 중 {i.watched}개</span><span className="row" style={{ gap: 8 }}><span className="muted">갱신 {relTime(i.updatedAt)}</span><a className="btn sm" href={`/github/pick?installation_id=${i.id}`}>저장소 고르기</a></span></div>)}</div>
        )}
        {!app?.configured && <p className="small muted">이 서버는 아직 GitHub 연동이 준비되지 않았습니다. 운영자가 설정하면 여기에 "GitHub 권한 허용" 버튼이 나타납니다. 그때까지는 아래에 저장소를 직접 지정할 수 있습니다.</p>}
        <details className="raw">
          <summary>저장소 직접 지정 (권한 허용 없이, 서버 토큰으로 읽기)</summary>
          <div className="row" style={{ marginTop: 8 }}>
            <input placeholder="Open330, you/repo" value={targets} onChange={(ev) => setTargets(ev.target.value)} />
            <button disabled={!targets.trim() || busy} onClick={async () => { setBusy(true); try { await post("/sources", { kind: "github", targets: targets.split(",").map((t) => t.trim()).filter(Boolean), enabled: true }); setTargets(""); } finally { setBusy(false); } }}>추가</button>
          </div>
          <div className="list" style={{ marginTop: 8 }}>
            {manualSources.map((s) => (
              <div key={s.id} className="row between small">
                <span>{s.targets.join(", ")}{s.lastPolledAt && <span className="muted"> · 마지막 확인 {fmtDate(s.lastPolledAt)}</span>}{s.lastError && <span className="badge bad" title={s.lastError}>오류</span>}</span>
                <span className="toolbar"><button className="sm" onClick={() => void post("/sources", { id: s.id, kind: s.kind, targets: s.targets, options: s.options, enabled: !s.enabled })}>{s.enabled ? "끄기" : "켜기"}</button><button className="sm danger" onClick={() => void del(`/sources/${s.id}`)}>삭제</button></span>
              </div>
            ))}
          </div>
        </details>
      </div>

      <h2>코딩 에이전트 세션</h2>
      <div className="card stack" style={{ gap: 12 }}>
        <div className="row between wrap">
          <div>
            <h3>세션 업로더 {v.sessions.lastUploadAt ? <span className="badge ok">마지막 {relTime(v.sessions.lastUploadAt)}</span> : <span className="badge">아직 없음</span>}</h3>
            <p className="small muted" style={{ margin: 0 }}>Claude Code, Codex, oh-my-prompt 세션을 <b>로컬에서 요약</b>해 요약만 올립니다. 저장소별 세션 수, 재시도 흔적, 가장 긴 세션의 주제. 원문은 올라가지 않습니다.</p>
          </div>
          <div className="small muted">최근 14일 세션 {v.sessions.sessionCount14d}개{v.sessions.sources.length ? ` · ${v.sessions.sources.join(", ")}` : ""}</div>
        </div>
        <pre className="evidence">{`# 내 컴퓨터에서
git clone https://github.com/Open330/somun && cd somun && npm install
SOMUN_URL=${origin} SOMUN_TOKEN=${token ?? "<접근 토큰>"} npm run push -- --days 14
# 미리 보기만: npm run push -- --dry-run`}</pre>
        <p className="tiny muted">매일 자동으로 올리려면 위 명령을 cron이나 launchd에 넣으세요.</p>
      </div>
    </>
  );
}
