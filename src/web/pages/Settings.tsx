import { useEffect, useState } from "react";
import { ALL_CHANNELS, CHANNELS, LANGS, langName, type Channel } from "@core/channels";
import type { KeyStatus, SettingsView } from "@shared/types";
import { CHANNEL_LABEL, CRITERIA, Skeleton, Toast, fmtDate, useToast } from "../components/ui";
import { patch, useResource } from "../lib/api";

type Tab = "judge" | "channels" | "model";

export default function Settings() {
  const { data: settings } = useResource<SettingsView>("/settings", ["settings"]);
  const { data: keyStatus } = useResource<KeyStatus[]>("/keys", ["keys"]);
  const update = (p: Record<string, unknown>) => patch("/settings", p);
  const [tab, setTab] = useState<Tab>("judge");
  const [toast, showToast] = useToast();
  const [banned, setBanned] = useState("");
  const [thresholds, setThresholds] = useState({ draft: 6, defer: 4 });
  const [llm, setLlm] = useState<{ provider: "gemini" | "anthropic" | "openai" | "local-agent"; model: string; draftModel: string; apiKey: string; baseUrl: string; agentCli: "claude" | "codex" }>({ provider: "gemini", model: "", draftModel: "", apiKey: "", baseUrl: "", agentCli: "claude" });
  useEffect(() => {
    if (!settings) return;
    setBanned(settings.bannedPhrases.join("\n"));
    setThresholds({ draft: settings.draftThreshold, defer: settings.deferThreshold });
    setLlm({ provider: settings.llm.provider, model: settings.llm.model ?? "", draftModel: settings.llm.draftModel ?? "", apiKey: "", baseUrl: settings.llm.baseUrl ?? "", agentCli: settings.llm.agentCli ?? "claude" });
  }, [settings]);
  if (!settings) return <Skeleton rows={4} />;

  const setLangs = (ch: Channel, langs: string[]) => void update({ channelLangs: { ...settings.channelLangs, [ch]: langs } });

  return (
    <>
      <div className="page-head"><div><h1>설정</h1><p className="lede">판단 기준, 채널, 모델. 소스 연결은 <a href="/connectors">연결</a>, 문체 예시는 <a href="/voice">문체</a>에 있습니다.</p></div></div>
      <div className="settabs">
        {([["judge", "판단"], ["channels", "채널"], ["model", "모델 · 키"]] as const).map(([k, l]) => <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{l}</button>)}
      </div>

      {tab === "judge" && (
        <div className="card stack" style={{ gap: 14, maxWidth: 720 }}>
          <div>
            <h3>새 글감 처리</h3>
            <p className="small muted">수동은 글감을 모아만 두고 사용자가 고른 것만 판단합니다. 자동은 최근 N일 안에 생긴 글감을 매시간 판단하고 임계를 넘으면 초안까지 씁니다. 자동은 모델 호출이 많습니다.</p>
            <div className="row" style={{ gap: 14, flexWrap: "wrap", alignItems: "center" }}>
              <label className="row small" style={{ gap: 6 }}><input type="radio" name="watch" checked={settings.watch.mode === "manual"} onChange={() => void update({ watch: { ...settings.watch, mode: "manual" } })} /> 수동: 내가 고른 것만</label>
              <label className="row small" style={{ gap: 6 }}><input type="radio" name="watch" checked={settings.watch.mode === "auto"} onChange={() => void update({ watch: { ...settings.watch, mode: "auto" } })} /> 자동</label>
              <label className="row small" style={{ gap: 6 }}>최근 <input type="number" min={1} max={365} style={{ width: 64 }} value={settings.watch.recentDays} onChange={(ev) => void update({ watch: { ...settings.watch, recentDays: Math.max(1, Math.min(365, Number(ev.target.value) || 30)) } })} /> 일 안에 생긴 글감만</label>
            </div>
          </div>
          <div>
            <h3>임계</h3>
            <p className="small muted">다섯 항목(각 0~2, 가중치 적용) 합이 초안 임계 이상이면 채널별 초안을 씁니다. 보류 임계 미만이면 묻기만 합니다.</p>
            <div className="row">
              <label className="field"><span>초안 임계</span><input type="number" value={thresholds.draft} onChange={(ev) => setThresholds({ ...thresholds, draft: Number(ev.target.value) })} /></label>
              <label className="field"><span>보류 임계</span><input type="number" value={thresholds.defer} onChange={(ev) => setThresholds({ ...thresholds, defer: Number(ev.target.value) })} /></label>
            </div>
          </div>
          <div>
            <h3>가중치</h3>
            <div className="stack">
              {CRITERIA.map(([k, label, hint]) => (
                <label key={k} className="row between small"><span><b>{label}</b> <span className="muted">{hint}</span></span><input type="number" step="0.5" min="0" style={{ width: 72 }} value={settings.rubricWeights[k]} onChange={(ev) => void update({ rubricWeights: { ...settings.rubricWeights, [k]: Number(ev.target.value) } })} /></label>
              ))}
            </div>
          </div>
          <div>
            <h3>금지 표현</h3>
            <p className="small muted">초안에 이 표현이 있으면 린트에 걸립니다. 한 줄에 하나.</p>
            <textarea value={banned} onChange={(ev) => setBanned(ev.target.value)} style={{ minHeight: 120 }} />
          </div>
          <div><button className="primary" onClick={async () => { await update({ draftThreshold: thresholds.draft, deferThreshold: thresholds.defer, bannedPhrases: banned.split("\n").map((s) => s.trim()).filter(Boolean) }); showToast("저장했습니다"); }}>저장</button></div>
        </div>
      )}

      {tab === "channels" && (
        <div className="card stack" style={{ maxWidth: 760 }}>
          <p className="small muted">채널마다 초안을 만들 언어를 고릅니다. 언어가 하나도 없으면 그 채널은 꺼진 것입니다. Show HN·Show GN처럼 언어가 정해진 채널은 켜기만 합니다. 목록에 없는 언어는 코드로 추가할 수 있습니다(예: ja, zh, es).</p>
          {ALL_CHANNELS.map((ch) => <ChannelLangRow key={ch} ch={ch} langs={settings.channelLangs[ch] ?? []} onChange={(l) => setLangs(ch, l)} />)}
        </div>
      )}

      {tab === "model" && (
        <div className="stack" style={{ gap: 16, maxWidth: 760 }}>
          <div className="card stack" style={{ gap: 12 }}>
            <p className="small muted">분석(다이제스트·판단)은 가벼운 모델, 초안 생성만 상위 모델을 씁니다. 무료 쿼터가 모델별로 다르기 때문입니다. 기본은 서버의 Gemini 키 풀입니다. 내 키를 쓰려면 프로바이더를 고르고 키를 넣으세요. Claude Code·Codex 구독으로 돌리려면 "로컬 에이전트"를 고르고 내 컴퓨터에서 워커를 실행합니다.{settings.llm.apiKeySet && <> 현재 저장된 키: …{settings.llm.apiKeyHint}</>}</p>
            <div className="tabs">
              {([["gemini", "Gemini"], ["anthropic", "Anthropic"], ["openai", "OpenAI 호환"], ["local-agent", "로컬 에이전트"]] as const).map(([k, l]) => <button key={k} className={llm.provider === k ? "active" : ""} onClick={() => setLlm({ ...llm, provider: k })}>{l}</button>)}
            </div>
            {llm.provider === "local-agent" ? (
              <>
                <label className="field"><span>CLI</span><select value={llm.agentCli} onChange={(ev) => setLlm({ ...llm, agentCli: ev.target.value as "claude" | "codex" })}><option value="claude">claude (Claude Code)</option><option value="codex">codex (Codex CLI)</option></select></label>
                <pre className="evidence">{`# 내 컴퓨터에서 (본인 구독으로 처리, 키 불필요)\nSOMUN_URL=${window.location.origin} SOMUN_TOKEN=<토큰> npm run agent-worker -- --cli ${llm.agentCli}`}</pre>
              </>
            ) : (
              <div className="row wrap">
                <label className="field" style={{ flex: 1 }}><span>분석 모델 (다이제스트·판단)</span><input placeholder={llm.provider === "gemini" ? "gemini-3.5-flash-lite" : llm.provider === "anthropic" ? "claude-opus-5" : "gpt-5"} value={llm.model} onChange={(ev) => setLlm({ ...llm, model: ev.target.value })} /></label>
                <label className="field" style={{ flex: 1 }}><span>초안 모델 (글 생성만)</span><input placeholder={llm.provider === "gemini" ? "gemini-3.7-flash" : "위와 같음"} value={llm.draftModel} onChange={(ev) => setLlm({ ...llm, draftModel: ev.target.value })} /></label>
                <label className="field" style={{ flex: 1 }}><span>API 키 {llm.provider === "gemini" ? "(비우면 서버 키)" : "(필수)"}</span><input type="password" placeholder={settings.llm.apiKeySet ? "저장됨 — 바꾸려면 입력" : ""} value={llm.apiKey} onChange={(ev) => setLlm({ ...llm, apiKey: ev.target.value })} /></label>
                {llm.provider === "openai" && <label className="field" style={{ flex: 1 }}><span>Base URL (선택)</span><input placeholder="https://api.openai.com/v1" value={llm.baseUrl} onChange={(ev) => setLlm({ ...llm, baseUrl: ev.target.value })} /></label>}
              </div>
            )}
            <div className="toolbar">
              <button className="primary" onClick={async () => { await update({ llm: { provider: llm.provider, model: llm.model || undefined, draftModel: llm.draftModel || undefined, apiKey: llm.apiKey || undefined, baseUrl: llm.baseUrl || undefined, agentCli: llm.agentCli }, keepApiKey: !llm.apiKey }); showToast("저장했습니다"); }}>저장</button>
              {settings.llm.apiKeySet && <button className="danger" onClick={() => void update({ llm: { provider: llm.provider, model: llm.model || undefined, draftModel: llm.draftModel || undefined, agentCli: llm.agentCli }, keepApiKey: false })}>저장된 키 삭제</button>}
            </div>
          </div>
          {llm.provider === "gemini" && (keyStatus?.length ?? 0) > 0 && (
            <div className="card small">
              <h3>서버 키 풀</h3>
              <p className="muted">무료 키를 가장 오래 안 쓴 것부터 돌립니다. 키별 오늘 상한 {keyStatus?.[0]?.cap} 요청(태평양 자정 초기화).</p>
              <div className="stack">{keyStatus?.map((k) => <div key={k.label} className="row between"><span><span className="badge outline">{k.label}</span> 오늘 {k.todayCount}/{k.cap}</span>{k.cooldownUntil && k.cooldownUntil > Date.now() ? <span className="badge warn" title={k.lastQuotaId}>{k.cooldownReason} · {fmtDate(k.cooldownUntil)}까지</span> : <span className="badge ok">사용 가능</span>}</div>)}</div>
            </div>
          )}
        </div>
      )}
      <Toast msg={toast} />
    </>
  );
}

function ChannelLangRow({ ch, langs, onChange }: { ch: Channel; langs: string[]; onChange: (l: string[]) => void }) {
  const spec = CHANNELS[ch];
  const [custom, setCustom] = useState("");
  const on = langs.length > 0;
  const common = Object.keys(LANGS);
  return (
    <div className="row between wrap" style={{ padding: "10px 0", borderTop: "1px solid var(--line)", alignItems: "flex-start" }}>
      <div style={{ minWidth: 200 }}>
        <label className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: "auto" }} checked={on} onChange={() => onChange(on ? [] : spec.defaultLangs)} /><b>{CHANNEL_LABEL[ch]}</b></label>
        <div className="tiny muted" style={{ maxWidth: 360 }}>{spec.maxChars ? `${spec.maxChars}자` : "길이 제한 없음"}{spec.fixedLang ? ` · ${langName(spec.fixedLang)} 고정` : ""}</div>
      </div>
      {spec.fixedLang ? (
        <span className="badge outline">{langName(spec.fixedLang)}</span>
      ) : (
        <div className="row wrap" style={{ gap: 6, maxWidth: 420, justifyContent: "flex-end" }}>
          {common.map((code) => <button key={code} className={`sm ${langs.includes(code) ? "active" : "ghost"}`} onClick={() => onChange(langs.includes(code) ? langs.filter((l) => l !== code) : [...langs, code])}>{LANGS[code].nativeName}</button>)}
          {langs.filter((l) => !common.includes(l)).map((code) => <button key={code} className="sm active" onClick={() => onChange(langs.filter((l) => l !== code))}>{code} ×</button>)}
          <input placeholder="코드 추가" value={custom} style={{ width: 88 }} onChange={(ev) => setCustom(ev.target.value)} onKeyDown={(ev) => { if (ev.key === "Enter" && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(custom.trim())) { onChange([...new Set([...langs, custom.trim()])]); setCustom(""); } }} />
        </div>
      )}
    </div>
  );
}
