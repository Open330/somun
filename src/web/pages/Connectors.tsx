import { useState } from "react";
import { Link } from "react-router-dom";
import type { ConnectorsView, Source } from "@shared/types";
import { ErrorState, Skeleton, relTime } from "../components/ui";
import { del, post, useResource } from "../lib/api";

export default function Connectors() {
  const { data: view, error, reload } = useResource<ConnectorsView>("/connectors", ["sources", "candidates"]);
  const { data: sources, error: sourceError, reload: reloadSources } = useResource<Source[]>("/sources", ["sources"]);
  const { data: app } = useResource<{ configured: boolean; installUrl?: string }>("/github/app", []);
  const [targets, setTargets] = useState("");
  const [feed, setFeed] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const refresh = () => { reload(); reloadSources(); };
  async function run(key: string, action: () => Promise<unknown>, message: string) {
    setBusy(key); setNotice(null);
    try { await action(); refresh(); setNotice({ text: message }); }
    catch (err) { setNotice({ text: `연결을 변경하지 못했습니다. ${(err as Error).message}`, error: true }); }
    finally { setBusy(null); }
  }
  if (error || sourceError) return <ErrorState title="연결 정보를 불러오지 못했습니다" message={error ?? sourceError!} onRetry={refresh} />;
  if (!view || !sources) return <Skeleton rows={3} />;
  const linked = sources.filter((s) => ["github", "blog"].includes(s.kind));
  return <>
    <header className="page-head workspace-head"><div><span className="eyebrow">글감이 시작되는 곳</span><h1>연결 관리</h1><p className="lede">저장소나 블로그 하나부터 시작하세요. 연결한 소스에서 변경을 모읍니다.</p></div>{linked.some((s) => s.enabled && s.targets.length) && <Link className="btn primary" to="/">글감 가져오러 가기 →</Link>}</header>
    {notice && <div className={`inline-notice ${notice.error ? "is-error" : ""}`} role={notice.error ? "alert" : "status"}><span>{notice.text}</span>{!notice.error && <Link to="/">글감으로 이동 →</Link>}</div>}
    <div className="connection-grid">
      <section className="card connection-card"><div className="connection-label"><span className="connection-symbol" aria-hidden>↗</span><span className="badge outline">릴리스 · 커밋 · PR</span></div><h2>GitHub 저장소</h2><p>프로젝트에서 바뀐 내용을 게시글의 근거로 가져옵니다. 앱 연결 시 읽기 권한만 요청합니다.</p>
        {app?.installUrl && <a className="btn primary" href={app.installUrl}>{view.github.installations.length ? "다른 저장소 연결" : "GitHub 연결하기 →"}</a>}
        {view.github.installations.map((installation) => <div className="installation-summary" key={installation.id}><div><b>{installation.account}</b><span className="small muted"> · {installation.watched}개 저장소 선택됨</span></div><Link to={`/github/pick?installation_id=${installation.id}`} className="btn sm">저장소 {installation.watched ? "변경" : "선택"}</Link></div>)}
        <details className="manual-connect" open={!app?.configured}><summary>저장소 직접 지정</summary><p className="small muted">공개 저장소는 주소 대신 <code>소유자/저장소</code>를 입력해도 됩니다. 비공개 저장소는 서버에 읽기 권한이 필요합니다.</p><form onSubmit={(event) => { event.preventDefault(); void run("github", async () => { await post("/sources", { kind: "github", targets: targets.split(",").map((t) => t.trim()).filter(Boolean), enabled: true }); setTargets(""); }, "저장소를 연결했습니다. 글감 화면에서 첫 변경을 가져와 보세요."); }}><label className="field"><span>GitHub 소유자 또는 소유자/저장소</span><input placeholder="예: Open330/somun" required value={targets} onChange={(event) => setTargets(event.target.value)} /></label><button type="submit" disabled={busy !== null || !targets.trim()}>{busy === "github" ? "연결 중…" : "저장소 연결"}</button></form></details>
      </section>
      <section className="card connection-card"><div className="connection-label"><span className="connection-symbol" aria-hidden>≋</span><span className="badge outline">RSS · Atom</span></div><h2>블로그</h2><p>이미 쓴 긴 글을 짧은 소셜 게시글로 이어가세요. 피드에서 최근 30일의 글을 가져옵니다.</p><form onSubmit={(event) => { event.preventDefault(); void run("blog", async () => { await post("/sources", { kind: "blog", targets: [feed.trim()], enabled: true }); setFeed(""); }, "블로그를 연결했습니다. 글감 화면에서 첫 글을 가져와 보세요."); }}><label className="field"><span>블로그 피드 주소</span><input type="url" required placeholder="https://blog.example.com/feed.xml" value={feed} onChange={(event) => setFeed(event.target.value)} /></label><button type="submit" disabled={busy !== null || !/^https?:\/\//.test(feed.trim())}>{busy === "blog" ? "연결 중…" : "블로그 연결"}</button></form></section>
    </div>
    {linked.length > 0 && <section className="connected-sources"><h2>연결한 소스 <span className="badge">{linked.length}</span></h2><div className="story-list">{linked.map((source) => <article className="source-row" key={source.id}><div><div className="row wrap"><b>{source.targets.join(", ") || "저장소 선택이 필요해요"}</b><span className={`badge ${source.enabled ? "ok" : "outline"}`}>{source.enabled ? "수집 켜짐" : "일시 중지"}</span></div><p className="tiny muted">{source.kind === "blog" ? "블로그" : "GitHub"} · {source.lastPolledAt ? `마지막 수집 ${relTime(source.lastPolledAt)}` : "아직 수집하지 않았어요"}</p>{source.lastError && <p className="small source-error" role="status">최근 수집에 실패했습니다. 주소와 접근 권한을 확인해 주세요.</p>}</div><div className="toolbar"><button className="sm" disabled={busy !== null} onClick={() => void run(`toggle-${source.id}`, () => post("/sources", { id: source.id, kind: source.kind, targets: source.targets, options: source.options, enabled: !source.enabled }), source.enabled ? "수집을 일시 중지했습니다." : "수집을 다시 켰습니다.")}>{source.enabled ? "일시 중지" : "수집 켜기"}</button><button className="ghost sm danger" disabled={busy !== null} onClick={() => { if (window.confirm("이 소스의 연결을 해제할까요? 다시 연결하려면 소스를 추가해야 합니다.")) void run(`delete-${source.id}`, () => del(`/sources/${source.id}`), "소스 연결을 해제했습니다."); }}>연결 해제</button></div></article>)}</div></section>}
    <details className="advanced-connection"><summary>코딩 에이전트 세션도 글감으로 활용하기</summary><p className="small muted">로컬에서 요약한 세션을 업로드할 수 있습니다. 프롬프트 원문 대신 요약을 전송합니다.</p><pre className="evidence">{`# 소문 프로젝트 폴더에서 실행\nSOMUN_URL=${window.location.origin} SOMUN_TOKEN=<접근-토큰> npm run push -- --days 14\n# 전송 전 확인: npm run push -- --dry-run`}</pre><p className="tiny muted">최근 14일 세션 {view.sessions.sessionCount14d}개{view.sessions.lastUploadAt ? ` · 마지막 업로드 ${relTime(view.sessions.lastUploadAt)}` : ""}</p></details>
  </>;
}
