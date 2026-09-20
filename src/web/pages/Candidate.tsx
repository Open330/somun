import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { CHANNELS, type Channel } from "@core/channels";
import type { CandidateDetail, Draft, SettingsView } from "@shared/types";
import { CHANNEL_LABEL, DecisionBadge, LintBadges, REASONS, ScoreBar, TYPE_LABEL, fmtDate, stageOf } from "../components/ui";
import { ChannelPreview, WordDiff } from "../components/preview";
import { useAuth } from "../lib/auth/context";
import { post, useResource } from "../lib/api";

export default function Candidate() {
  const { id } = useParams<{ id: string }>();
  const cid = Number(id);
  const { data } = useResource<CandidateDetail>(`/candidates/${cid}`, ["candidates", "drafts", "publications"]);
  const { data: settings } = useResource<SettingsView>("/settings", ["settings"]);
  const rejudge = (args: { candidateId: number }) => post(`/candidates/${args.candidateId}/rejudge`);
  const redraft = (args: { candidateId: number; channels: string[] }) => post(`/candidates/${args.candidateId}/redraft`, { channels: args.channels });
  const override = (args: { id: number; decision: "draft" | "drop"; reason: string; note?: string }) => post(`/candidates/${args.id}/override`, { decision: args.decision, reason: args.reason, note: args.note });
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<Channel | null>(null);

  const draftsByChannel = useMemo(() => {
    const m = new Map<Channel, Draft[]>();
    for (const d of data?.drafts ?? []) m.set(d.channel, [...(m.get(d.channel) ?? []), d]);
    return m;
  }, [data?.drafts]);
  const channels = useMemo(() => {
    const enabled = settings?.enabledChannels ?? [];
    const withDrafts = [...draftsByChannel.keys()];
    return [...new Set([...withDrafts, ...enabled])] as Channel[];
  }, [draftsByChannel, settings?.enabledChannels]);
  useEffect(() => {
    if (!tab && channels.length) setTab(channels[0]);
  }, [channels, tab]);

  if (!data) return <div className="empty">불러오는 중…</div>;
  const { candidate: c, judgments, publications } = data;
  const j = judgments[0];
  const e = c.evidence;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="row" style={{ marginBottom: 6 }}><span className="badge outline">{TYPE_LABEL[c.type] ?? c.type}</span><DecisionBadge j={j} />{stageOf(c).busy ? <span className="progress"><i />{stageOf(c).label}</span> : <span className="tiny muted">{stageOf(c).label}</span>}</div>
          <h1>{c.title}</h1>
          {j && <div className="row"><ScoreBar total={j.total} /><span className="small muted">{j.total}/10 · {j.model}</span></div>}
        </div>
        <div className="toolbar">
          <button disabled={busy !== null} onClick={async () => { setBusy("judge"); try { await rejudge({ candidateId: cid }); } finally { setBusy(null); } }}>
            {busy === "judge" ? "판단 중…" : "다시 판단"}
          </button>
        </div>
      </div>

      <div className="grid2">
        <section>
          <h2>판단</h2>
          {j ? (
            <div className="card">
              <div className="row wrap small muted" style={{ marginBottom: 8 }}>
                {([["runnable", "실행 가능"], ["numbers", "숫자"], ["lesson", "배움"], ["novelty", "새로움"], ["audience", "청중"]] as const).map(([k, l]) => (
                  <span key={k} className={`badge ${j.scores[k] === 2 ? "ok" : j.scores[k] === 0 ? "" : "warn"}`}>{l} {j.scores[k]}</span>
                ))}
              </div>
              <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{j.reasoning}</p>
              <div className="small muted">채널 제안: {j.suggestedChannels.map((ch) => CHANNEL_LABEL[ch] ?? ch).join(", ") || "없음"} · {j.model} · {fmtDate(j.createdAt)}</div>
              <div className="toolbar" style={{ marginTop: 10 }}>
                {(j.overriddenDecision ?? j.decision) !== "draft" && (
                  <button className="primary" onClick={async () => { await override({ id: cid, decision: "draft", reason: "other", note: "수동으로 초안 요청" }); setBusy("draft"); try { await redraft({ candidateId: cid, channels: settings?.enabledChannels ?? [] }); } finally { setBusy(null); } }}>
                    그래도 초안 쓰기
                  </button>
                )}
                <OverrideDrop cid={cid} />
              </div>
            </div>
          ) : (
            <div className="card muted">아직 판단하지 않았습니다.</div>
          )}

          <h2>근거</h2>
          <pre className="evidence">{[
            `${e.repo} — ${e.repoUrl}`,
            e.description && `설명: ${e.description}`,
            e.version && `버전: ${e.version} (릴리스 ${e.releaseCount ?? "?"}회, 첫 릴리스 ${e.firstReleaseAt ?? "?"})`,
            e.stars !== undefined && `스타 ${e.stars} · 포크 ${e.forks ?? 0} · 커밋 ${e.commitCount ?? "?"}`,
            e.language && `${e.language} · ${e.license ?? "라이선스 미상"}`,
            e.homepage && `홈: ${e.homepage}`,
            e.npmPackage && `npm ${e.npmPackage}: 월 ${e.npmMonthlyDownloads ?? "?"} 다운로드`,
            `데모: ${e.demoAsset ?? "README에 없음"}`,
            e.limitations?.length ? `한계:\n- ${e.limitations.join("\n- ")}` : "한계: README에 명시 없음",
            e.mergedPrTitles?.length ? `머지된 PR:\n- ${e.mergedPrTitles.join("\n- ")}` : null,
            e.ompSummary && `에이전트 세션:\n${e.ompSummary}`,
            e.releaseNotes && `릴리스 노트:\n${e.releaseNotes}`,
          ].filter(Boolean).join("\n\n")}</pre>
          {publications.length > 0 && (
            <>
              <h2>발행됨</h2>
              <div className="list">
                {publications.map((p) => (
                  <div key={p.id} className="card small row between">
                    <span>{CHANNEL_LABEL[p.channel]} · {fmtDate(p.publishedAt)}</span>
                    <a href={p.url} target="_blank" rel="noreferrer">{p.url}</a>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        <section>
          <h2>초안</h2>
          <div className="tabs">
            {channels.map((ch) => (
              <button key={ch} className={tab === ch ? "active" : ""} onClick={() => setTab(ch)}>
                {CHANNEL_LABEL[ch] ?? ch}{draftsByChannel.has(ch) ? "" : " ·"}
              </button>
            ))}
          </div>
          {tab && (
            <DraftPanel
              cid={cid}
              channel={tab}
              drafts={draftsByChannel.get(tab) ?? []}
              busy={busy === `draft:${tab}` || busy === "draft"}
              onRedraft={async () => { setBusy(`draft:${tab}`); try { await redraft({ candidateId: cid, channels: [tab] }); } finally { setBusy(null); } }}
            />
          )}
        </section>
      </div>
    </>
  );
}

function OverrideDrop({ cid }: { cid: number }) {
  const override = (args: { id: number; decision: "draft" | "drop"; reason: string; note?: string }) => post(`/candidates/${args.id}/override`, { decision: args.decision, reason: args.reason, note: args.note });
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<(typeof REASONS)[number][0]>("not_worth");
  const [note, setNote] = useState("");
  if (!open) return <button className="danger" onClick={() => setOpen(true)}>글감 아님</button>;
  return (
    <div className="row" style={{ flexWrap: "wrap" }}>
      <select value={reason} onChange={(ev) => setReason(ev.target.value as never)} style={{ width: "auto" }}>
        {REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      <input placeholder="이유 (선택)" value={note} onChange={(ev) => setNote(ev.target.value)} style={{ width: 220 }} />
      <button className="danger" onClick={async () => { await override({ id: cid, decision: "drop", reason, note: note || undefined }); setOpen(false); }}>버리기</button>
      <button onClick={() => setOpen(false)}>취소</button>
    </div>
  );
}

function DraftPanel({ cid, channel, drafts, busy, onRedraft }: { cid: number; channel: Channel; drafts: Draft[]; busy: boolean; onRedraft: () => Promise<void> }) {
  const latest = [...drafts].sort((a, b) => b.version - a.version).find((d) => d.status !== "dropped") ?? null;
  const saveEdit = (args: { id: number; title?: string; body: string; markCopied: boolean }) => post(`/drafts/${args.id}/edit`, { title: args.title, body: args.body, markCopied: args.markCopied });
  const drop = (args: { id: number; reason: string }) => post(`/drafts/${args.id}/drop`, { reason: args.reason });
  const register = (args: { candidateId: number; draftId: number; channel: Channel; url: string }) => post("/publications", args);
  const [title, setTitle] = useState(latest?.title ?? "");
  const [body, setBody] = useState(latest?.body ?? "");
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [dropReason, setDropReason] = useState<(typeof REASONS)[number][0]>("voice");
  const [view, setView] = useState<"preview" | "text">("preview");
  const [toast, setToast] = useState<string | null>(null);
  const auth = useAuth();
  const author = auth.user?.displayName ?? auth.user?.username ?? "you";
  const spec = CHANNELS[channel];
  const original = latest ? [...drafts].filter((d) => d.channel === channel && d.version === latest.version)[0] : null;
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(null), 1800); };

  useEffect(() => {
    setTitle(latest?.title ?? "");
    setBody(latest?.body ?? "");
    setEditing(false);
    setCopied(false);
  }, [latest?.id, latest?.title, latest?.body]);

  const copyText = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    showToast("복사했습니다. 채널 화면에 붙여 넣으세요.");
  };
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (editing || !latest || (ev.target as HTMLElement)?.tagName === "INPUT" || (ev.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (ev.key === "c" && !ev.metaKey && !ev.ctrlKey) { void copyText(spec.hasTitle ? `${title}\n\n${body}` : body); }
      if (ev.key === "e") setEditing(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!latest) {
    return (
      <div className="card">
        <p className="muted">이 채널 초안이 없습니다.</p>
        <button className="primary" disabled={busy} onClick={() => void onRedraft()}>{busy ? "쓰는 중…" : "초안 쓰기"}</button>
      </div>
    );
  }
  const full = spec.hasTitle ? `${title}\n\n${body}` : body;
  return (
    <div className="card">
      <div className="row between small muted">
        <span>v{latest.version} · {latest.status} · {latest.model}</span>
        <span>{spec.mediaHint}</span>
      </div>
      <div className="lint"><LintBadges lint={latest.lint} /></div>
      {!editing && <div className="row between" style={{ marginBottom: 8 }}><div className="seg"><button className={view === "preview" ? "active" : ""} onClick={() => setView("preview")}>미리보기</button><button className={view === "text" ? "active" : ""} onClick={() => setView("text")}>텍스트</button></div><span className="tiny muted"><span className="kbd">c</span> 복사 · <span className="kbd">e</span> 수정</span></div>}
      {editing ? (
        <>
          {spec.hasTitle && <input value={title} onChange={(ev) => setTitle(ev.target.value)} style={{ marginBottom: 8 }} />}
          <textarea value={body} onChange={(ev) => setBody(ev.target.value)} />
          {original && original.body !== body && <><div className="tiny muted" style={{ margin: "8px 0 4px" }}>바뀐 부분 — 저장하면 이 문장이 다음 초안의 문체 예시가 됩니다</div><WordDiff before={original.body} after={body} /></>}
        </>
      ) : view === "preview" ? (
        <ChannelPreview channel={channel} title={title} body={body} author={author} />
      ) : (
        <>{spec.hasTitle && <div style={{ fontWeight: 600, marginBottom: 8 }}>{title}</div>}<div className="draft-body">{body}</div></>
      )}
      {toast && <div className="toast">{toast}</div>}
      <div className="small muted" style={{ marginTop: 6 }}>{[...body].length}{spec.maxChars ? `/${spec.maxChars}` : ""}자</div>
      <div className="toolbar" style={{ marginTop: 10 }}>
        {!editing ? (
          <>
            <button className="primary" onClick={async () => { await copyText(full); await saveEdit({ id: latest.id, title: latest.title, body: latest.body, markCopied: true }); }}>{copied ? "복사됨" : "복사"}</button>
            <button onClick={() => setEditing(true)}>수정</button>
            <button disabled={busy} onClick={() => void onRedraft()}>{busy ? "쓰는 중…" : "다시 쓰기"}</button>
            <select value={dropReason} onChange={(ev) => setDropReason(ev.target.value as never)} style={{ width: "auto" }}>
              {REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <button className="danger" onClick={() => void drop({ id: latest.id, reason: dropReason })}>버리기</button>
          </>
        ) : (
          <>
            <button className="primary" onClick={async () => { await saveEdit({ id: latest.id, title: spec.hasTitle ? title : undefined, body, markCopied: true }); await copyText(full); setEditing(false); }}>수정 후 복사</button>
            <button onClick={async () => { await saveEdit({ id: latest.id, title: spec.hasTitle ? title : undefined, body, markCopied: false }); setEditing(false); }}>저장만</button>
            <button onClick={() => { setTitle(latest.title ?? ""); setBody(latest.body); setEditing(false); }}>취소</button>
          </>
        )}
        {spec.composeUrl && <a href={spec.composeUrl} target="_blank" rel="noreferrer"><button>{spec.label} 열기</button></a>}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <input placeholder="올렸으면 URL을 붙여 넣으세요" value={url} onChange={(ev) => setUrl(ev.target.value)} />
        <button disabled={!/^https?:\/\//.test(url)} onClick={async () => { await register({ candidateId: cid, draftId: latest.id, channel, url }); setUrl(""); }}>올렸어요</button>
      </div>
    </div>
  );
}
