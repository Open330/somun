import { useState } from "react";
import { Link } from "react-router-dom";
import type { CandidateListItem, Source } from "@shared/types";
import { DecisionBadge, ScoreBar, TYPE_LABEL, fmtDate, stageOf } from "../components/ui";
import { post, useResource } from "../lib/api";

const TYPES = ["release", "new-repo", "milestone", "in-progress", "blog"] as const;

export default function Inbox() {
  const { data: rows } = useResource<CandidateListItem[]>("/candidates", ["candidates"]);
  const { data: sources } = useResource<Source[]>("/sources", ["sources"]);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [type, setType] = useState<string | null>(null);
  const visible = (rows ?? []).filter((c) => (filter === "all" ? true : !["dropped", "published"].includes(c.status))).filter((c) => !type || c.type === type);
  const github = (sources ?? []).filter((s) => s.kind === "github");
  const running = (rows ?? []).filter((c) => stageOf(c).busy).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Inbox</h1>
          <p className="lede">{rows ? `열린 후보 ${(rows ?? []).filter((c) => !["dropped", "published"].includes(c.status)).length}개` : "불러오는 중"}{running ? ` · ${running}개 처리 중` : ""}{github[0]?.lastPolledAt ? ` · 마지막 확인 ${fmtDate(github[0].lastPolledAt)}` : ""}</p>
        </div>
        <div className="toolbar">
          <button className={filter === "open" ? "active" : ""} onClick={() => setFilter("open")}>열린 것</button>
          <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>전부</button>
          <button className="primary" disabled={busy || !github.length} title={!github.length ? "Connectors에서 GitHub를 먼저 연결하세요" : ""}
            onClick={async () => { setBusy(true); try { await post("/collect"); } finally { setBusy(false); } }}>
            {busy ? "확인 중…" : "지금 확인"}
          </button>
        </div>
      </div>

      {!github.length && <Onboarding hasSources={false} hasCandidates={Boolean(rows?.length)} />}

      {rows && rows.length > 0 && (
        <div className="tabs">
          <button className={`sm ${type === null ? "active" : ""}`} onClick={() => setType(null)}>모든 유형</button>
          {TYPES.map((t) => <button key={t} className={`sm ${type === t ? "active" : ""}`} onClick={() => setType(t)}>{TYPE_LABEL[t]}</button>)}
        </div>
      )}

      {rows === undefined ? (
        <div className="empty">불러오는 중…</div>
      ) : visible.length === 0 ? (
        github.length ? <div className="empty">아직 후보가 없습니다. 매일 09:00에 확인하거나 "지금 확인"을 누르세요.</div> : null
      ) : (
        <div className="list">
          {visible.map((c) => {
            const st = stageOf(c);
            return (
              <div key={c.id} className="card cand">
                <div style={{ minWidth: 0 }}>
                  <div className="meta">
                    <span className="badge outline">{TYPE_LABEL[c.type] ?? c.type}</span>
                    <DecisionBadge j={c.judgment} />
                    {st.busy ? <span className="progress"><i />{st.label}</span> : <span className="tiny muted">{st.label}</span>}
                  </div>
                  <Link to={`/c/${c.id}`} className="title">{c.title}</Link>
                  <div className="reason">{c.judgment ? c.judgment.reasoning.split("\n")[0] : (c.evidence.highlights?.[0] ?? "판단 대기 중")}</div>
                </div>
                <div className="stack" style={{ alignItems: "flex-end" }}>
                  <div className={`score ${c.judgment && c.judgment.total < 4 ? "low" : ""}`}>{c.judgment ? c.judgment.total : "–"}</div>
                  {c.judgment && <ScoreBar total={c.judgment.total} />}
                </div>
                <div className="toolbar">
                  <Link to={`/c/${c.id}`} className="btn">열기</Link>
                  {c.status !== "dropped" && c.status !== "deferred" && <button className="ghost sm" onClick={() => void post(`/candidates/${c.id}/status`, { status: "deferred" })}>나중에</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function Onboarding({ hasSources, hasCandidates }: { hasSources: boolean; hasCandidates: boolean }) {
  return (
    <div className="steps" style={{ marginBottom: 24 }}>
      <div className={`step ${hasSources ? "done" : ""}`}><div className="n">1 · 연결</div><h3>GitHub를 연결합니다</h3><p className="small muted">조직이나 저장소를 지정하면 릴리스, PR, 커밋, 스타를 읽습니다.</p><Link to="/connectors" className="btn primary sm">Connectors 열기</Link></div>
      <div className={`step ${hasCandidates ? "done" : ""}`}><div className="n">2 · 첫 스캔</div><h3>최근 14일을 훑습니다</h3><p className="small muted">글감 후보를 묶고, 다이제스트와 판단이 자동으로 이어집니다.</p></div>
      <div className="step"><div className="n">3 · 검수</div><h3>초안을 고쳐 올립니다</h3><p className="small muted">복사하거나 고쳐서 올리고 URL을 등록하면, 다음 초안이 그 문체를 따릅니다.</p></div>
    </div>
  );
}
