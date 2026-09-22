import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useBlocker } from "react-router-dom";
import { CHANNELS, enabledTargets, targetKey, type Channel } from "@core/channels";
import { voicePreset } from "@core/voice";
import type { CandidateDetail, Draft, KeyStatus, RepoProfileView, SettingsView } from "@shared/types";
import { CHANNEL_LABEL, ChannelIcon, ErrorState, LintBadges, Menu, Meter, REASONS, Skeleton, StageChip, TYPE_LABEL, Toast, fmtDate, stageOf, targetLabel, useToast } from "../components/ui";
import { GenerationStatus } from "../components/GenerationStatus";
import { ChannelPreview, WordDiff } from "../components/preview";
import { patch, post, useResource } from "../lib/api";
import { useAuth } from "../lib/auth/context";

/**
 * 글감 하나.
 * 머리: 제목, 단계, 각도(한 문장), 판단 미터, 동작.
 * 초안 검토·수정과 직접 게시·링크 기록을 먼저 배치하고, 근거는 보조 영역에서 확인한다.
 * 다시 쓰기는 지침을 붙일 수 있고 이전 판을 남긴다.
 */
export default function Candidate() {
  const { id } = useParams<{ id: string }>();
  const cid = Number(id);
  const { data, error, reload } = useResource<CandidateDetail>(`/candidates/${cid}`, ["candidates", "drafts", "publications"]);
  const { data: settings } = useResource<SettingsView>("/settings", ["settings"]);
  const { data: keys } = useResource<KeyStatus[]>("/keys", ["keys"]);
  const [busy, setBusy] = useState<string | null>(null);
  const [unsaved, setUnsaved] = useState(false);
  const [generationNotice, setGenerationNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const switchDraft = (change: () => void) => { if (!unsaved || window.confirm("저장하지 않은 수정 내용이 있습니다. 내용을 버리고 이동할까요?")) change(); };
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
  useEffect(() => { if ((!tab || !channels.includes(tab as Channel)) && channels.length) setTab(channels.find((ch) => targets.some((t) => t.channel === ch && draftsByTarget.get(targetKey(t.channel, t.lang))?.some((d) => d.status !== "dropped"))) ?? channels[0]); }, [channels, tab, targets, draftsByTarget]);

  if (error) return <ErrorState title="글감을 열지 못했습니다" message={error} onRetry={reload} />;
  if (!data) return <Skeleton rows={6} />;
  const { candidate: c, judgments, publications, profile, told, consistency } = data;
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
    setBusy(key); setGenerationNotice(null);
    try {
      const r = await post<{ started?: string; [key: string]: unknown }>(`/candidates/${cid}/redraft`, { targets: ts, instruction });
      const results = Object.values(r).filter((value): value is { error?: string; queued?: boolean } => typeof value === "object" && value !== null);
      const failure = results.find((value) => value.error);
      if (failure) throw new Error(failure.error);
      if (r?.started || results.some((value) => value.queued)) setGenerationNotice({ text: settings?.llm.provider === "local-agent" ? "로컬 워커에 요청했습니다. 워커를 실행해 두면 완성된 초안이 여기에 도착합니다." : "초안 준비를 요청했습니다. 진행 상태에서 대기·완료·실패를 확인할 수 있습니다." });
      else showToast("새 초안을 준비했습니다. 내용을 확인해 주세요.");
      reload();
      return true;
    } catch (err) { setGenerationNotice({ text: `초안을 만들지 못했습니다. ${(err as Error).message}`, error: true }); return false; } finally { setBusy(null); }
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
            {["dropped", "deferred"].includes(c.status) && <button disabled={busy !== null} onClick={async () => { setBusy("restore"); try { await post(`/candidates/${cid}/status`, { status: data.drafts.some((draft) => draft.status !== "dropped") ? "drafted" : j ? "judged" : "new" }); reload(); showToast("글감 목록으로 되돌렸습니다."); } catch (err) { showToast(`복원하지 못했습니다. ${(err as Error).message}`); } finally { setBusy(null); } }}>글감으로 복원</button>}
            {decision !== "draft" && j && <button className="primary" disabled={busy !== null} onClick={async () => { try { await post(`/candidates/${cid}/override`, { decision: "draft", reason: "other", note: "수동으로 초안 요청" }); await redraftAll(); } catch (err) { showToast(`요청하지 못했습니다. ${(err as Error).message}`); } }}>{busy === "draft" ? "쓰는 중…" : "그래도 초안 쓰기"}</button>}
            <Menu items={[
              { label: busy === "judge" ? "판단 중…" : "다시 분석하기", onClick: async () => { setBusy("judge"); try { await post(`/candidates/${cid}/rejudge`); showToast("분석을 접수했습니다. 생성 진행 상태를 확인해 주세요."); } catch (err) { showToast(`실패: ${(err as Error).message}`); } finally { setBusy(null); } } },
              { label: "모든 채널 다시 쓰기", onClick: redraftAll },
              { label: "보류", onClick: async () => { await post(`/candidates/${cid}/status`, { status: "deferred" }); showToast("보류했습니다"); } },
              { label: "글감 아님으로 보관", danger: true, onClick: async () => { if (!window.confirm("이 글감을 보관할까요? 글감의 보관 필터에서 다시 열 수 있습니다.")) return; await post(`/candidates/${cid}/override`, { decision: "drop", reason: "not_worth" }); showToast("보관했습니다. 보관 필터에서 다시 열 수 있습니다."); } },
            ]} />
          </div>
        </div>
        {j && (
          <details className="judge-details"><summary>추천점수 {j.total} · 평가 기준 보기</summary><div className="cand-judge">
            <Meter scores={j.scores} />
            <span className="small muted">합 {j.total} · {decision === "draft" ? "초안" : decision === "defer" ? "보류" : "추가 근거 필요"} · 기준 초안 {settings?.draftThreshold ?? 6} / 보류 {settings?.deferThreshold ?? 4}{j.overriddenDecision ? ` · 수동 ${j.overriddenDecision}` : ""}</span>
          </div></details>
        )}
      </div>

      {generationNotice && <div className={`inline-notice ${generationNotice.error ? "is-error" : ""}`} role={generationNotice.error ? "alert" : "status"}><span>{generationNotice.text}</span><Link to="/settings?tab=model">모델 설정 확인</Link><button className="ghost sm" aria-label="안내 닫기" onClick={() => setGenerationNotice(null)}>×</button></div>}
      <GenerationStatus candidateId={cid} onChange={reload} />
      <ol className="editor-journey" aria-label="게시까지의 과정"><li><span>1</span> 초안 검토·수정</li><li><span>2</span> 복사해 직접 게시</li><li><span>3</span> 게시 링크 기록</li></ol>
      <div className="cand-layout">


        <section className="cand-main">
          <div className="row between" style={{ alignItems: "baseline", marginBottom: 4 }}>
            <h2 style={{ margin: 0 }}>초안</h2>
            {settings && <Link to="/voice" className="tiny muted">문체: {voicePreset(settings.voice.preset).name}{settings.voice.guide ? " + 내 지침" : ""} ↗</Link>}
          </div>
          {consistency.length > 0 && (
            <div className="callout" style={{ marginBottom: 10 }}>
              <b>언어 간 숫자가 다릅니다.</b> {consistency.map((x) => `${CHANNEL_LABEL[x.channel] ?? x.channel}: ${x.onlyIn.map((o) => `${o.lang.toUpperCase()}에만 ${o.numbers.join(", ")}`).join(" · ")}`).join(" / ")}. 한쪽에만 있는 숫자는 사실 확인 뒤 맞추세요.
            </div>
          )}
          <div className="chtabs" role="group" aria-label="초안 채널">
            {channels.map((ch) => {
              const ls = langsOf(ch);
              const live = ls.map((l) => (draftsByTarget.get(targetKey(ch, l)) ?? []).find((d) => d.status !== "dropped")).filter(Boolean) as Draft[];
              const pub = publications.find((p) => p.channel === ch);
              const st = pub ? "✓" : live.length === ls.length ? (live.every((d) => d.lint.every((l) => l.ok)) ? "●" : "!") : live.length ? `${live.length}/${ls.length}` : busy === "draft" || stage.busy ? "…" : "";
              return <button key={ch} aria-pressed={tab === ch} className={tab === ch ? "active" : ""} onClick={() => switchDraft(() => setTab(ch))}><ChannelIcon channel={ch} />{CHANNEL_LABEL[ch] ?? ch}{st && <span className="st">{st}</span>}</button>;
            })}
          </div>
          {!channels.length && <div className="state-panel"><h2>게시할 채널을 먼저 골라주세요</h2><p>초안을 만들 채널과 언어를 하나 이상 선택하면 시작할 수 있어요.</p><Link className="btn primary" to="/settings?tab=channels">채널 선택하기</Link></div>}
          {current && curKey && (
            <DraftPanel key={`${cid}:${curKey}`} cid={cid} channel={current.channel} lang={current.lang} langs={curLangs} onDirty={setUnsaved} onLang={(l) => switchDraft(() => setLangByCh({ ...langByCh, [current.channel]: l }))} expectedModel={settings?.llm.provider === "gemini" ? (settings.llm.draftModel || "gemini-3.7-flash") : undefined} draftModelResetAt={keys ? keys.filter((k) => k.label.endsWith(settings?.llm.draftModel || "gemini-3.7-flash") && k.cooldownUntil).map((k) => k.cooldownUntil!).sort()[0] : undefined}
              drafts={draftsByTarget.get(curKey) ?? []} published={publications.find((p) => p.channel === current.channel && (p.lang ?? current.lang) === current.lang)?.url}
              busy={busy === `draft:${curKey}` || busy === "draft"} showToast={showToast} onRedraft={(instruction) => redraft([current], instruction, `draft:${curKey}`)} />
          )}
        </section>

        <aside className="cand-side">
          <details className="context-details"><summary>프로젝트 배경과 문체 참고</summary><ProfileBlock repo={c.repo} view={profile} showToast={showToast} /></details>
          <section className="side-block">
            <h2>무엇이 달라졌나</h2>
            {e.highlights?.length ? <ul className="hl check">{e.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul> : <p className="small muted" style={{ margin: 0 }}>{stage.busy ? "다이제스트를 만드는 중입니다." : "초안 만들기를 누르면 이 글감의 변경 내용을 먼저 정리합니다."}</p>}
            {e.ompSummary && <details className="raw"><summary>에이전트 세션 요약</summary><pre className="evidence">{e.ompSummary}</pre></details>}
            {told.length > 0 && (
              <details className="raw"><summary>이 저장소에서 이미 다룬 변경 {told.length}개 · 발행 {told.filter((t) => t.publishedAt).length}개</summary>
                <ul className="hl small told">{told.map((t, i) => <li key={i} className={t.publishedAt ? "pub" : ""}>{t.text}{t.publishedAt && <span className="badge ok" style={{ marginLeft: 6 }}>{t.publishedChannel} 발행</span>}</li>)}</ul>
              </details>
            )}
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
              {e.milestones?.length ? <><dt>이번 창 임계</dt><dd>{e.milestones.map((m) => `${m.metric === "stars" ? "스타" : "다운로드"} ${m.threshold}`).join(" · ")}</dd></> : null}
              <dt>데모</dt><dd className={e.demoAsset ? "" : "muted"}>{e.demoAsset ? e.demoAsset.split("/").pop() : "없음 (올리기 전 GIF나 스크린샷을 준비하세요)"}</dd>
            </dl>
            <h2 style={{ marginTop: 14 }}>한계</h2>
            {e.limitations?.length ? e.limitations.map((l, i) => <div key={i} className="callout" style={{ marginTop: i ? 6 : 0 }}>{l}</div>) : <div className="callout muted-box">수집한 자료에 명시된 한계가 없습니다. 게시 전에 알려진 제약이 있는지 직접 확인하세요.</div>}
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
      </div>
      <Toast msg={toast} />
    </>
  );
}

const REWRITE_HINTS = ["더 짧게", "첫 문장을 문제로 시작", "숫자를 앞으로", "한계를 더 구체적으로", "질문으로 끝내기", "덜 격식 있게"];

const LangSeg = ({ langs, lang, onLang }: { langs: string[]; lang: string; onLang: (l: string) => void }) => langs.length > 1 ? <div className="lang-seg" role="group" aria-label="언어">{langs.map((l) => <button key={l} aria-pressed={l === lang} className={l === lang ? "on" : ""} onClick={() => onLang(l)}>{l.toUpperCase()}</button>)}</div> : <span className="badge outline">{lang.toUpperCase()}</span>;

export function DraftPanel({ cid, channel, lang, langs, onLang, drafts, published, busy, onRedraft, showToast, expectedModel, draftModelResetAt, onDirty }: { cid: number; channel: Channel; lang: string; langs: string[]; onLang: (l: string) => void; drafts: Draft[]; published?: string; busy: boolean; onRedraft: (instruction?: string) => Promise<boolean>; showToast: (m: string) => void; expectedModel?: string; draftModelResetAt?: number; onDirty?: (dirty: boolean) => void }) {
  const [savedDraft, setSavedDraft] = useState<Draft | null>(null);
  const merged = drafts.map((d) => savedDraft?.id === d.id && savedDraft.updatedAt >= d.updatedAt ? savedDraft : d);
  const versions = [...merged].sort((a, b) => b.version - a.version);
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
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const publicationUrl = published ?? recordedUrl;
  const [dropOpen, setDropOpen] = useState(false);
  const [dropReason, setDropReason] = useState<(typeof REASONS)[number][0]>("voice");
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [action, setAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const unsaved = editing && (body !== (latest?.body ?? "") || title !== (latest?.title ?? ""));
  const blocker = useBlocker(unsaved);
  useEffect(() => { onDirty?.(unsaved); return () => onDirty?.(false); }, [unsaved, onDirty]);
  useEffect(() => {
    if (!unsaved) return;
    const beforeLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    const followLink = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement).closest("a[href]");
      if (anchor && new URL((anchor as HTMLAnchorElement).href).origin !== window.location.origin && anchor.getAttribute("target") !== "_blank" && !window.confirm("저장하지 않은 수정 내용이 있습니다. 내용을 버리고 이동할까요?")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", beforeLeave);
    document.addEventListener("click", followLink, true);
    return () => { window.removeEventListener("beforeunload", beforeLeave); document.removeEventListener("click", followLink, true); };
  }, [unsaved]);

  useEffect(() => { if (editing) return; setTitle(latest?.title ?? ""); setBody(latest?.body ?? ""); setEditing(false); setViewId(null); setRewriteOpen(false); setStep(latest?.status === "copied" ? "post" : "draft"); }, [latest?.id, latest?.title, latest?.body, latest?.status, editing]);

  const full = spec.hasTitle ? `${title}\n\n${body}` : body;
  const save = async (copyAfter: boolean) => {
    if (!latest || action || !body.trim()) return;
    setAction(copyAfter ? "copy" : "save"); setActionError(null);
    let copied = false;
    try {
      if (copyAfter) { await navigator.clipboard.writeText(full); copied = true; }
      const saved = await post<Draft>(`/drafts/${latest.id}/edit`, { title: spec.hasTitle ? title : undefined, body, markCopied: copyAfter });
      if (saved?.id) setSavedDraft(saved);
      setEditing(false); if (copyAfter) setStep("post");
      showToast(copyAfter ? "복사했습니다. 채널에 게시한 뒤 아래에 링크를 남겨주세요." : "수정한 내용을 저장했습니다.");
    } catch (err) {
      setActionError(copied ? "복사는 완료했지만 저장하지 못했습니다. 내용을 유지한 채 다시 저장해 주세요." : copyAfter ? "복사하지 못했습니다. 브라우저의 클립보드 권한을 확인하거나 수정 화면에서 직접 복사해 주세요." : `저장하지 못했습니다. ${(err as Error).message}`);
    } finally { setAction(null); }
  };
  const copy = () => save(true);
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (editing || action || !latest || (ev.target as HTMLElement)?.closest("input, textarea, select, button, a, [contenteditable=true]") || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (viewId !== null && viewId !== latest.id) return;
      if (ev.key === "c") void copy();
      if (ev.key === "e") setEditing(true);
      if (ev.key === "r") setRewriteOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (publicationUrl) return <div className="card"><h2 className="completed-title">게시 기록을 남겼어요</h2><p className="small"><span className="badge ok">올림</span> <a href={publicationUrl} target="_blank" rel="noreferrer">{publicationUrl}</a></p><p className="tiny muted">발행 기록에서 게시 후 변화를 확인할 수 있어요.</p><Link to="/published" className="btn primary">발행 기록 보기 →</Link></div>;
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
      {blocker.state === "blocked" && <div className="inline-notice" role="alert">
        <p>저장하지 않은 수정 내용이 있습니다. 내용을 버리고 이동할까요?</p>
        <button onClick={() => blocker.reset()}>계속 수정</button>
        <button onClick={() => blocker.proceed()}>수정 내용 버리고 이동</button>
      </div>}
      {actionError && <div className="inline-notice is-error" role="alert">{actionError}</div>}
      {latest.lint.some((item) => !item.ok && item.detail) && <details className="raw">
        <summary>초안에서 확인할 부분</summary>
        <p className="small muted">저장된 초안의 자동 점검 결과입니다. 수정 후 저장하면 다시 점검합니다. 통과해도 사실 확인은 필요합니다.</p>
        <ul className="small">{latest.lint.filter((item) => !item.ok && item.detail).map((item) => <li key={item.rule}>{item.detail}</li>)}</ul>
      </details>}
      <div className="draft-head">
        <div className="meta">
          <LangSeg langs={langs} lang={lang} onLang={onLang} />
          <LintBadges lint={latest.lint} />
          {expectedModel && !latest.model.includes(expectedModel) && latest.model.startsWith("gemini/") && (
            <span className="badge warn" title={`설정된 초안 모델(${expectedModel}) 대신 다른 모델로 생성했습니다. 생성 모델을 확인하고 내용을 검토하세요.`}>대체 모델{draftModelResetAt ? ` · ${new Date(draftModelResetAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 이후 다시 쓰기 권장` : ""}</span>
          )}
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
          {spec.hasTitle && <input aria-label="초안 제목" value={title} onChange={(ev) => setTitle(ev.target.value)} style={{ marginBottom: 8 }} placeholder="제목" />}
          <textarea aria-label="초안 본문" value={body} onChange={(ev) => setBody(ev.target.value)} autoFocus />
          <div className="row between" style={{ marginTop: 6 }}><span className="tiny muted">{[...body].length}{spec.maxChars ? `/${spec.maxChars}` : ""}자</span></div>
          {changed && <><div className="tiny muted" style={{ margin: "8px 0 4px" }}>바뀐 부분. 저장하면 이 문장이 내 문체 예시로 남습니다 (설정에서 예시 참고를 켠 경우에만 프롬프트에 들어갑니다).</div><WordDiff before={latest.body} after={body} /></>}
          <div className="toolbar" style={{ marginTop: 10 }}>
            <button className="primary" disabled={action !== null || !body.trim()} onClick={() => void copy()}>{action === "copy" ? "저장 중…" : "저장하고 복사"}</button>
            <button disabled={action !== null || !body.trim()} onClick={() => void save(false)}>{action === "save" ? "저장 중…" : "변경 저장"}</button>
            <button className="ghost" onClick={() => { setTitle(latest.title ?? ""); setBody(latest.body); setEditing(false); }}>취소</button>
          </div>
        </>
      ) : (
        <>
          {view === "preview" ? <ChannelPreview channel={channel} title={shown?.title ?? title} body={shown?.body ?? body} author={author} /> : <>{spec.hasTitle && <div style={{ fontWeight: 600, marginBottom: 8 }}>{shown?.title ?? title}</div>}<div className="draft-body">{shown?.body ?? body}</div></>}
          {!isOld && (
            <div className="draft-actions">
              <div className="toolbar">
                <button className="primary" title="단축키 c" disabled={action !== null} onClick={() => void copy()}>{action === "copy" ? "복사 중…" : "초안 복사"}</button>
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
                <button className="primary" disabled={busy} onClick={async () => { if (await onRedraft(instruction.trim() || undefined)) { setRewriteOpen(false); setInstruction(""); } }}>{busy ? "쓰는 중…" : instruction.trim() ? "이 지침으로 다시 쓰기" : "같은 문체로 다시 쓰기"}</button>
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

      {!editing && !isOld && (
        <div className="step-post">
          <p className="tiny muted">자동 점검은 사실 확인을 대신하지 않습니다. 변경 근거와 대조해 경험·수치·변경 내용을 확인하세요.</p>
          <div className="row between"><b>{step === "post" ? "복사 완료 · 이제 게시해 보세요" : "게시하고 링크 남기기"}</b>{spec.composeUrl && <a className="btn sm" href={spec.composeUrl} target="_blank" rel="noreferrer">{spec.label} 작성 화면 열기 ↗</a>}</div>
          <p className="small muted" style={{ marginTop: 10 }}>소문이 대신 게시하지는 않습니다. 채널에서 직접 올린 뒤 링크를 등록하면 발행 기록에 남습니다.</p>
          <details className="raw"><summary>게시 전 확인할 점</summary><ol>{spec.runbook.map((r, i) => <li key={i}>{r}</li>)}{spec.mediaHint && <li>이미지: {spec.mediaHint}</li>}</ol></details>
          <form className="publication-form" onSubmit={async (event) => {
            event.preventDefault(); setAction("publish"); setActionError(null);
            try { await post("/publications", { candidateId: cid, draftId: latest.id, channel, lang, url: url.trim() }); setRecordedUrl(url.trim()); setUrl(""); showToast("발행 기록에 저장했습니다."); }
            catch (err) { setActionError(`게시 링크를 저장하지 못했습니다. ${(err as Error).message}`); }
            finally { setAction(null); }
          }}>
            <label className="field"><span>이미 게시했나요? 게시글 링크</span><input type="url" required placeholder="https://…" value={url} onChange={(ev) => setUrl(ev.target.value)} /></label>
            <button disabled={action !== null || !/^https?:\/\//.test(url.trim())} type="submit">{action === "publish" ? "저장 중…" : "게시 링크 저장"}</button>
          </form>
        </div>
      )}
    </div>
  );
}

const STAGE_LABEL: Record<string, string> = { experiment: "실험", beta: "베타", stable: "안정", archived: "보관", unknown: "단계 미상" };

/** 프로젝트 프로필: 정체성의 기준선. 여기 적힌 것은 "변경"으로 다시 알리지 않는다. 사용자가 고치면 재생성해도 유지된다. */
function ProfileBlock({ repo, view, showToast }: { repo: string; view?: RepoProfileView; showToast: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const p = view?.profile;
  const [what, setWhat] = useState(p?.what ?? "");
  const [audience, setAudience] = useState(p?.audience ?? "");
  const [claims, setClaims] = useState((p?.claims ?? []).join("\n"));
  const [avoid, setAvoid] = useState((p?.avoid ?? []).join(", "));
  useEffect(() => { setWhat(p?.what ?? ""); setAudience(p?.audience ?? ""); setClaims((p?.claims ?? []).join("\n")); setAvoid((p?.avoid ?? []).join(", ")); }, [p?.what, p?.audience, p?.claims, p?.avoid]);
  const regen = async () => { setBusy(true); try { await post(`/profiles/${repo}/regenerate`); showToast("프로필을 다시 만들었습니다."); } catch (e) { showToast(`실패: ${(e as Error).message}`); } finally { setBusy(false); } };
  return (
    <section className="side-block profile">
      <div className="row between" style={{ alignItems: "baseline" }}>
        <h2 style={{ margin: 0 }}>프로젝트 <span className="tiny muted" style={{ textTransform: "none", letterSpacing: 0 }}>기준선</span></h2>
        {!editing && <span className="row" style={{ gap: 6 }}>{view && <button className="ghost sm" onClick={() => setEditing(true)}>고치기</button>}<button className="ghost sm" disabled={busy} onClick={() => void regen()}>{busy ? "만드는 중…" : view ? "다시 생성" : "프로필 만들기"}</button></span>}
      </div>
      {!view && !editing && <p className="small muted" style={{ margin: "8px 0 0" }}>아직 프로필이 없습니다. 다음 수집 때 README로 만들어지며, 지금 만들 수도 있습니다. 프로필이 있어야 다이제스트가 "무엇이 원래 있던 것"과 "무엇이 바뀐 것"을 나눕니다.</p>}
      {view && !editing && (
        <div className="stack" style={{ gap: 6, marginTop: 8 }}>
          <p className="small" style={{ margin: 0, lineHeight: 1.55 }}>{p!.what || <span className="muted">설명 없음</span>}</p>
          <div className="tiny muted">{p!.audience}</div>
          <div className="row wrap" style={{ gap: 6 }}><span className="badge outline">{STAGE_LABEL[p!.stage] ?? p!.stage}</span>{p!.naming && <span className="badge outline">{p!.naming}</span>}{view.editedFields.length > 0 && <span className="badge ok">내가 고침</span>}</div>
          {p!.claims.length > 0 && <ul className="hl small" style={{ marginTop: 4 }}>{p!.claims.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          {p!.avoid.length > 0 && <div className="tiny muted">쓰지 않음: {p!.avoid.join(", ")}</div>}
          <div className="meta-line"><code>{view.model.split("@")[0].replace("gemini/", "")}</code><span>{fmtDate(view.updatedAt)}</span></div>
        </div>
      )}
      {editing && (
        <div className="stack" style={{ gap: 8, marginTop: 8 }}>
          <label className="field"><span>무엇인가</span><textarea value={what} onChange={(ev) => setWhat(ev.target.value)} style={{ minHeight: 56 }} /></label>
          <label className="field"><span>누구를 위한 것인가</span><input value={audience} onChange={(ev) => setAudience(ev.target.value)} /></label>
          <label className="field"><span>핵심 주장 (한 줄에 하나)</span><textarea value={claims} onChange={(ev) => setClaims(ev.target.value)} style={{ minHeight: 70 }} /></label>
          <label className="field"><span>글에 쓰지 않을 말 (쉼표로)</span><input value={avoid} onChange={(ev) => setAvoid(ev.target.value)} placeholder="회사명, 내부 호스트명…" /></label>
          <div className="toolbar">
            <button className="primary" onClick={async () => { await patch(`/profiles/${repo}`, { what, audience, claims: claims.split("\n").map((x) => x.trim()).filter(Boolean), avoid: avoid.split(",").map((x) => x.trim()).filter(Boolean) }); setEditing(false); showToast("프로필을 저장했습니다. 다음 다이제스트부터 반영됩니다."); }}>저장</button>
            <button className="ghost" onClick={() => setEditing(false)}>취소</button>
          </div>
        </div>
      )}
    </section>
  );
}
