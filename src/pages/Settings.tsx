import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ALL_CHANNELS, CHANNELS, type Channel } from "../../convex/lib/channels";
import { CHANNEL_LABEL, fmtDate } from "../components/ui";

export default function Settings() {
  const settings = useQuery(api.settings.get);
  const update = useMutation(api.settings.update);
  const sources = useQuery(api.sources.list);
  const upsertSource = useMutation(api.sources.upsert);
  const removeSource = useMutation(api.sources.remove);
  const examples = useQuery(api.examples.list, {});
  const keyStatus = useQuery(api.keys.status);
  const setActive = useMutation(api.examples.setActive);
  const removeExample = useMutation(api.examples.remove);
  const addExample = useMutation(api.examples.add);

  const [targets, setTargets] = useState("");
  const [banned, setBanned] = useState("");
  const [model, setModel] = useState("");
  const [thresholds, setThresholds] = useState({ draft: 6, defer: 4 });
  const [llm, setLlm] = useState<{ provider: "gemini" | "anthropic" | "openai" | "local-agent"; model: string; apiKey: string; baseUrl: string; agentCli: "claude" | "codex"; draftModel: string }>({ provider: "gemini", model: "", draftModel: "", apiKey: "", baseUrl: "", agentCli: "claude" });
  const [ex, setEx] = useState<{ channel: Channel; body: string; title: string }>({ channel: "x_en", body: "", title: "" });
  const [exChannel, setExChannel] = useState<Channel | "all">("all");

  useEffect(() => {
    if (!settings) return;
    setBanned(settings.bannedPhrases.join("\n"));
    setModel(settings.model);
    setThresholds({ draft: settings.draftThreshold, defer: settings.deferThreshold });
    setLlm({ provider: settings.llm.provider, model: settings.llm.model ?? "", draftModel: settings.llm.draftModel ?? "", apiKey: "", baseUrl: settings.llm.baseUrl ?? "", agentCli: settings.llm.agentCli ?? "claude" });
  }, [settings]);

  if (!settings) return <div className="empty">불러오는 중…</div>;

  const toggleChannel = (ch: Channel) => {
    const next = settings.enabledChannels.includes(ch) ? settings.enabledChannels.filter((c) => c !== ch) : [...settings.enabledChannels, ch];
    void update({ enabledChannels: next });
  };

  return (
    <>
      <h1>Settings</h1>

      <h2>소스</h2>
      <div className="card">
        <p className="small muted">GitHub 조직/사용자 이름 또는 owner/repo. 쉼표로 구분. Convex 환경변수 GITHUB_TOKEN이 필요합니다.</p>
        <div className="row">
          <input placeholder="Open330, jiunbae/oh-my-prompt" value={targets} onChange={(ev) => setTargets(ev.target.value)} />
          <button
            className="primary"
            disabled={!targets.trim()}
            onClick={async () => {
              await upsertSource({ kind: "github", targets: targets.split(",").map((t) => t.trim()).filter(Boolean), enabled: true });
              setTargets("");
            }}
          >
            추가
          </button>
        </div>
        <div className="list" style={{ marginTop: 10 }}>
          {(sources ?? []).map((s) => (
            <div key={s._id} className="row between small">
              <span>
                <span className="badge">{s.kind}</span> {s.config.targets.join(", ")}
                {s.lastPolledAt && <span className="muted"> · 마지막 확인 {fmtDate(s.lastPolledAt)}</span>}
                {s.lastError && <span className="badge bad" title={s.lastError}>오류</span>}
              </span>
              <span className="toolbar">
                <button onClick={() => void upsertSource({ id: s._id, kind: s.kind, targets: s.config.targets, options: s.config.options, enabled: !s.enabled })}>{s.enabled ? "끄기" : "켜기"}</button>
                <button className="danger" onClick={() => void removeSource({ id: s._id })}>삭제</button>
              </span>
            </div>
          ))}
        </div>
      </div>

      <h2>채널</h2>
      <div className="card toolbar">
        {ALL_CHANNELS.map((ch) => (
          <button key={ch} className={settings.enabledChannels.includes(ch) ? "active" : ""} onClick={() => toggleChannel(ch)} title={CHANNELS[ch].rules}>
            {CHANNEL_LABEL[ch]}
          </button>
        ))}
      </div>

      <h2>판단</h2>
      <div className="card">
        <div className="row">
          <label className="field"><span>초안 임계 (합계)</span><input type="number" value={thresholds.draft} onChange={(ev) => setThresholds({ ...thresholds, draft: Number(ev.target.value) })} /></label>
          <label className="field"><span>보류 임계</span><input type="number" value={thresholds.defer} onChange={(ev) => setThresholds({ ...thresholds, defer: Number(ev.target.value) })} /></label>
        </div>
        <div className="row small muted" style={{ marginBottom: 8 }}>
          가중치:
          {(["runnable", "numbers", "lesson", "novelty", "audience"] as const).map((k) => (
            <label key={k} className="row" style={{ gap: 4 }}>
              <span>{k}</span>
              <input type="number" step="0.5" style={{ width: 64 }} value={settings.rubricWeights[k]} onChange={(ev) => void update({ rubricWeights: { ...settings.rubricWeights, [k]: Number(ev.target.value) } })} />
            </label>
          ))}
        </div>
        <label className="field"><span>금지 표현 (줄바꿈으로 구분)</span><textarea value={banned} onChange={(ev) => setBanned(ev.target.value)} style={{ minHeight: 100 }} /></label>
        <button className="primary" onClick={() => void update({ draftThreshold: thresholds.draft, deferThreshold: thresholds.defer, model, bannedPhrases: banned.split("\n").map((s) => s.trim()).filter(Boolean) })}>저장</button>
      </div>

      <h2>모델 · 키</h2>
      <div className="card">
        <p className="small muted">
          기본은 서버의 Gemini 키 풀(3.5 Flash-Lite)입니다. 내 키를 쓰려면 프로바이더를 고르고 키를 넣으세요. Claude Code·Codex 구독으로 돌리려면 "로컬 에이전트"를 고르고 내 컴퓨터에서 워커를 실행합니다.
          {settings.llm.apiKeySet && <> 현재 저장된 키: …{settings.llm.apiKeyHint}</>}
        </p>
        <div className="tabs">
          {([["gemini", "Gemini (서버 키 또는 내 키)"], ["anthropic", "Anthropic (내 키)"], ["openai", "OpenAI 호환 (내 키)"], ["local-agent", "로컬 에이전트 (Claude Code / Codex)"]] as const).map(([k, l]) => (
            <button key={k} className={llm.provider === k ? "active" : ""} onClick={() => setLlm({ ...llm, provider: k })}>{l}</button>
          ))}
        </div>
        {llm.provider === "local-agent" ? (
          <>
            <div className="row">
              <label className="field"><span>CLI</span>
                <select value={llm.agentCli} onChange={(ev) => setLlm({ ...llm, agentCli: ev.target.value as "claude" | "codex" })}><option value="claude">claude (Claude Code)</option><option value="codex">codex (Codex CLI)</option></select>
              </label>
            </div>
            <pre className="evidence">{`# 내 컴퓨터에서 (본인 구독으로 처리, 키 불필요)
CONVEX_URL=${import.meta.env.VITE_CONVEX_URL} node scripts/agent-worker.mjs --cli ${llm.agentCli}`}</pre>
          </>
        ) : (
          <div className="row">
            <label className="field"><span>다이제스트 모델 (비우면 기본값)</span><input placeholder={llm.provider === "gemini" ? "gemini-3.5-flash-lite" : llm.provider === "anthropic" ? "claude-opus-5" : "gpt-5"} value={llm.model} onChange={(ev) => setLlm({ ...llm, model: ev.target.value })} /></label>
            <label className="field"><span>판단·초안 모델 (비우면 {llm.provider === "gemini" ? "gemini-3.7-flash" : "위와 같음"})</span><input value={llm.draftModel} onChange={(ev) => setLlm({ ...llm, draftModel: ev.target.value })} /></label>
            <label className="field"><span>API 키 {llm.provider === "gemini" ? "(비우면 서버 키)" : "(필수)"}</span><input type="password" placeholder={settings.llm.apiKeySet ? "저장됨 — 바꾸려면 입력" : ""} value={llm.apiKey} onChange={(ev) => setLlm({ ...llm, apiKey: ev.target.value })} /></label>
            {llm.provider === "openai" && <label className="field"><span>Base URL (선택, OpenRouter·Ollama 등)</span><input placeholder="https://api.openai.com/v1" value={llm.baseUrl} onChange={(ev) => setLlm({ ...llm, baseUrl: ev.target.value })} /></label>}
          </div>
        )}
        <div className="toolbar">
          <button className="primary" onClick={() => void update({ llm: { provider: llm.provider, model: llm.model || undefined, draftModel: llm.draftModel || undefined, apiKey: llm.apiKey || undefined, baseUrl: llm.baseUrl || undefined, agentCli: llm.agentCli }, keepApiKey: !llm.apiKey })}>저장</button>
          {settings.llm.apiKeySet && <button className="danger" onClick={() => void update({ llm: { provider: llm.provider, model: llm.model || undefined, draftModel: llm.draftModel || undefined, agentCli: llm.agentCli }, keepApiKey: false })}>저장된 키 삭제</button>}
        </div>
      </div>

      {llm.provider === "gemini" && (keyStatus?.length ?? 0) > 0 && (
        <>
          <h2>서버 키 풀</h2>
          <div className="card small">
            <p className="muted">무료 키 6개를 가장 오래 안 쓴 것부터 돌립니다. 키별 오늘 상한 {keyStatus?.[0]?.cap} RPD(태평양 자정 초기화). 429는 분 단위면 잠깐, 일 단위면 자정까지 제외됩니다.</p>
            <div className="list">
              {keyStatus?.map((k) => (
                <div key={k.label} className="row between">
                  <span><span className="badge">{k.label}</span> 오늘 {k.todayCount}/{k.cap}{k.lastUsedAt ? ` · 마지막 ${fmtDate(k.lastUsedAt)}` : ""}</span>
                  <span>{k.cooldownUntil && k.cooldownUntil > Date.now() ? <span className="badge warn" title={k.lastQuotaId}>{k.cooldownReason} · {fmtDate(k.cooldownUntil)}까지</span> : <span className="badge ok">사용 가능</span>}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      <h2>문체 예시</h2>
      <div className="card">
        <p className="small muted">채널별 few-shot. 시드(best practice)는 사용자 예시가 5개 쌓이면 자동으로 비활성화됩니다. "수정 후 복사"와 "복사"가 예시를 만듭니다.</p>
        <div className="tabs">
          <button className={exChannel === "all" ? "active" : ""} onClick={() => setExChannel("all")}>전체</button>
          {ALL_CHANNELS.map((ch) => <button key={ch} className={exChannel === ch ? "active" : ""} onClick={() => setExChannel(ch)}>{CHANNEL_LABEL[ch]}</button>)}
        </div>
        <div className="list">
          {(examples ?? []).filter((e) => exChannel === "all" || e.channel === exChannel).map((e) => (
            <div key={e._id} className="row between small" style={{ alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <span className="badge">{CHANNEL_LABEL[e.channel]}</span> <span className={`badge ${e.source === "seed" ? "" : "ok"}`}>{e.source}</span> {!e.active && <span className="badge bad">비활성</span>}
                <div className="draft-body" style={{ marginTop: 6, maxHeight: 120, overflow: "auto" }}>{e.title ? `${e.title}\n\n` : ""}{e.body}</div>
              </div>
              <span className="toolbar">
                <button onClick={() => void setActive({ id: e._id as Id<"examples">, active: !e.active })}>{e.active ? "끄기" : "켜기"}</button>
                <button className="danger" onClick={() => void removeExample({ id: e._id as Id<"examples"> })}>삭제</button>
              </span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 14 }}>
          <div className="row">
            <select value={ex.channel} onChange={(ev) => setEx({ ...ex, channel: ev.target.value as Channel })} style={{ width: "auto" }}>
              {ALL_CHANNELS.map((ch) => <option key={ch} value={ch}>{CHANNEL_LABEL[ch]}</option>)}
            </select>
            {CHANNELS[ex.channel].hasTitle && <input placeholder="제목" value={ex.title} onChange={(ev) => setEx({ ...ex, title: ev.target.value })} />}
          </div>
          <textarea placeholder="예시 본문" value={ex.body} onChange={(ev) => setEx({ ...ex, body: ev.target.value })} style={{ marginTop: 8, minHeight: 100 }} />
          <button style={{ marginTop: 8 }} disabled={!ex.body.trim()} onClick={async () => { await addExample({ channel: ex.channel, lang: CHANNELS[ex.channel].lang, title: ex.title || undefined, body: ex.body }); setEx({ ...ex, body: "", title: "" }); }}>예시 추가</button>
        </div>
      </div>
    </>
  );
}
