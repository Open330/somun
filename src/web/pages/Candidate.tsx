import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CHANNELS, enabledTargets, targetKey, type Channel } from "@core/channels";
import type { CandidateDetail, Draft, SettingsView } from "@shared/types";
import { CHANNEL_LABEL, LintBadges, Menu, Meter, REASONS, Skeleton, StageChip, TYPE_LABEL, Toast, fmtDate, stageOf, targetLabel, useToast } from "../components/ui";
import { ChannelPreview, WordDiff } from "../components/preview";
import { post, useResource } from "../lib/api";
import { useAuth } from "../lib/auth/context";

/**
 * 글감 하나. 위: 각도(한 문장)와 판단 미터. 왼쪽: 무엇이 달라졌나(다이제스트), 사실, 접힌 원자료.
 * 오른쪽: 채널 탭 작성기. 주 동작은 "복사" 하나, 복사 뒤에 "올리기 전 확인"과 URL 등록이 단계로 나타난다.
 */
export default function Candidate() {
  const { id } = useParams<{ id: string }>();
  const cid = Number(id);
  const { data } = useResource<CandidateDetail>(`/candidates/${cid}`, ["candidates", "drafts", "publications"]);
  const { data: settings } = useResource<SettingsView>("/settings", ["settings"]);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>(null); // targetKey(channel, lang)
  const [toast, showToast] = useToast();

  const draftsByTarget = useMemo(() => {
    const m = new Map<string, Draft[]>();
    for (const d of data?.drafts ?? []) { const k = targetKey(d.channel, d.lang); m.set(k, [...(m.get(k) ?? []), d]); }
    return m;
  }, [data?.drafts]);
  const targets = useMemo(() => {
    const enabled = enabledTargets(settings?.channelLangs ?? {});
    const fromDrafts = [...draftsByTarget.keys()].map((k) => { const [channel, lang] = k.split(":"); return { channel: channel as Channel, lang }; });
    const seen = new Set<string>();
    return [...enabled, ...fromDrafts].filter((t) => { const k = targetKey(t.channel, t.lang); if (seen.has(k)) return false; seen.add(k); return true; });
  }, [draftsByTarget, settings?.channelLangs]);
  useEffect(() => { if (!tab && targets.length) setTab(targetKey(targets[0].channel, targets[0].lang)); }, [targets, tab]);

  if (!data) return <Skeleton rows={6} />;
  const { candidate: c, judgments, publications } = data;
  const j = judgments[0];
  const e = c.evidence;
  const stage = stageOf({ ...c, judgment: j });
  const angle = j?.reasoning.split("각도: ")[1]?.trim();
  const reasoning = j?.reasoning.split("\n\n각도:")[0];
  const decision = j?.overriddenDecision ?? j?.decision;
  const redraftAll = async () => { setBusy("draft"); try { await post(`/candidates/${cid}/redraft`, { targets: enabledTargets(settings?.channelLangs ?? {}) }); } finally { setBusy(null); } };
  const current = targets.find((t) => targetKey(t.channel, t.lang) === tab) ?? null;

  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="row wrap tiny muted" style={{ marginBottom: 6 }}><Link to="/">글감</Link><span>/</span><span>{TYPE_LABEL[c.type] ?? c.type}</span><span>·</span><a href={e.repoUrl} target="_blank" rel="noreferrer">{e.repo}</a>{e.version && <span>· {e.version}</span>}</div>
          <div className="row" style={{ gap: 10 }}><h1 style={{ margin: 0 }}>{c.title}</h1><StageChip stage={stage} /></div>
          {angle && <p className="angle">{angle}</p>}
          {j && <div className="row wrap" style={{ gap: 14 }}><Meter scores={j.scores} /><span className="small muted">합 {j.total} · {decision === "draft" ? "초안" : decision === "defer" ? "보류" : "묻기만"} 기준 {settings?.draftThreshold ?? 6}/{settings?.deferThreshold ?? 4}</span></div>}
        </div>
        <div className="toolbar">
          {decision !== "draft" && j && <button className="primary" disabled={busy !== null} onClick={async () => { await post(`/candidates/${cid}/override`, { decision: "draft", reason: "other", note: "수동으로 초안 요청" }); await redraftAll(); }}>{busy === "draft" ? "쓰는 중…" : "그래도 초안 쓰기"}</button>}
          <Menu items={[
            { label: busy === "judge" ? "판단 중…" : "다시 판단 (다이제스트부터)", onClick: async () => { setBusy("judge"); try { await post(`/candidates/${cid}/rejudge`); } finally { setBusy(null); } } },
            { label: "모든 채널 다시 쓰기", onClick: redraftAll },
            { label: "보류", onClick: async () => { await post(`/candidates/${cid}/status`, { status: "deferred" }); showToast("보류했습니다"); } },
            { label: "글감 아님 (버리기)", danger: true, onClick: async () => { await post(`/candidates/${cid}/override`, { decision: "drop", reason: "not_worth" }); showToast("버렸습니다. 다음 판단에 반영됩니다."); } },
          ]} />
        </div>
      </div>

      <div className="grid2">
        <section>
          <h2>무엇이 달라졌나</h2>
          {e.highlights?.length ? <ul className="hl">{e.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul> : <p className="small muted">{stage.busy ? "다이제스트를 만드는 중입니다." : "다이제스트가 없습니다."}</p>}
          {e.ompSummary && <details className="raw"><summary>에이전트 세션</summary><pre className="evidence">{e.ompSummary}</pre></details>}

          <h2>사실</h2>
          <div className="facts">
            {e.stars !== undefined && <span className="badge">stars {e.stars}</span>}
            {e.forks !== undefined && <span className="badge">forks {e.forks}</span>}
            {e.commitCount !== undefined && <span className="badge">commits {e.commitCount}</span>}
            {e.releaseCount !== undefined && <span className="badge">releases {e.releaseCount}</span>}
            {e.firstReleaseAt && <span className="badge">first {e.firstReleaseAt}</span>}
            {e.npmPackage && <span className="badge">npm {e.npmMonthlyDownloads}/월</span>}
            {e.language && <span className="badge">{e.language}</span>}
            {e.license && <span className="badge">{e.license}</span>}
            <span className={`badge ${e.demoAsset ? "ok" : "warn"}`}>{e.demoAsset ? `데모 ${e.demoAsset.split("/").pop()}` : "데모 자산 없음"}</span>
          </div>
          {e.limitations?.length ? <><div className="tiny muted" style={{ margin: "10px 0 4px" }}>한계</div><ul className="hl small">{e.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul></> : <p className="tiny muted" style={{ marginTop: 8 }}>README에 명시된 한계가 없습니다. 초안은 버전 상태를 한계로 씁니다.</p>}

          {j && <><h2>판단 이유</h2><p className="small" style={{ lineHeight: 1.65 }}>{reasoning}</p><div className="tiny muted">{j.model} · {fmtDate(j.createdAt)}{j.overriddenDecision ? ` · 수동 ${j.overriddenDecision}` : ""}</div></>}

          <details className="raw"><summary>원자료 보기 (릴리스 노트, 머지된 PR, 커밋 제목)</summary>
            <pre className="evidence">{[e.releaseNotes && `릴리스 노트\n${e.releaseNotes}`, e.mergedPrTitles?.length && `머지된 PR\n- ${e.mergedPrTitles.join("\n- ")}`, e.commitSubjects?.length && `커밋\n- ${e.commitSubjects.slice(0, 40).join("\n- ")}`].filter(Boolean).join("\n\n") || "(없음)"}</pre>
          </details>

          {publications.length > 0 && <><h2>발행됨</h2><div className="stack small">{publications.map((p) => <div key={p.id} className="row between"><span className="badge outline">{CHANNEL_LABEL[p.channel]}</span><a href={p.url} target="_blank" rel="noreferrer">{p.url.replace(/^https?:\/\//, "").slice(0, 50)}</a><span className="muted">{fmtDate(p.publishedAt)}</span></div>)}</div></>}
        </section>

        <section>
          <h2>초안</h2>
          <div className="chtabs">
            {targets.map((t) => {
              const k = targetKey(t.channel, t.lang);
              const live = (draftsByTarget.get(k) ?? []).find((d) => d.status !== "dropped");
              const pub = publications.find((p) => p.channel === t.channel && (p.lang ?? t.lang) === t.lang);
              return <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{targetLabel(t.channel, t.lang, Boolean(CHANNELS[t.channel].fixedLang))}<span className="st">{pub ? "✓ 올림" : live ? (live.status === "copied" ? "복사됨" : live.lint.every((l) => l.ok) ? "●" : "!") : busy === "draft" || stage.busy ? "…" : "+"}</span></button>;
            })}
          </div>
          {current && <DraftPanel key={tab!} cid={cid} channel={current.channel} lang={current.lang} drafts={draftsByTarget.get(tab!) ?? []} published={publications.find((p) => p.channel === current.channel && (p.lang ?? current.lang) === current.lang)?.url} busy={busy === `draft:${tab}` || busy === "draft"} showToast={showToast}
            onRedraft={async () => { setBusy(`draft:${tab}`); try { const r = await post<{ started?: string }>(`/candidates/${cid}/redraft`, { targets: [current] }); if (r?.started === "chain") showToast("다이제스트 → 판단 → 초안을 시작했습니다. 1~2분 안에 여기 나타납니다."); } catch (e) { showToast(`초안을 못 썼습니다: ${(e as Error).message}`); } finally { setBusy(null); } }} />}
        </section>
      </div>
      <Toast msg={toast} />
    </>
  );
}

function DraftPanel({ cid, channel, lang, drafts, published, busy, onRedraft, showToast }: { cid: number; channel: Channel; lang: string; drafts: Draft[]; published?: string; busy: boolean; onRedraft: () => Promise<void>; showToast: (m: string) => void }) {
  const latest = [...drafts].sort((a, b) => b.version - a.version).find((d) => d.status !== "dropped") ?? null;
  const auth = useAuth();
  const author = auth.user?.displayName ?? auth.user?.username ?? "you";
  const spec = CHANNELS[channel];
  const [title, setTitle] = useState(latest?.title ?? "");
  const [body, setBody] = useState(latest?.body ?? "");
  const [editing, setEditing] = useState(false);
  const [view, setView] = useState<"preview" | "text">("preview");
  const [step, setStep] = useState<"draft" | "post">("draft");
  const [url, setUrl] = useState("");
  const [dropOpen, setDropOpen] = useState(false);
  const [dropReason, setDropReason] = useState<(typeof REASONS)[number][0]>("voice");

  useEffect(() => { setTitle(latest?.title ?? ""); setBody(latest?.body ?? ""); setEditing(false); setStep(latest?.status === "copied" ? "post" : "draft"); }, [latest?.id, latest?.title, latest?.body, latest?.status]);

  const full = spec.hasTitle ? `${title}\n\n${body}` : body;
  const copy = async () => {
    await navigator.clipboard.writeText(full);
    await post(`/drafts/${latest!.id}/edit`, { title: spec.hasTitle ? title : undefined, body, markCopied: true });
    setEditing(false); setStep("post");
    showToast("복사했습니다. 아래 확인 목록을 보고 올리세요.");
  };
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      if (editing || !latest || tag === "INPUT" || tag === "TEXTAREA" || ev.metaKey || ev.ctrlKey) return;
      if (ev.key === "c") void copy();
      if (ev.key === "e") setEditing(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (published) return <div className="card"><p className="small"><span className="badge ok">올림</span> <a href={published} target="_blank" rel="noreferrer">{published}</a></p><p className="tiny muted">발행 화면에서 스타·방문자 변화를 봅니다.</p></div>;
  if (!latest) {
    return <div className="card"><p className="muted small">{targetLabel(channel, lang, Boolean(spec.fixedLang))} 초안이 아직 없습니다.</p><button className="primary" disabled={busy} onClick={() => void onRedraft()}>{busy ? "쓰는 중…" : "초안 쓰기"}</button></div>;
  }
  const changed = latest.body !== body || (latest.title ?? "") !== (title || "");

  return (
    <div className="card">
      <div className="row between" style={{ marginBottom: 10 }}>
        <div className="row" style={{ gap: 8 }}><LintBadges lint={latest.lint} /><span className="tiny muted">v{latest.version} · {latest.model.split("@")[0]}</span></div>
        {!editing && <div className="row" style={{ gap: 8 }}><div className="seg"><button className={view === "preview" ? "active" : ""} onClick={() => setView("preview")}>미리보기</button><button className={view === "text" ? "active" : ""} onClick={() => setView("text")}>텍스트</button></div>
          <Menu items={[
            { label: "다시 쓰기", onClick: () => void onRedraft() },
            { label: "버리기 (사유 선택)", danger: true, onClick: () => setDropOpen(true) },
          ]} /></div>}
      </div>

      {editing ? (
        <>
          {spec.hasTitle && <input value={title} onChange={(ev) => setTitle(ev.target.value)} style={{ marginBottom: 8 }} placeholder="제목" />}
          <textarea value={body} onChange={(ev) => setBody(ev.target.value)} autoFocus />
          <div className="row between" style={{ marginTop: 6 }}><span className="tiny muted">{[...body].length}{spec.maxChars ? `/${spec.maxChars}` : ""}자</span></div>
          {changed && <><div className="tiny muted" style={{ margin: "8px 0 4px" }}>바뀐 부분. 저장하면 이 문장이 다음 초안의 문체 예시가 됩니다.</div><WordDiff before={latest.body} after={body} /></>}
          <div className="toolbar" style={{ marginTop: 10 }}>
            <button className="primary" onClick={() => void copy()}>저장하고 복사</button>
            <button onClick={async () => { await post(`/drafts/${latest.id}/edit`, { title: spec.hasTitle ? title : undefined, body, markCopied: false }); setEditing(false); showToast("저장했습니다"); }}>저장만</button>
            <button className="ghost" onClick={() => { setTitle(latest.title ?? ""); setBody(latest.body); setEditing(false); }}>취소</button>
          </div>
        </>
      ) : (
        <>
          {view === "preview" ? <ChannelPreview channel={channel} title={title} body={body} author={author} /> : <>{spec.hasTitle && <div style={{ fontWeight: 600, marginBottom: 8 }}>{title}</div>}<div className="draft-body">{body}</div></>}
          <div className="row between" style={{ marginTop: 10 }}>
            <div className="toolbar">
              <button className="primary" onClick={() => void copy()}>복사</button>
              <button onClick={() => setEditing(true)}>수정</button>
            </div>
            <span className="tiny muted">{[...body].length}{spec.maxChars ? `/${spec.maxChars}` : ""}자 · <span className="kbd">c</span> 복사 <span className="kbd">e</span> 수정{spec.mediaHint ? ` · 이미지: ${spec.mediaHint}` : ""}</span>
          </div>
        </>
      )}

      {dropOpen && (
        <div className="row wrap" style={{ marginTop: 10 }}>
          <select value={dropReason} onChange={(ev) => setDropReason(ev.target.value as never)}>{REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <button className="danger" onClick={async () => { await post(`/drafts/${latest.id}/drop`, { reason: dropReason }); setDropOpen(false); showToast("버렸습니다. 사유가 다음 초안에 반영됩니다."); }}>버리기</button>
          <button className="ghost" onClick={() => setDropOpen(false)}>취소</button>
        </div>
      )}

      {step === "post" && !editing && (
        <div className="step-post">
          <div className="row between"><b>올리기 전 확인 · {targetLabel(channel, lang, Boolean(spec.fixedLang))}</b>{spec.composeUrl && <a className="btn sm" href={spec.composeUrl} target="_blank" rel="noreferrer">{spec.label} 작성 화면 열기 ↗</a>}</div>
          <ol>{spec.runbook.map((r, i) => <li key={i}>{r}</li>)}</ol>
          <div className="row">
            <input placeholder="올렸으면 URL을 붙여 넣으세요" value={url} onChange={(ev) => setUrl(ev.target.value)} />
            <button className="primary" disabled={!/^https?:\/\//.test(url)} onClick={async () => { await post("/publications", { candidateId: cid, draftId: latest.id, channel, lang, url }); setUrl(""); showToast("등록했습니다. 발행 화면에서 추이를 봅니다."); }}>올렸어요</button>
          </div>
        </div>
      )}
    </div>
  );
}
