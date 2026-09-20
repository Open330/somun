import { useState } from "react";
import { ALL_CHANNELS, CHANNELS, type Channel } from "@core/channels";
import type { Example } from "@shared/types";
import { CHANNEL_LABEL, Skeleton, Toast, relTime, useToast } from "../components/ui";
import { del, post, useResource } from "../lib/api";

/** 문체 예시. 초안이 따라 쓰는 문장들. 시드는 사용자 예시가 쌓이면 물러난다. */
export default function Voice() {
  const { data: examples } = useResource<Example[]>("/examples", ["examples"]);
  const [ch, setCh] = useState<Channel | "all">("all");
  const [openId, setOpenId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ channel: Channel; title: string; body: string }>({ channel: "x_en", title: "", body: "" });
  const [toast, showToast] = useToast();
  if (!examples) return <Skeleton rows={4} />;
  const list = examples.filter((e) => ch === "all" || e.channel === ch);
  const own = examples.filter((e) => e.source !== "seed" && e.active).length;
  const seed = examples.filter((e) => e.source === "seed" && e.active).length;

  return (
    <>
      <div className="page-head">
        <div><h1>문체</h1><p className="lede">초안이 따라 쓰는 문장. 내 예시 {own}개 · 참고 예시 {seed}개. "복사"와 "수정 후 복사"가 내 예시를 만들고, 채널당 5개가 쌓이면 참고 예시는 물러납니다.</p></div>
        <div className="toolbar"><button className="primary" onClick={() => setAdding((a) => !a)}>{adding ? "닫기" : "예시 직접 추가"}</button></div>
      </div>
      {adding && (
        <div className="card stack" style={{ marginBottom: 16 }}>
          <div className="row"><select value={draft.channel} onChange={(ev) => setDraft({ ...draft, channel: ev.target.value as Channel })}>{ALL_CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}</select>{CHANNELS[draft.channel].hasTitle && <input placeholder="제목" value={draft.title} onChange={(ev) => setDraft({ ...draft, title: ev.target.value })} />}</div>
          <textarea placeholder="내가 실제로 올렸거나 올리고 싶은 문장" value={draft.body} onChange={(ev) => setDraft({ ...draft, body: ev.target.value })} style={{ minHeight: 110 }} />
          <div><button className="primary" disabled={!draft.body.trim()} onClick={async () => { await post("/examples", { channel: draft.channel, lang: CHANNELS[draft.channel].lang, title: draft.title || undefined, body: draft.body }); setDraft({ ...draft, body: "", title: "" }); setAdding(false); showToast("추가했습니다"); }}>추가</button></div>
        </div>
      )}
      <div className="chtabs">
        <button className={ch === "all" ? "active" : ""} onClick={() => setCh("all")}>전체<span className="st">{examples.length}</span></button>
        {ALL_CHANNELS.map((c) => <button key={c} className={ch === c ? "active" : ""} onClick={() => setCh(c)}>{CHANNEL_LABEL[c]}<span className="st">{examples.filter((e) => e.channel === c).length || ""}</span></button>)}
      </div>
      {list.length === 0 ? <div className="empty small">이 채널의 예시가 없습니다.</div> : (
        <div className="rows">
          {list.map((e) => (
            <div key={e.id} className="rowi" style={{ gridTemplateColumns: "minmax(0,1fr) auto", cursor: "default" }}>
              <div style={{ minWidth: 0 }}>
                <div className="row wrap" style={{ gap: 6, marginBottom: 2 }}><span className="badge outline">{CHANNEL_LABEL[e.channel]}</span><span className={`badge ${e.source === "seed" ? "" : "ok"}`}>{e.source === "seed" ? "참고" : e.source === "edited" ? "내가 고침" : "내가 승인"}</span>{!e.active && <span className="badge bad">비활성</span>}<span className="tiny muted">{relTime(e.createdAt)}{e.note ? ` · ${e.note}` : ""}</span></div>
                <div className={openId === e.id ? "draft-body" : "r"} style={openId === e.id ? { marginTop: 6 } : {}} onClick={() => setOpenId(openId === e.id ? null : e.id)}>{e.title ? `${e.title} — ` : ""}{e.body}</div>
              </div>
              <div className="toolbar"><button className="ghost sm" onClick={() => void post(`/examples/${e.id}/active`, { active: !e.active })}>{e.active ? "끄기" : "켜기"}</button><button className="ghost sm danger" onClick={() => void del(`/examples/${e.id}`)}>삭제</button></div>
            </div>
          ))}
        </div>
      )}
      <Toast msg={toast} />
    </>
  );
}
