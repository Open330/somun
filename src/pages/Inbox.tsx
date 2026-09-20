import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { DecisionBadge, TYPE_LABEL, fmtDate } from "../components/ui";

export default function Inbox() {
  const rows = useQuery(api.candidates.inbox);
  const sources = useQuery(api.sources.list);
  const runMine = useAction(api.collect.runMine);
  const setStatus = useMutation(api.candidates.setStatus);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"open" | "all">("open");

  const visible = (rows ?? []).filter((c) => (filter === "all" ? true : !["dropped", "published"].includes(c.status)));

  return (
    <>
      <div className="row between">
        <h1>Inbox</h1>
        <div className="toolbar">
          <button className={filter === "open" ? "active" : ""} onClick={() => setFilter("open")}>열린 것</button>
          <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>전부</button>
          <button
            className="primary"
            disabled={busy || !sources?.length}
            title={!sources?.length ? "Settings에서 소스를 먼저 연결하세요" : ""}
            onClick={async () => {
              setBusy(true);
              try {
                await runMine();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "확인 중…" : "지금 확인"}
          </button>
        </div>
      </div>
      {rows === undefined ? (
        <div className="empty">불러오는 중…</div>
      ) : visible.length === 0 ? (
        <div className="empty">{sources?.length ? "아직 후보가 없습니다. 매일 09:00에 확인하거나 '지금 확인'을 누르세요." : "Settings에서 GitHub 소스를 연결하면 시작합니다."}</div>
      ) : (
        <div className="list">
          {visible.map((c) => (
            <div key={c._id} className="card row between">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row">
                  <span className="badge">{TYPE_LABEL[c.type] ?? c.type}</span>
                  <Link to={`/c/${c._id}`}><strong>{c.title}</strong></Link>
                  <DecisionBadge j={c.judgment} />
                  <span className="badge">{c.status}</span>
                </div>
                <div className="small muted" style={{ marginTop: 6 }}>
                  {c.judgment ? c.judgment.reasoning.split("\n")[0] : "판단 대기 중"} · {fmtDate(c.updatedAt)}
                </div>
              </div>
              <div className="score">{c.judgment ? c.judgment.total : "–"}</div>
              <div className="toolbar">
                <Link to={`/c/${c._id}`}><button>열기</button></Link>
                {c.status !== "dropped" && <button onClick={() => void setStatus({ id: c._id, status: "deferred" })}>나중에</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
