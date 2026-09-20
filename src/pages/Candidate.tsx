import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { CHANNELS, type Channel } from "../../convex/lib/channels";
import { CHANNEL_LABEL, DecisionBadge, LintBadges, REASONS, TYPE_LABEL, fmtDate } from "../components/ui";

export default function Candidate() {
  const { id } = useParams<{ id: string }>();
  const cid = id as Id<"candidates">;
  const data = useQuery(api.candidates.get, { id: cid });
  const settings = useQuery(api.settings.get);
  const rejudge = useAction(api.llm.rejudge);
  const redraft = useAction(api.llm.redraft);
  const override = useMutation(api.candidates.override);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<Channel | null>(null);

  const draftsByChannel = useMemo(() => {
    const m = new Map<Channel, Doc<"drafts">[]>();
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
      <div className="row between">
        <h1>
          <span className="badge" style={{ marginRight: 8 }}>{TYPE_LABEL[c.type] ?? c.type}</span>
          {c.title}
        </h1>
        <div className="toolbar">
          <DecisionBadge j={j} />
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
              <div className="row between">
                <div className="row small muted">
                  {(["runnable", "numbers", "lesson", "novelty", "audience"] as const).map((k) => (
                    <span key={k} className="badge">{k} {j.scores[k]}</span>
                  ))}
                </div>
                <div className="score">{j.total}</div>
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
                  <div key={p._id} className="card small row between">
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

function OverrideDrop({ cid }: { cid: Id<"candidates"> }) {
  const override = useMutation(api.candidates.override);
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

function DraftPanel({ cid, channel, drafts, busy, onRedraft }: { cid: Id<"candidates">; channel: Channel; drafts: Doc<"drafts">[]; busy: boolean; onRedraft: () => Promise<void> }) {
  const latest = [...drafts].sort((a, b) => b.version - a.version).find((d) => d.status !== "dropped") ?? null;
  const saveEdit = useMutation(api.drafts.saveEdit);
  const drop = useMutation(api.drafts.drop);
  const register = useMutation(api.publications.register);
  const [title, setTitle] = useState(latest?.title ?? "");
  const [body, setBody] = useState(latest?.body ?? "");
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [dropReason, setDropReason] = useState<(typeof REASONS)[number][0]>("voice");
  const spec = CHANNELS[channel];

  useEffect(() => {
    setTitle(latest?.title ?? "");
    setBody(latest?.body ?? "");
    setEditing(false);
    setCopied(false);
  }, [latest?._id, latest?.title, latest?.body]);

  const copyText = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
  };

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
      {spec.hasTitle && (editing ? <input value={title} onChange={(ev) => setTitle(ev.target.value)} style={{ marginBottom: 8 }} /> : <div style={{ fontWeight: 600, marginBottom: 8 }}>{title}</div>)}
      {editing ? <textarea value={body} onChange={(ev) => setBody(ev.target.value)} /> : <div className="draft-body">{body}</div>}
      <div className="small muted" style={{ marginTop: 6 }}>{[...body].length}{spec.maxChars ? `/${spec.maxChars}` : ""}자</div>
      <div className="toolbar" style={{ marginTop: 10 }}>
        {!editing ? (
          <>
            <button className="primary" onClick={async () => { await copyText(full); await saveEdit({ id: latest._id, title: latest.title, body: latest.body, markCopied: true }); }}>{copied ? "복사됨" : "복사"}</button>
            <button onClick={() => setEditing(true)}>수정</button>
            <button disabled={busy} onClick={() => void onRedraft()}>{busy ? "쓰는 중…" : "다시 쓰기"}</button>
            <select value={dropReason} onChange={(ev) => setDropReason(ev.target.value as never)} style={{ width: "auto" }}>
              {REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <button className="danger" onClick={() => void drop({ id: latest._id, reason: dropReason })}>버리기</button>
          </>
        ) : (
          <>
            <button className="primary" onClick={async () => { await saveEdit({ id: latest._id, title: spec.hasTitle ? title : undefined, body, markCopied: true }); await copyText(full); setEditing(false); }}>수정 후 복사</button>
            <button onClick={async () => { await saveEdit({ id: latest._id, title: spec.hasTitle ? title : undefined, body, markCopied: false }); setEditing(false); }}>저장만</button>
            <button onClick={() => { setTitle(latest.title ?? ""); setBody(latest.body); setEditing(false); }}>취소</button>
          </>
        )}
        {spec.composeUrl && <a href={spec.composeUrl} target="_blank" rel="noreferrer"><button>{spec.label} 열기</button></a>}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <input placeholder="올렸으면 URL을 붙여 넣으세요" value={url} onChange={(ev) => setUrl(ev.target.value)} />
        <button disabled={!/^https?:\/\//.test(url)} onClick={async () => { await register({ candidateId: cid, draftId: latest._id, channel, url }); setUrl(""); }}>올렸어요</button>
      </div>
    </div>
  );
}
