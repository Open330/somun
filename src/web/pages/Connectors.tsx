import { useState } from "react";
import type { ConnectorsView, Source } from "@shared/types";
import { fmtDate } from "../components/ui";
import { del, post, useResource } from "../lib/api";

/** 무엇을 읽는가. GitHub(App 설치 또는 저장소 지정), 세션 업로더. */
export default function Connectors() {
  const { data: v } = useResource<ConnectorsView>("/connectors", ["sources", "candidates"]);
  const { data: sources } = useResource<Source[]>("/sources", ["sources"]);
  const { data: app } = useResource<{ configured: boolean; slug?: string; installUrl?: string; manifest: Record<string, unknown>; createUrl: string }>("/github/app", []);
  const [targets, setTargets] = useState("");
  const [busy, setBusy] = useState(false);
  if (!v) return <div className="empty">불러오는 중…</div>;
  const manualSources = (sources ?? []).filter((s) => s.kind === "github" && !s.options?.installationId);
  const origin = window.location.origin;
  const token = (() => { try { return localStorage.getItem("somun.token"); } catch { return null; } })();

  return (
    <>
      <div className="page-head">
        <div><h1>Connectors</h1><p className="lede">소문이 읽는 곳. 프롬프트 원문은 사용자의 컴퓨터를 떠나지 않습니다.</p></div>
      </div>

      <h2>GitHub</h2>
      <div className="card stack" style={{ gap: 14 }}>
        <div className="row between wrap">
          <div>
            <h3>GitHub App {v.github.mode === "app" ? <span className="badge ok">설치됨</span> : v.github.mode === "token" ? <span className="badge warn">서버 토큰</span> : <span className="badge">미연결</span>}</h3>
            <p className="small muted" style={{ margin: 0 }}>조직이나 저장소에 설치하면 릴리스·PR·커밋·스타를 최소 권한으로 읽고, push와 release 이벤트가 오는 즉시 글감을 갱신합니다.</p>
          </div>
          {app?.installUrl ? <a className="btn primary" href={app.installUrl} target="_blank" rel="noreferrer">GitHub에 설치</a> : null}
        </div>
        {v.github.installations.length > 0 && (
          <div className="list">
            {v.github.installations.map((i) => (
              <div key={i.id} className="row between small"><span><span className="badge outline">{i.account}</span> 저장소 {i.repos}개</span><span className="muted">갱신 {fmtDate(i.updatedAt)}</span></div>
            ))}
          </div>
        )}
        {!app?.configured && (
          <div className="card" style={{ background: "var(--surface-2)", borderStyle: "dashed" }}>
            <p className="small" style={{ marginBottom: 8 }}><b>이 서버에는 아직 GitHub App이 없습니다.</b> 한 번만 만들면 됩니다. 아래 폼을 제출하면 GitHub가 앱을 만들고 자격 증명을 이 서버에 돌려줍니다.</p>
            <form method="post" action={app?.createUrl ?? "https://github.com/settings/apps/new"} target="_blank">
              <input type="hidden" name="manifest" value={JSON.stringify(app?.manifest ?? {})} />
              <button className="primary sm" type="submit">GitHub에서 somun 앱 만들기</button>
            </form>
            <p className="tiny muted" style={{ marginTop: 8 }}>조직에 만들려면 URL을 <code>https://github.com/organizations/&lt;org&gt;/settings/apps/new</code>로 바꿔 제출하세요. 만들어진 뒤 "GitHub에 설치"가 나타납니다.</p>
          </div>
        )}
        <div>
          <h3 style={{ fontSize: 14 }}>저장소 직접 지정 <span className="tiny muted">(App 없이, 서버 토큰으로 읽기)</span></h3>
          <div className="row">
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
        </div>
      </div>

      <h2>코딩 에이전트 세션</h2>
      <div className="card stack" style={{ gap: 12 }}>
        <div className="row between wrap">
          <div>
            <h3>세션 업로더 {v.sessions.lastUploadAt ? <span className="badge ok">마지막 {fmtDate(v.sessions.lastUploadAt)}</span> : <span className="badge">아직 없음</span>}</h3>
            <p className="small muted" style={{ margin: 0 }}>Claude Code, Codex, oh-my-prompt 세션을 <b>로컬에서 요약</b>해 요약만 올립니다. 저장소별 세션 수, 재시도 흔적, 가장 긴 세션의 주제. 원문은 올라가지 않습니다.</p>
          </div>
          <div className="small muted">최근 14일 세션 {v.sessions.sessionCount14d}개{v.sessions.sources.length ? ` · ${v.sessions.sources.join(", ")}` : ""}</div>
        </div>
        <pre className="evidence">{`# 내 컴퓨터에서 (저장소 클론 안에서 실행할 필요 없음)
git clone https://github.com/Open330/somun && cd somun && npm install
SOMUN_URL=${origin} SOMUN_TOKEN=${token ?? "<접근 토큰>"} npm run push -- --days 14
# 미리 보기만: npm run push -- --dry-run`}</pre>
        <p className="tiny muted">매일 자동으로 올리려면 위 명령을 cron이나 launchd에 넣으세요. 세션이 붙은 저장소의 후보에는 "에이전트 세션" 근거가 추가됩니다.</p>
      </div>
    </>
  );
}
