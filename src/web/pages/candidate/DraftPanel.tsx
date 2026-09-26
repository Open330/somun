import { useEffect, useState } from "react";
import { Link, useBlocker } from "react-router-dom";
import { CHANNELS, type Channel } from "@core/channels";
import { trackLinks } from "@core/links";
import type { Draft, Publication } from "@shared/types";
import { channelLabel, LintBadges, Menu, REASONS, lintDetail, targetLabel } from "../../components/ui";
import { ChannelPreview, WordDiff } from "../../components/preview";
import { del, patch, post } from "../../lib/api";
import { useAuth } from "../../lib/auth/context";
import { setUnsaved } from "../../lib/unsaved";
import { dateLocale, t } from "../../i18n";

/**
 * 채널·언어 하나의 초안: 검토, 수정, 복사, 다시 쓰기, 버리기, 게시 링크 기록.
 * 수정 중 이탈은 SPA 이동(useBlocker)과 새로고침·외부 이동(beforeunload)에서 막는다.
 */

type PublicationLink = Pick<Publication, "id" | "url" | "draftId">;

const REWRITE_HINTS = ["더 짧게", "첫 문장을 문제로 시작", "숫자를 앞으로", "한계를 더 구체적으로", "질문으로 끝내기", "덜 격식 있게"];

const LangSeg = ({ langs, lang, onLang }: { langs: string[]; lang: string; onLang: (l: string) => void }) => langs.length > 1 ? <div className="lang-seg" role="group" aria-label={t("언어")}>{langs.map((l) => <button key={l} aria-pressed={l === lang} className={l === lang ? "on" : ""} onClick={() => onLang(l)}>{l.toUpperCase()}</button>)}</div> : <span className="badge outline">{lang.toUpperCase()}</span>;

export default function DraftPanel({ cid, channel, lang, langs, onLang, drafts, publications = [], busy, onRedraft, showToast, expectedModel, draftModelResetAt, onDirty, homepage, track = true }: { cid: number; channel: Channel; lang: string; langs: string[]; onLang: (l: string) => void; drafts: Draft[]; publications?: PublicationLink[]; busy: boolean; onRedraft: (instruction?: string, introduction?: boolean) => Promise<boolean>; showToast: (m: string) => void; expectedModel?: string; draftModelResetAt?: number; onDirty?: (dirty: boolean) => void; homepage?: string; track?: boolean }) {
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
  const [recorded, setRecorded] = useState<PublicationLink | null>(null);
  const [removedIds, setRemovedIds] = useState<number[]>([]);
  const records = [...(recorded ? [recorded] : []), ...publications].filter((p) => !removedIds.includes(p.id));
  const publication = latest ? records.find((p) => p.draftId === latest.id) : records[0];
  const shownPublication = shown ? records.find((p) => p.draftId === shown.id) : undefined;
  const [showDraft, setShowDraft] = useState(false);
  const [dropOpen, setDropOpen] = useState(false);
  const [dropReason, setDropReason] = useState<(typeof REASONS)[number][0]>("voice");
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [action, setAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const unsaved = editing && (body !== (latest?.body ?? "") || title !== (latest?.title ?? ""));
  const blocker = useBlocker(unsaved);
  useEffect(() => { onDirty?.(unsaved); setUnsaved(unsaved); return () => { onDirty?.(false); setUnsaved(false); }; }, [unsaved, onDirty]);
  // 새로고침·외부 링크는 브라우저의 이탈 확인으로 막는다(별도 확인 창을 더 띄우면 두 번 묻게 된다).
  useEffect(() => {
    if (!unsaved) return;
    const beforeLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", beforeLeave);
    return () => window.removeEventListener("beforeunload", beforeLeave);
  }, [unsaved]);

  useEffect(() => { if (editing) return; setTitle(latest?.title ?? ""); setBody(latest?.body ?? ""); setEditing(false); setViewId(null); setRewriteOpen(false); setStep(latest?.status === "copied" ? "post" : "draft"); }, [latest?.id, latest?.title, latest?.body, latest?.status, editing]);

  const full = spec.hasTitle ? `${title}\n\n${body}` : body;
  // 클립보드로 가는 글. 저장된 초안은 그대로 두고 링크에만 채널 표시를 붙인다.
  const outgoing = track ? trackLinks(full, { channel, homepage }) : full;
  const unsupported = (lint?: Draft["lint"]) => lint?.find((item) => item.rule === "numbers_need_review" && !item.ok);
  const save = async (copyAfter: boolean) => {
    if (!latest || action || !body.trim()) return;
    // 원자료에서 찾지 못한 수치가 있으면 복사 전에 한 번 확인한다. 게시하면 되돌리기 어렵다.
    const bodyChanged = latest.body !== body || (latest.title ?? "") !== (title || "");
    const check = !bodyChanged ? unsupported(latest.lint) : undefined;
    if (copyAfter && check && !window.confirm(`${lintDetail(check) ?? t("원자료에서 찾지 못한 수치가 있습니다.")}\n\n${t("확인했다면 그대로 복사할까요?")}`)) return;
    setAction(copyAfter ? "copy" : "save"); setActionError(null);
    let copied = false;
    try {
      if (copyAfter) { await navigator.clipboard.writeText(outgoing); copied = true; }
      const saved = await post<Draft>(`/drafts/${latest.id}/edit`, { title: spec.hasTitle ? title : undefined, body, markCopied: copyAfter });
      if (saved?.id) setSavedDraft(saved);
      setEditing(false); if (copyAfter) setStep("post");
      const after = bodyChanged ? unsupported(saved?.lint) : undefined;
      if (after) setActionError(`${copyAfter ? `${t("복사했습니다.")} ` : ""}${lintDetail(after) ?? t("원자료에서 찾지 못한 수치가 있습니다.")}`);
      showToast(copyAfter ? t("복사했습니다. 채널에 게시한 뒤 아래에 링크를 남겨주세요.") : t("수정한 내용을 저장했습니다."));
    } catch (err) {
      setActionError(copied ? t("복사는 완료했지만 저장하지 못했습니다. 내용을 유지한 채 다시 저장해 주세요.") : copyAfter ? t("복사하지 못했습니다. 브라우저의 클립보드 권한을 확인하거나 수정 화면에서 직접 복사해 주세요.") : `${t("저장하지 못했습니다.")} ${(err as Error).message}`);
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

  if (publication && !showDraft) return <>
    <LangSeg langs={langs} lang={lang} onLang={onLang} />
    <PublishedCard key={publication.id} publication={publication} showToast={showToast} onShowDraft={latest ? () => setShowDraft(true) : undefined} onRemoved={() => { setRemovedIds((ids) => [...ids, publication.id]); setRecorded(null); }} />
  </>;
  const introductionButton = <button disabled={busy} title={t("변경사항 대신 서비스의 목적과 주요 기능을 소개하는 새 초안을 씁니다.")} onClick={() => void onRedraft(undefined, true)}>{t("서비스 처음 소개하기")}</button>;
  if (!latest) {
    return (
      <div className="card draft-empty">
        <LangSeg langs={langs} lang={lang} onLang={onLang} />
        <p className="muted small" style={{ margin: 0 }}>{t("{target} 초안이 아직 없습니다. 설정된 문체와 이 글감의 사실만으로 씁니다.", { target: targetLabel(channel, lang, Boolean(spec.fixedLang)) })}</p>
        <button className="primary" disabled={busy} onClick={() => void onRedraft()}>{busy ? t("쓰는 중…") : t("초안 쓰기")}</button>
        {introductionButton}
      </div>
    );
  }
  const changed = latest.body !== body || (latest.title ?? "") !== (title || "");
  const isOld = shown && shown.id !== latest.id;
  const count = [...body].length;

  return (
    <div className="card draft-card">
      {blocker.state === "blocked" && <div className="inline-notice" role="alert">
        <p>{t("저장하지 않은 수정 내용이 있습니다. 내용을 버리고 이동할까요?")}</p>
        <button onClick={() => blocker.reset()}>{t("계속 수정")}</button>
        <button onClick={() => blocker.proceed()}>{t("수정 내용 버리고 이동")}</button>
      </div>}
      {actionError && <div className="inline-notice is-error" role="alert">{actionError}</div>}
      {shownPublication && showDraft && <div className="inline-notice" role="status"><span>{t("이미 게시한 초안입니다.")}</span><button className="ghost sm" onClick={() => setShowDraft(false)}>{t("게시 기록으로")}</button></div>}
      {latest.lint.some((item) => !item.ok && item.detail) && <details className="raw">
        <summary>{t("초안에서 확인할 부분")}</summary>
        <p className="small muted">{t("저장된 초안의 자동 점검 결과입니다. 수정 후 저장하면 다시 점검합니다. 통과해도 사실 확인은 필요합니다.")}</p>
        <ul className="small">{latest.lint.filter((item) => !item.ok && item.detail).map((item) => <li key={item.rule}>{lintDetail(item)}</li>)}</ul>
      </details>}
      <div className="draft-head">
        <div className="meta">
          <LangSeg langs={langs} lang={lang} onLang={onLang} />
          {shown?.purpose && <span className="badge outline">{shown.purpose === "introduction" ? t("서비스 소개") : t("변경사항 소개")}</span>}
          <LintBadges lint={latest.lint} />
          {expectedModel && !latest.model.includes(expectedModel) && latest.model.startsWith("gemini/") && (
            <span className="badge warn" title={t("설정된 초안 모델({model}) 대신 다른 모델로 생성했습니다. 생성 모델을 확인하고 내용을 검토하세요.", { model: expectedModel })}>{t("대체 모델")}{draftModelResetAt ? ` · ${t("{time} 이후 다시 쓰기 권장", { time: new Date(draftModelResetAt).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" }) })}` : ""}</span>
          )}
          <span className={`badge ${spec.maxChars && count > spec.maxChars ? "bad" : "outline"}`}>{t("{n}자", { n: `${count}${spec.maxChars ? ` / ${spec.maxChars}` : ""}` })}</span>
          {versions.length > 1 ? (
            <select className="ver" value={shown?.id ?? latest.id} onChange={(ev) => setViewId(Number(ev.target.value))} title={t("버전")}>
              {versions.map((d) => <option key={d.id} value={d.id}>v{d.version}{d.status === "dropped" ? t(" (버림)") : d.id === latest.id ? t(" (현재)") : ""} · {d.model.split("@")[0].replace("gemini/", "")}</option>)}
            </select>
          ) : <span className="tiny muted">v{latest.version} · {latest.model.split("@")[0].replace("gemini/", "")}</span>}
        </div>
        {!editing && <div className="row" style={{ gap: 8 }}>
          <div className="seg" role="group" aria-label={t("보기 방식")}><button aria-pressed={view === "preview"} className={view === "preview" ? "active" : ""} onClick={() => setView("preview")}>{t("미리보기")}</button><button aria-pressed={view === "text"} className={view === "text" ? "active" : ""} onClick={() => setView("text")}>{t("텍스트")}</button></div>
          <Menu items={[{ label: t("버리기 (사유 선택)"), danger: true, onClick: () => setDropOpen(true) }]} />
        </div>}
      </div>

      {isOld && shown && (
        <div className="old-ver small">
          <span>{t("v{version} 이전 판을 보고 있습니다.", { version: shown.version })}</span>
          <span className="toolbar"><button className="sm" onClick={() => { setTitle(shown.title ?? ""); setBody(shown.body); setViewId(null); setEditing(true); }}>{t("이 판으로 수정 시작")}</button><button className="ghost sm" onClick={() => setViewId(null)}>{t("현재 판으로")}</button></span>
        </div>
      )}

      {editing ? (
        <>
          {spec.hasTitle && <input aria-label={t("초안 제목")} value={title} onChange={(ev) => setTitle(ev.target.value)} style={{ marginBottom: 8 }} placeholder={t("제목")} />}
          <textarea aria-label={t("초안 본문")} value={body} onChange={(ev) => setBody(ev.target.value)} autoFocus />
          <div className="row between" style={{ marginTop: 6 }}><span className="tiny muted">{t("{n}자", { n: `${[...body].length}${spec.maxChars ? `/${spec.maxChars}` : ""}` })}</span></div>
          {changed && <><div className="tiny muted" style={{ margin: "8px 0 4px" }}>{t("바뀐 부분. 복사하면 이 글이 내 문체 예시가 되고, 바꾼 이유는 문체 규칙 제안으로 돌아옵니다.")}</div><WordDiff before={latest.body} after={body} /></>}
          <div className="toolbar" style={{ marginTop: 10 }}>
            <button className="primary" disabled={action !== null || !body.trim()} onClick={() => void copy()}>{action === "copy" ? t("저장 중…") : t("저장하고 복사")}</button>
            <button disabled={action !== null || !body.trim()} onClick={() => void save(false)}>{action === "save" ? t("저장 중…") : t("변경 저장")}</button>
            <button className="ghost" onClick={() => { setTitle(latest.title ?? ""); setBody(latest.body); setEditing(false); }}>{t("취소")}</button>
          </div>
        </>
      ) : (
        <>
          {view === "preview" ? <ChannelPreview channel={channel} title={shown?.title ?? title} body={shown?.body ?? body} author={author} /> : <>{spec.hasTitle && <div style={{ fontWeight: 600, marginBottom: 8 }}>{shown?.title ?? title}</div>}<div className="draft-body">{shown?.body ?? body}</div></>}
          {!isOld && (
            <div className="draft-actions">
              <div className="toolbar">
                <button className="primary" title={t("단축키 c")} disabled={action !== null} onClick={() => void copy()}>{action === "copy" ? t("복사 중…") : t("초안 복사")}</button>
                <button title="e" onClick={() => setEditing(true)}>{t("수정")}</button>
                <button className={rewriteOpen ? "active" : ""} title="r" disabled={busy} onClick={() => setRewriteOpen((o) => !o)}>{busy ? t("쓰는 중…") : t("다시 쓰기")}</button>
                {introductionButton}
              </div>
              <span className="tiny muted"><span className="kbd">c</span> <span className="kbd">e</span> <span className="kbd">r</span></span>
            </div>
          )}
          {!isOld && outgoing !== full && <div className="tiny muted" style={{ marginTop: 6 }}>{t("복사할 때 링크에 채널 표시(utm_source={channel})를 붙여 어느 글에서 왔는지 셀 수 있게 합니다. 설정 → 채널에서 끌 수 있습니다.", { channel })}</div>}
          {rewriteOpen && !isOld && (
            <div className="rewrite">
              <div className="rewrite-head"><b>{t("다시 쓰기")}</b><span className="tiny muted">{t("사실과 숫자는 그대로. 비우면 같은 문체로 새로 씁니다.")}</span></div>
              <div className="chips">{REWRITE_HINTS.map((h) => <button key={h} className="ghost sm chip" onClick={() => setInstruction((v) => (v ? `${v}, ${t(h)}` : t(h)))}>{t(h)}</button>)}</div>
              <textarea value={instruction} onChange={(ev) => setInstruction(ev.target.value)} placeholder={t("바꾸고 싶은 점. 예: 첫 문장을 내가 겪은 문제로 시작")} />
              <div className="toolbar">
                <button className="primary" disabled={busy} onClick={async () => { if (await onRedraft(instruction.trim() || undefined)) { setRewriteOpen(false); setInstruction(""); } }}>{busy ? t("쓰는 중…") : instruction.trim() ? t("이 지침으로 다시 쓰기") : t("같은 문체로 다시 쓰기")}</button>
                <button className="ghost" onClick={() => setRewriteOpen(false)}>{t("닫기")}</button>
              </div>
            </div>
          )}
        </>
      )}

      {dropOpen && (
        <div className="row wrap" style={{ marginTop: 10 }}>
          <select value={dropReason} onChange={(ev) => setDropReason(ev.target.value as never)}>{REASONS.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}</select>
          <button className="danger" disabled={action !== null} onClick={async () => {
            setAction("drop"); setActionError(null);
            try { await post(`/drafts/${latest.id}/drop`, { reason: dropReason }); setDropOpen(false); showToast(t("버렸습니다. 사유가 다음 초안에 반영됩니다.")); }
            catch (err) { setActionError(`${t("버리지 못했습니다. 사유는 학습에 쓰이니 다시 시도해 주세요.")} ${(err as Error).message}`); }
            finally { setAction(null); }
          }}>{action === "drop" ? t("버리는 중…") : t("버리기")}</button>
          <button className="ghost" onClick={() => setDropOpen(false)}>{t("취소")}</button>
        </div>
      )}

      {!editing && !isOld && !publication && (
        <div className="step-post">
          <p className="tiny muted">{t("자동 점검은 사실 확인을 대신하지 않습니다. 변경 근거와 대조해 경험·수치·변경 내용을 확인하세요.")}</p>
          <div className="row between"><b>{step === "post" ? t("복사 완료 · 이제 게시해 보세요") : t("게시하고 링크 남기기")}</b>{spec.composeUrl && <a className="btn sm" href={spec.composeUrl} target="_blank" rel="noreferrer">{t("{channel} 작성 화면 열기", { channel: channelLabel(channel) })} ↗</a>}</div>
          <p className="small muted" style={{ marginTop: 10 }}>{t("소문이 대신 게시하지는 않습니다. 채널에서 직접 올린 뒤 링크를 등록하면 발행 기록에 남습니다.")}</p>
          <details className="raw"><summary>{t("게시 전 확인할 점")}</summary><ol>{spec.runbook.map((r, i) => <li key={i}>{t(r)}</li>)}{spec.mediaHint && <li>{t("이미지:")} {t(spec.mediaHint)}</li>}</ol></details>
          <form className="publication-form" onSubmit={async (event) => {
            event.preventDefault(); setAction("publish"); setActionError(null);
            try { const r = await post<{ id: number }>("/publications", { candidateId: cid, draftId: latest.id, channel, lang, url: url.trim() }); setRecorded({ id: r.id, draftId: latest.id, url: url.trim() }); setShowDraft(false); setUrl(""); showToast(t("발행 기록에 저장했습니다.")); }
            catch (err) { setActionError(`${t("게시 링크를 저장하지 못했습니다.")} ${(err as Error).message}`); }
            finally { setAction(null); }
          }}>
            <label className="field"><span>{t("이미 게시했나요? 게시글 링크")}</span><input type="url" required placeholder="https://…" value={url} onChange={(ev) => setUrl(ev.target.value)} /></label>
            <button disabled={action !== null || !/^https?:\/\//.test(url.trim())} type="submit">{action === "publish" ? t("저장 중…") : t("게시 링크 저장")}</button>
          </form>
        </div>
      )}
    </div>
  );
}

/** 게시 기록. 잘못 적은 링크는 고치거나 지울 수 있다. */
function PublishedCard({ publication, showToast, onShowDraft, onRemoved }: { publication: { id: number; url: string }; showToast: (m: string) => void; onShowDraft?: () => void; onRemoved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(publication.url);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setError(null);
    try { await fn(); showToast(done); return true; } catch (err) { setError((err as Error).message); return false; } finally { setBusy(false); }
  };
  return <div className="card">
    <h2 className="completed-title">{t("게시 기록을 남겼어요")}</h2>
    {error && <div className="inline-notice is-error" role="alert">{t("저장하지 못했습니다.")} {error}</div>}
    {editing ? <form className="publication-form" onSubmit={async (ev) => { ev.preventDefault(); if (await run(() => patch(`/publications/${publication.id}`, { url: url.trim() }), t("링크를 고쳤습니다."))) setEditing(false); }}>
      <label className="field"><span>{t("게시글 링크")}</span><input type="url" required value={url} onChange={(ev) => setUrl(ev.target.value)} /></label>
      <div className="toolbar"><button className="primary" type="submit" disabled={busy || !/^https?:\/\//.test(url.trim())}>{busy ? t("저장 중…") : t("링크 저장")}</button><button type="button" className="ghost" onClick={() => { setUrl(publication.url); setEditing(false); }}>{t("취소")}</button></div>
    </form> : <p className="small"><span className="badge ok">{t("올림")}</span> <a href={publication.url} target="_blank" rel="noreferrer">{publication.url}</a></p>}
    <p className="tiny muted">{t("발행 기록에서 게시 후 변화를 확인할 수 있어요.")}</p>
    <div className="toolbar">
      <Link to="/published" className="btn primary">{t("발행 기록 보기 →")}</Link>
      {!editing && <button onClick={() => setEditing(true)}>{t("링크 고치기")}</button>}
      {onShowDraft && <button className="ghost" onClick={onShowDraft}>{t("초안 다시 보기")}</button>}
      <button className="ghost danger" disabled={busy} onClick={async () => { if (window.confirm(t("이 게시 기록을 지울까요? 게시글 자체는 지워지지 않습니다."))) { if (await run(() => del(`/publications/${publication.id}`), t("게시 기록을 지웠습니다."))) onRemoved(); } }}>{t("기록 지우기")}</button>
    </div>
  </div>;
}
