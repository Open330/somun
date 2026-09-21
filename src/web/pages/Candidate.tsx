import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CHANNELS, enabledTargets, targetKey, type Channel } from "@core/channels";
import { voicePreset } from "@core/voice";
import type { CandidateDetail, Draft, SettingsView } from "@shared/types";
import { CHANNEL_LABEL, LintBadges, Menu, Meter, REASONS, Skeleton, StageChip, TYPE_LABEL, Toast, fmtDate, stageOf, targetLabel, useToast } from "../components/ui";
import { ChannelPreview, WordDiff } from "../components/preview";
import { post, useResource } from "../lib/api";
import { useAuth } from "../lib/auth/context";

/**
 * 글감 하나.
 * 머리: 제목, 단계, 각도(한 문장), 판단 미터, 동작.
 * 왼쪽(근거): 무엇이 달라졌나, 사실, 한계, 판단 이유, 원자료, 발행됨. 초안을 검수할 때 옆에 두고 보는 것.
 * 오른쪽(작성): 채널·언어 탭, 초안 카드. 주 동작은 복사 하나. 다시 쓰기는 지침을 붙일 수 있고 이전 판을 남긴다.
 */
export default function Candidate() {
  const { id } = useParams<{ id: string }>();
  const cid = Number(id);
  const { data } = useResource<CandidateDetail>(`/candidates/${cid}`, ["candidates", "drafts", "publications"]);
  const { data: settings } = useResource<SettingsView>("/settings", ["settings"]);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>(null);
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
  const current = targets.find((t) => targetKey(t.channel, t.lang) === tab) ?? null;

  const redraft = async (ts: { channel: Channel; lang: string }[], instruction?: string, key = "draft") => {
    setBusy(key);
    try {
      const r = await post<{ started?: string }>(`/candidates/${cid}/redraft`, { targets: ts, instruction });
      if (r?.started === "chain") showToast("다이제스트 → 판단 → 초안을 시작했습니다. 1~2분 안에 여기 나타납니다.");
      else if (instruction) showToast("지침대로 다시 썼습니다. 이전 판은 버전 목록에 남습니다.");
    } catch (err) { showToast(`초안을 못 썼습니다: ${(err as Error).message}`); } finally { setBusy(null); }
  };
  const redraftAll = () => redraft(enabledTargets(settings?.channelLangs ?? {}));

  return (
    <>
      <div className="cand-head">
        <div className="row wrap tiny muted" style={{ marginBottom: 8 }}><Link to="/">글감</Link><span>/</span><span>{TYPE_LABEL[c.type] ?? c.type}</span><span>·</span><a href={e.repoUrl} target="_blank" rel="noreferrer">{e.repo}</a>{e.version && <span>· {e.version}</span>}</div>
        <div className="cand-head-row">
          <div style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}><h1 style={{ margin: 0 }}>{c.title}</h1><StageChip stage={stage} /></div>
            {angle && <p className="angle">{angle}</p>}
          </div>
          <div className="toolbar">
            {decision !== "draft" && j && <button className="primary" disabled={busy !== null} onClick={async () => { await post(`/candidates/${cid}/override`, { decision: "draft", reason: "other", note: "수동으로 초안 요청" }); await redraftAll(); }}>{busy === "draft" ? "쓰는 중…" : "그래도 초안 쓰기"}</button>}
            <Menu items={[
              { label: busy === "judge" ? "판단 중…" : "다시 판단 (다이제스트부터)", onClick: async () => { setBusy("judge"); try { await post(`/candidates/${cid}/rejudge`); } catch (err) { showToast(`실패: ${(err as Error).message}`); } finally { setBusy(null); } } },
              { label: "모든 채널 다시 쓰기", onClick: redraftAll },
              { label: "보류", onClick: async () => { await post(`/candidates/${cid}/status`, { status: "deferred" }); showToast("보류했습니다"); } },
              { label: "글감 아님 (버리기)", danger: true, onClick: async () => { await post(`/candidates/${cid}/override`, { decision: "drop", reason: "not_worth" }); showToast("버렸습니다. 다음 판단에 반영됩니다."); } },
            ]} />
          </div>
        </div>
        {j && (
          <div className="cand-judge">
            <Meter scores={j.scores} />
            <span className="small muted">합 {j.total} · {decision === "draft" ? "초안" : decision === "defer" ? "보류" : "묻기만"} · 기준 초안 {settings?.draftThreshold ?? 6} / 보류 {settings?.deferThreshold ?? 4}{j.overriddenDecision ? ` · 수동 ${j.overriddenDecision}` : ""}</span>
          </div>
        )}
      </div>

      <div className="cand-layout">
        <aside className="cand-side">
          <section className="side-block">
            <h2>무엇이 달라졌나</h2>
            {e.highlights?.length ? <ul className="hl">{e.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul> : <p className="small muted">{stage.busy ? "다이제스트를 만드는 중입니다." : "아직 다이제스트가 없습니다. 초안 쓰기를 누르면 먼저 만듭니다."}</p>}
            {e.ompSummary && <details className="raw"><summary>에이전트 세션 요약</summary><pre className="evidence">{e.ompSummary}</pre></details>}
          </section>

          <section className="side-block">
            <h2>사실 <span className="tiny muted" style={{ textTransform: "none", letterSpacing: 0 }}>초안이 쓸 수 있는 숫자</span></h2>
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
            <div className="tiny muted" style={{ margin: "12px 0 4px" }}>한계</div>
            {e.limitations?.length ? <ul className="hl small">{e.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul> : <p className="tiny muted" style={{ margin: 0 }}>README에 명시된 한계가 없습니다. 초안은 버전 상태를 한계로 씁니다.</p>}
          </section>

          {j && (
            <section className="side-block">
              <h2>판단 이유</h2>
              <p className="small" style={{ lineHeight: 1.65, margin: 0 }}>{reasoning}</p>
              <div className="tiny muted" style={{ marginTop: 6 }}>{j.model} · {fmtDate(j.createdAt)}</div>
            </section>
          )}

          <section className="side-block">
            <details className="raw"><summary>원자료 (릴리스 노트, 머지된 PR, 커밋 제목)</summary>
              <pre className="evidence">{[e.releaseNotes && `릴리스 노트\n${e.releaseNotes}`, e.mergedPrTitles?.length && `머지된 PR\n- ${e.mergedPrTitles.join("\n- ")}`, e.commitSubjects?.length && `커밋\n- ${e.commitSubjects.slice(0, 40).join("\n- ")}`].filter(Boolean).join("\n\n") || "(없음)"}</pre>
            </details>
          </section>

          {publications.length > 0 && (
            <section className="side-block">
              <h2>발행됨</h2>
              <div className="stack small">{publications.map((p) => <div key={p.id} className="row between"><span className="badge outline">{CHANNEL_LABEL[p.channel]}</span><a href={p.url} target="_blank" rel="noreferrer">{p.url.replace(/^https?:\/\//, "").slice(0, 44)}</a><span className="muted">{fmtDate(p.publishedAt)}</span></div>)}</div>
            </section>
          )}
        </aside>

        <section className="cand-main">
          <div className="row between" style={{ alignItems: "baseline", marginBottom: 4 }}>
            <h2 style={{ margin: 0 }}>초안</h2>
            {settings && <Link to="/voice" className="tiny muted">문체: {voicePreset(settings.voice.preset).name}{settings.voice.guide ? " + 내 지침" : ""} ↗</Link>}
          </div>
          <div className="chtabs">
            {targets.map((t) => {
              const k = targetKey(t.channel, t.lang);
              const live = (draftsByTarget.get(k) ?? []).find((d) => d.status !== "dropped");
              const pub = publications.find((p) => p.channel === t.channel && (p.lang ?? t.lang) === t.lang);
              return <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{targetLabel(t.channel, t.lang, Boolean(CHANNELS[t.channel].fixedLang))}<span className="st">{pub ? "✓ 올림" : live ? (live.status === "copied" ? "복사됨" : live.lint.every((l) => l.ok) ? "●" : "!") : busy === "draft" || stage.busy ? "…" : "+"}</span></button>;
            })}
          </div>
          {current && <DraftPanel key={tab!} cid={cid} channel={current.channel} lang={current.lang} drafts={draftsByTarget.get(tab!) ?? []} published={publications.find((p) => p.channel === current.channel && (p.lang ?? current.lang) === current.lang)?.url} busy={busy === `draft:${tab}` || busy === "draft"} showToast={showToast}
            onRedraft={(instruction) => redraft([current], instruction, `draft:${tab}`)} />}
        </section>
      </div>
      <Toast msg={toast} />
    </>
  );
}

const REWRITE_HINTS = ["더 짧게", "첫 문장을 문제로 시작", "숫자를 앞으로", "한계를 더 구체적으로", "질문으로 끝내기", "덜 격식 있게"];

function DraftPanel({ cid, channel, lang, drafts, published, busy, onRedraft, showToast }: { cid: number; channel: Channel; lang: string; drafts: Draft[]; published?: string; busy: boolean; onRedraft: (instruction?: string) => Promise<void>; showToast: (m: string) => void }) {
  const versions = [...drafts].sort((a, b) => b.version - a.version);
  const latest = versions.find((d) => d.status !== "dropped") ?? null;
  const [viewId, setViewId] = useState<number | null>(null);
  const shown = (viewId !== null ? versions.find((d) => d.id === viewId) : null) ?? latest;
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
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [instruction, setInstruction] = useState("");

  useEffect(() => { setTitle(latest?.title ?? ""); setBody(latest?.body ?? ""); setEditing(false); setViewId(null); setRewriteOpen(false); setStep(latest?.status === "copied" ? "post" : "draft"); }, [latest?.id, latest?.title, latest?.body, latest?.status]);

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
      if (ev.key === "r") setRewriteOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (published) return <div className="card"><p className="small"><span className="badge ok">올림</span> <a href={published} target="_blank" rel="noreferrer">{published}</a></p><p className="tiny muted">발행 화면에서 스타·방문자 변화를 봅니다.</p></div>;
  if (!latest) {
    return (
      <div className="card draft-empty">
        <p className="muted small" style={{ margin: 0 }}>{targetLabel(channel, lang, Boolean(spec.fixedLang))} 초안이 아직 없습니다. 설정된 문체와 이 글감의 사실만으로 씁니다.</p>
        <button className="primary" disabled={busy} onClick={() => void onRedraft()}>{busy ? "쓰는 중…" : "초안 쓰기"}</button>
      </div>
    );
  }
  const changed = latest.body !== body || (latest.title ?? "") !== (title || "");
  const isOld = shown && shown.id !== latest.id;

  return (
    <div className="card draft-card">
      <div className="draft-toolbar">
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <LintBadges lint={latest.lint} />
          {versions.length > 1 ? (
            <select className="ver" value={shown?.id ?? latest.id} onChange={(ev) => setViewId(Number(ev.target.value))} title="버전">
              {versions.map((d) => <option key={d.id} value={d.id}>v{d.version}{d.status === "dropped" ? " (버림)" : d.id === latest.id ? " (현재)" : ""} · {d.model.split("@")[0].replace("gemini/", "")}</option>)}
            </select>
          ) : <span className="tiny muted">v{latest.version} · {latest.model.split("@")[0].replace("gemini/", "")}</span>}
        </div>
        {!editing && <div className="row" style={{ gap: 8 }}>
          <div className="seg"><button className={view === "preview" ? "active" : ""} onClick={() => setView("preview")}>미리보기</button><button className={view === "text" ? "active" : ""} onClick={() => setView("text")}>텍스트</button></div>
          <Menu items={[{ label: "버리기 (사유 선택)", danger: true, onClick: () => setDropOpen(true) }]} />
        </div>}
      </div>

      {isOld && shown && (
        <div className="old-ver small">
          <span>v{shown.version} 이전 판을 보고 있습니다.</span>
          <span className="toolbar"><button className="sm" onClick={() => { setTitle(shown.title ?? ""); setBody(shown.body); setViewId(null); setEditing(true); }}>이 판으로 수정 시작</button><button className="ghost sm" onClick={() => setViewId(null)}>현재 판으로</button></span>
        </div>
      )}

      {editing ? (
        <>
          {spec.hasTitle && <input value={title} onChange={(ev) => setTitle(ev.target.value)} style={{ marginBottom: 8 }} placeholder="제목" />}
          <textarea value={body} onChange={(ev) => setBody(ev.target.value)} autoFocus />
          <div className="row between" style={{ marginTop: 6 }}><span className="tiny muted">{[...body].length}{spec.maxChars ? `/${spec.maxChars}` : ""}자</span></div>
          {changed && <><div className="tiny muted" style={{ margin: "8px 0 4px" }}>바뀐 부분. 저장하면 이 문장이 내 문체 예시로 남습니다 (설정에서 예시 참고를 켠 경우에만 프롬프트에 들어갑니다).</div><WordDiff before={latest.body} after={body} /></>}
          <div className="toolbar" style={{ marginTop: 10 }}>
            <button className="primary" onClick={() => void copy()}>저장하고 복사</button>
            <button onClick={async () => { await post(`/drafts/${latest.id}/edit`, { title: spec.hasTitle ? title : undefined, body, markCopied: false }); setEditing(false); showToast("저장했습니다"); }}>저장만</button>
            <button className="ghost" onClick={() => { setTitle(latest.title ?? ""); setBody(latest.body); setEditing(false); }}>취소</button>
          </div>
        </>
      ) : (
        <>
          {view === "preview" ? <ChannelPreview channel={channel} title={shown?.title ?? title} body={shown?.body ?? body} author={author} /> : <>{spec.hasTitle && <div style={{ fontWeight: 600, marginBottom: 8 }}>{shown?.title ?? title}</div>}<div className="draft-body">{shown?.body ?? body}</div></>}
          {!isOld && (
            <div className="draft-actions">
              <div className="toolbar">
                <button className="primary" onClick={() => void copy()}>복사</button>
                <button onClick={() => setEditing(true)}>수정</button>
                <button className={rewriteOpen ? "active" : ""} disabled={busy} onClick={() => setRewriteOpen((o) => !o)}>{busy ? "쓰는 중…" : "다시 쓰기"}</button>
              </div>
              <span className="tiny muted">{[...body].length}{spec.maxChars ? `/${spec.maxChars}` : ""}자 · <span className="kbd">c</span> 복사 <span className="kbd">e</span> 수정 <span className="kbd">r</span> 다시 쓰기{spec.mediaHint ? ` · 이미지: ${spec.mediaHint}` : ""}</span>
            </div>
          )}
          {rewriteOpen && !isOld && (
            <div className="rewrite">
              <div className="small" style={{ marginBottom: 6 }}><b>다시 쓰기 지침</b> <span className="muted">비워 두면 같은 문체로 새로 씁니다. 지침을 주면 그 점만 바꿉니다. 사실과 숫자는 그대로입니다.</span></div>
              <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>{REWRITE_HINTS.map((h) => <button key={h} className="ghost sm chip" onClick={() => setInstruction((v) => (v ? `${v}, ${h}` : h))}>{h}</button>)}</div>
              <textarea value={instruction} onChange={(ev) => setInstruction(ev.target.value)} placeholder="예: 첫 문장을 내가 겪은 문제로 시작하고, 마지막은 링크만 남겨 주세요." style={{ minHeight: 70 }} />
              <div className="toolbar" style={{ marginTop: 8 }}>
                <button className="primary" disabled={busy} onClick={async () => { await onRedraft(instruction.trim() || undefined); setRewriteOpen(false); setInstruction(""); }}>{busy ? "쓰는 중…" : instruction.trim() ? "이 지침으로 다시 쓰기" : "같은 문체로 다시 쓰기"}</button>
                <button className="ghost" onClick={() => setRewriteOpen(false)}>닫기</button>
              </div>
            </div>
          )}
        </>
      )}

      {dropOpen && (
        <div className="row wrap" style={{ marginTop: 10 }}>
          <select value={dropReason} onChange={(ev) => setDropReason(ev.target.value as never)}>{REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <button className="danger" onClick={async () => { await post(`/drafts/${latest.id}/drop`, { reason: dropReason }); setDropOpen(false); showToast("버렸습니다. 사유가 다음 초안에 반영됩니다."); }}>버리기</button>
          <button className="ghost" onClick={() => setDropOpen(false)}>취소</button>
        </div>
      )}

      {step === "post" && !editing && !isOld && (
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
