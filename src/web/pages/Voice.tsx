import { useState } from "react";
import { ALL_CHANNELS, CHANNELS, LANGS, langName, type Channel } from "@core/channels";
import { SAMPLE_WORK, VOICE_PRESETS } from "@core/voice";
import type { Example, GuideSuggestion, SettingsView } from "@shared/types";
import { CHANNEL_LABEL, Skeleton, Toast, relTime, useToast } from "../components/ui";
import { del, patch, post, useResource } from "../lib/api";

/**
 * 문체. 위: 프리셋과 내 지침(초안 프롬프트에 들어가는 것). 아래: 예시 문장(선택, 켰을 때만 프롬프트에 붙는다).
 * 문체를 예시에서 유추하게 두면 어느 문장 때문에 그렇게 나왔는지 알 수 없다. 지침이 먼저고 예시는 보조다.
 */
const CAT_LABEL: Record<string, string> = { voice: "말투", structure: "구성", facts: "사실", format: "형식" };

export default function Voice() {
  const { data: examples } = useResource<Example[]>("/examples", ["examples"]);
  const { data: settings } = useResource<SettingsView>("/settings", ["settings"]);
  const { data: suggestions } = useResource<GuideSuggestion[]>("/suggestions", ["settings"]);
  const [guide, setGuide] = useState<string | null>(null);
  const [sampleLang, setSampleLang] = useState<"ko" | "en">("ko");
  const [openSample, setOpenSample] = useState<string | null>(null);
  const [ch, setCh] = useState<Channel | "all">("all");
  const [openId, setOpenId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ channel: Channel; lang: string; title: string; body: string }>({ channel: "x", lang: "en", title: "", body: "" });
  const [toast, showToast] = useToast();
  if (!examples) return <Skeleton rows={4} />;
  const list = examples.filter((e) => ch === "all" || e.channel === ch);
  const own = examples.filter((e) => e.source !== "seed" && e.active).length;
  const seed = examples.filter((e) => e.source === "seed" && e.active).length;
  const voice = settings?.voice;
  const saveVoice = async (next: Partial<NonNullable<typeof voice>>) => {
    if (!voice) return;
    await patch("/settings", { voice: { ...voice, ...next, chosenAt: voice.chosenAt ?? Date.now() } });
    showToast("문체를 저장했습니다. 다음 초안부터 적용됩니다.");
  };

  return (
    <>
      <div className="page-head">
        <div><h1>문체</h1><p className="lede">초안이 어떤 말투로 쓰일지 정합니다. 프리셋 하나를 고르고, 필요하면 내 지침을 덧붙입니다. 예시 문장은 선택입니다.</p></div>
      </div>

      {voice && (
        <div className="card stack" style={{ gap: 14, marginBottom: 20 }}>
          <div>
            <div className="row between" style={{ marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
              <h3 style={{ margin: 0 }}>프리셋</h3>
              <div className="row" style={{ gap: 8 }}><span className="tiny muted">샘플 언어</span><div className="lang-seg">{(["ko", "en"] as const).map((l) => <button key={l} className={sampleLang === l ? "on" : ""} onClick={() => setSampleLang(l)}>{l.toUpperCase()}</button>)}</div></div>
            </div>
            <div className="sample-work">
              <b>같은 작업물, 다른 문체</b>
              <span className="muted">{SAMPLE_WORK.name}: {SAMPLE_WORK.what}</span>
              <div className="facts">{SAMPLE_WORK.facts.map((f) => <span key={f} className="badge">{f}</span>)}</div>
            </div>
            <div className="presets">
              {VOICE_PRESETS.map((p) => (
                <div key={p.id} className={`preset ${voice.preset === p.id ? "on" : ""}`}>
                  <button className="preset-pick" onClick={() => void saveVoice({ preset: p.id })}><b>{p.name}</b><span>{p.description}</span></button>
                  <div className="preset-sample">{p.sample[sampleLang]}</div>
                  <button className="ghost sm" onClick={() => setOpenSample(openSample === p.id ? null : p.id)}>{openSample === p.id ? "지침 닫기" : "지침 보기"}</button>
                  {openSample === p.id && <div className="sample">{sampleLang === "ko" ? p.ko : p.en}</div>}
                </div>
              ))}
            </div>
          </div>
          <div>
            <h3 style={{ marginBottom: 4 }}>내 지침 <span className="tiny muted">선택 · 프리셋보다 우선</span></h3>
            <p className="small muted" style={{ margin: "0 0 8px" }}>글마다 반복해서 고치던 것을 여기 적어 두세요. 예: "링크는 항상 마지막 줄에", "회사 이름은 쓰지 않기", "영어 글에서는 I 대신 we".</p>
            <textarea value={guide ?? voice.guide} onChange={(ev) => setGuide(ev.target.value)} placeholder="비워 두면 프리셋 지침만 씁니다." style={{ minHeight: 90 }} />
            <div className="row between" style={{ marginTop: 8 }}>
              <label className="row small" style={{ gap: 6, flex: 1, whiteSpace: "nowrap" }}><input type="checkbox" checked={voice.useExamples} onChange={(ev) => void saveVoice({ useExamples: ev.target.checked })} /> 아래 예시 문장도 프롬프트에 참고로 붙이기</label>
              <button className="primary" disabled={guide === null || guide === voice.guide} onClick={async () => { await saveVoice({ guide: guide ?? "" }); setGuide(null); }}>지침 저장</button>
            </div>
          </div>
        </div>
      )}

      {suggestions && suggestions.length > 0 && (
        <div className="card stack" style={{ gap: 10, marginBottom: 20, borderColor: "var(--accent)" }}>
          <div>
            <h3 style={{ margin: 0 }}>지침 제안 <span className="tiny muted">수정과 버림에서 배운 것 · 승인하면 내 지침에 붙습니다</span></h3>
          </div>
          <div className="stack" style={{ gap: 6 }}>
            {suggestions.map((g) => (
              <div key={g.id} className="sugg">
                <div style={{ minWidth: 0 }}>
                  <div className="small" style={{ fontWeight: 600 }}>{g.rule}</div>
                  <div className="tiny muted">{CAT_LABEL[g.category] ?? g.category} · {g.count}번 관찰 · 마지막 {relTime(g.updatedAt)}</div>
                </div>
                <span className="toolbar">
                  <button className="sm primary" onClick={async () => { await post(`/suggestions/${g.id}/accept`); showToast("지침에 추가했습니다."); }}>지침에 추가</button>
                  <button className="ghost sm" onClick={() => void post(`/suggestions/${g.id}/dismiss`)}>무시</button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="page-head" style={{ marginTop: 8 }}>
        <div><h2 style={{ margin: 0, textTransform: "none", letterSpacing: 0, fontSize: 16, color: "var(--ink)" }}>예시 문장 <span className="tiny muted">{voice?.useExamples ? "프롬프트에 참고로 들어감" : "지금은 프롬프트에 들어가지 않음"}</span></h2><p className="lede small">내 예시 {own}개 · 참고 예시 {seed}개. "복사"와 "수정 후 복사"가 내 예시를 만들고, 채널당 5개가 쌓이면 참고 예시는 물러납니다.</p></div>
        <div className="toolbar"><button onClick={() => setAdding((a) => !a)}>{adding ? "닫기" : "예시 직접 추가"}</button></div>
      </div>
      {adding && (
        <div className="card stack" style={{ marginBottom: 16 }}>
          <div className="row"><select value={draft.channel} onChange={(ev) => { const c = ev.target.value as Channel; setDraft({ ...draft, channel: c, lang: CHANNELS[c].fixedLang ?? draft.lang }); }}>{ALL_CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}</select><select value={draft.lang} disabled={Boolean(CHANNELS[draft.channel].fixedLang)} onChange={(ev) => setDraft({ ...draft, lang: ev.target.value })}>{Object.keys(LANGS).map((l) => <option key={l} value={l}>{langName(l)}</option>)}</select>{CHANNELS[draft.channel].hasTitle && <input placeholder="제목" value={draft.title} onChange={(ev) => setDraft({ ...draft, title: ev.target.value })} />}</div>
          <textarea placeholder="내가 실제로 올렸거나 올리고 싶은 문장" value={draft.body} onChange={(ev) => setDraft({ ...draft, body: ev.target.value })} style={{ minHeight: 110 }} />
          <div><button className="primary" disabled={!draft.body.trim()} onClick={async () => { await post("/examples", { channel: draft.channel, lang: draft.lang, title: draft.title || undefined, body: draft.body }); setDraft({ ...draft, body: "", title: "" }); setAdding(false); showToast("추가했습니다"); }}>추가</button></div>
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
                <div className="row wrap" style={{ gap: 6, marginBottom: 2 }}><span className="badge outline">{CHANNEL_LABEL[e.channel]} · {e.lang.toUpperCase()}</span><span className={`badge ${e.source === "seed" ? "" : "ok"}`}>{e.source === "seed" ? "참고" : e.source === "edited" ? "내가 고침" : "내가 승인"}</span>{!e.active && <span className="badge bad">비활성</span>}<span className="tiny muted">{relTime(e.createdAt)}{e.note ? ` · ${e.note}` : ""}</span></div>
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
