import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CHANNELS, enabledTargets, targetKey, type Channel } from "@core/channels";
import { voicePreset } from "@core/voice";
import type { CandidateDetail, Draft, SettingsView } from "@shared/types";
import { CHANNEL_LABEL, ChannelIcon, LintBadges, Menu, Meter, REASONS, Skeleton, StageChip, TYPE_LABEL, Toast, fmtDate, stageOf, targetLabel, useToast } from "../components/ui";
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
  const [tab, setTab] = useState<string | null>(null); // channel
  const [langByCh, setLangByCh] = useState<Record<string, string>>({});
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
  // 채널 단위 탭. 언어는 채널 안에서 고른다 (활성 언어가 둘 이상일 때만 토글이 보인다).
  const channels = useMemo(() => [...new Set(targets.map((t) => t.channel))], [targets]);
  const langsOf = (ch: Channel) => targets.filter((t) => t.channel === ch).map((t) => t.lang);
  useEffect(() => { if (!tab && channels.length) setTab(channels[0]); }, [channels, tab]);

  if (!data) return <Skeleton rows={6} />;
  const { candidate: c, judgments, publications } = data;
  const j = judgments[0];
  const e = c.evidence;
  const stage = stageOf({ ...c, judgment: j });
  const angle = j?.reasoning.split("각도: ")[1]?.trim();
  const reasoning = j?.reasoning.split("\n\n각도:")[0];
  const decision = j?.overriddenDecision ?? j?.decision;
  const curLangs = tab ? langsOf(tab as Channel) : [];
  const curLang = tab ? (langByCh[tab] && curLangs.includes(langByCh[tab]) ? langByCh[tab] : curLangs[0]) : undefined;
  const current = tab && curLang ? { channel: tab as Channel, lang: curLang } : null;
  const curKey = current ? targetKey(current.channel, current.lang) : null;

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
            {e.highlights?.length ? <ul className="hl check">{e.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul> : <p className="small muted" style={{ margin: 0 }}>{stage.busy ? "다이제스트를 만드는 중입니다." : "아직 다이제스트가 없습니다. 초안 쓰기를 누르면 먼저 만듭니다."}</p>}
            {e.ompSummary && <details className="raw"><summary>에이전트 세션 요약</summary><pre className="evidence">{e.ompSummary}</pre></details>}
          </section>

          <section className="side-block">
            <h2>사실</h2>
            <dl className="kv">
              {e.stars !== undefined && <><dt>스타</dt><dd>{e.stars}</dd></>}
              {e.forks !== undefined && <><dt>포크</dt><dd>{e.forks}</dd></>}
              {e.commitCount !== undefined && <><dt>커밋</dt><dd>{e.commitCount}</dd></>}
              {e.releaseCount !== undefined && <><dt>릴리스</dt><dd>{e.releaseCount}{e.version ? ` · 최신 ${e.version}` : ""}</dd></>}
              {e.firstReleaseAt && <><dt>첫 릴리스</dt><dd>{e.firstReleaseAt}</dd></>}
              {e.npmPackage && <><dt>npm</dt><dd>{e.npmPackage} · {e.npmMonthlyDownloads}/월</dd></>}
              {(e.language || e.license) && <><dt>언어 · 라이선스</dt><dd>{[e.language, e.license].filter(Boolean).join(" · ")}</dd></>}
              <dt>데모</dt><dd className={e.demoAsset ? "" : "muted"}>{e.demoAsset ? e.demoAsset.split("/").pop() : "없음 (올리기 전 GIF나 스크린샷을 준비하세요)"}</dd>
            </dl>
            <h2 style={{ marginTop: 14 }}>한계</h2>
            {e.limitations?.length ? e.limitations.map((l, i) => <div key={i} className="callout" style={{ marginTop: i ? 6 : 0 }}>{l}</div>) : <div className="callout muted-box">README에 명시된 한계가 없습니다. 초안은 버전 상태를 한계로 씁니다.</div>}
          </section>

          {j && (
            <section className="side-block">
              <h2>판단 이유</h2>
              <p className="small" style={{ lineHeight: 1.65, margin: 0 }}>{reasoning}</p>
              <div className="meta-line"><code>{j.model.split("@")[0].replace("gemini/", "")}</code><span>{fmtDate(j.createdAt)}</span></div>
            </section>
          )}

          <section className="side-block">
            <details className="raw"><summary>원자료 · 릴리스 노트, 머지된 PR, 커밋 제목</summary>
              <pre className="evidence">{[e.releaseNotes && `릴리스 노트\n${e.releaseNotes}`, e.mergedPrTitles?.length && `머지된 PR\n- ${e.mergedPrTitles.join("\n- ")}`, e.commitSubjects?.length && `커밋\n- ${e.commitSubjects.slice(0, 40).join("\n- ")}`].filter(Boolean).join("\n\n") || "(없음)"}</pre>
            </details>
          </section>

          {publications.length > 0 && (
            <section className="side-block">
              <h2>발행됨</h2>
              <div className="stack small">{publications.map((p) => <div key={p.id} className="row between"><span className="row" style={{ gap: 6 }}><ChannelIcon channel={p.channel} size={14} />{CHANNEL_LABEL[p.channel]}</span><a href={p.url} target="_blank" rel="noreferrer">{p.url.replace(/^https?:\/\//, "").slice(0, 40)}</a><span className="muted">{fmtDate(p.publishedAt)}</span></div>)}</div>
            </section>
          )}
        </aside>

        <section className="cand-main">
          <div className="row between" style={{ alignItems: "baseline", marginBottom: 4 }}>
            <h2 style={{ margin: 0 }}>초안</h2>
            {settings && <Link to="/voice" className="tiny muted">문체: {voicePreset(settings.voice.preset).name}{settings.voice.guide ? " + 내 지침" : ""} ↗</Link>}
          </div>
          <div className="chtabs">
            {channels.map((ch) => {
              const ls = langsOf(ch);
              const live = ls.map((l) => (draftsByTarget.get(targetKey(ch, l)) ?? []).find((d) => d.status !== "dropped")).filter(Boolean) as Draft[];
              const pub = publications.find((p) => p.channel === ch);
              const st = pub ? "✓" : live.length === ls.length ? (live.every((d) => d.lint.every((l) => l.ok)) ? "●" : "!") : live.length ? `${live.length}/${ls.length}` : busy === "draft" || stage.busy ? "…" : "";
              return <button key={ch} className={tab === ch ? "active" : ""} onClick={() => setTab(ch)}><ChannelIcon channel={ch} />{CHANNEL_LABEL[ch] ?? ch}{st && <span className="st">{st}</span>}</button>;
            })}
          </div>
          {current && curKey && (
            <DraftPanel key={curKey} cid={cid} channel={current.channel} lang={current.lang} langs={curLangs} onLang={(l) => setLangByCh({ ...langByCh, [current.channel]: l })}
              drafts={draftsByTarget.get(curKey) ?? []} published={publications.find((p) => p.channel === current.channel && (p.lang ?? current.lang) === current.lang)?.url}
              busy={busy === `draft:${curKey}` || busy === "draft"} showToast={showToast} onRedraft={(instruction) => redraft([current], instruction, `draft:${curKey}`)} />
          )}
        </section>
      </div>
      <Toast msg={toast} />
    </>
  );
}

const REWRITE_HINTS = ["더 짧게", "첫 문장을 문제로 시작", "숫자를 앞으로", "한계를 더 구체적으로", "질문으로 끝내기", "덜 격식 있게"];

const LangSeg = ({ langs, lang, onLang }: { langs: string[]; lang: string; onLang: (l: string) => void }) => langs.length > 1 ? <div className="lang-seg" role="tablist" aria-label="언어">{langs.map((l) => <button key={l} role="tab" className={l === lang ? "on" : ""} onClick={() => onLang(l)}>{l.toUpperCase()}</button>)}</div> : null;

function DraftPanel({ cid, channel, lang, langs, onLang, drafts, published, busy, onRedraft, showToast }: { cid: number; channel: Channel; lang: string; langs: string[]; onLang: (l: string) => void; drafts: Draft[]; published?: string; busy: boolean; onRedraft: (instruction?: string) => Promise<void>; showToast: (m: string) => void }) {
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
        <LangSeg langs={langs} lang={lang} onLang={onLang} />
        <p className="muted small" style={{ margin: 0 }}>{targetLabel(channel, lang, Boolean(spec.fixedLang))} 초안이 아직 없습니다. 설정된 문체와 이 글감의 사실만으로 씁니다.</p>
        <button className="primary" disabled={busy} onClick={() => void onRedraft()}>{busy ? "쓰는 중…" : "초안 쓰기"}</button>
      </div>
    );
  }
  const changed = latest.body !== body || (latest.title ?? "") !== (title || "");
  const isOld = shown && shown.id !== latest.id;
  const count = [...body].length;

  return (
    <div className="card draft-card">
      <div className="draft-head">
        <div className="meta">
          <LangSeg langs={langs} lang={lang} onLang={onLang} />
          <LintBadges lint={latest.lint} />
          <span className={`badge ${spec.maxChars && count > spec.maxChars ? "bad" : "outline"}`}>{count}{spec.maxChars ? ` / ${spec.maxChars}` : ""}자</span>
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
                <button className="primary" title="c" onClick={() => void copy()}>복사</button>
                <button title="e" onClick={() => setEditing(true)}>수정</button>
                <button className={rewriteOpen ? "active" : ""} title="r" disabled={busy} onClick={() => setRewriteOpen((o) => !o)}>{busy ? "쓰는 중…" : "다시 쓰기"}</button>
              </div>
              <span className="tiny muted"><span className="kbd">c</span> <span className="kbd">e</span> <span className="kbd">r</span></span>
            </div>
          )}
          {rewriteOpen && !isOld && (
            <div className="rewrite">
              <div className="rewrite-head"><b>다시 쓰기</b><span className="tiny muted">사실과 숫자는 그대로. 비우면 같은 문체로 새로 씁니다.</span></div>
              <div className="chips">{REWRITE_HINTS.map((h) => <button key={h} className="ghost sm chip" onClick={() => setInstruction((v) => (v ? `${v}, ${h}` : h))}>{h}</button>)}</div>
              <textarea value={instruction} onChange={(ev) => setInstruction(ev.target.value)} placeholder="바꾸고 싶은 점. 예: 첫 문장을 내가 겪은 문제로 시작" />
              <div className="toolbar">
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
          <ol>{spec.runbook.map((r, i) => <li key={i}>{r}</li>)}{spec.mediaHint && <li>이미지: {spec.mediaHint}</li>}</ol>
          <div className="row">
            <input placeholder="올렸으면 URL을 붙여 넣으세요" value={url} onChange={(ev) => setUrl(ev.target.value)} />
            <button className="primary" disabled={!/^https?:\/\//.test(url)} onClick={async () => { await post("/publications", { candidateId: cid, draftId: latest.id, channel, lang, url }); setUrl(""); showToast("등록했습니다. 발행 화면에서 추이를 봅니다."); }}>올렸어요</button>
          </div>
        </div>
      )}
    </div>
  );
}
