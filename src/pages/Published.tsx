import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { CHANNEL_LABEL, Spark, fmtDate } from "../components/ui";

export default function Published() {
  const rows = useQuery(api.publications.listWithMetrics);
  return (
    <>
      <h1>Published</h1>
      {rows === undefined ? (
        <div className="empty">불러오는 중…</div>
      ) : rows.length === 0 ? (
        <div className="empty">아직 발행한 것이 없습니다. 초안을 복사해 올린 뒤 URL을 등록하면 여기서 추이를 봅니다.</div>
      ) : (
        <div className="list">
          {rows.map((p) => (
            <div key={p._id} className="card">
              <div className="row between">
                <div>
                  <span className="badge">{CHANNEL_LABEL[p.channel] ?? p.channel}</span>{" "}
                  <Link to={`/c/${p.candidateId}`}><strong>{p.candidateTitle}</strong></Link>
                  <div className="small muted" style={{ marginTop: 4 }}>
                    {fmtDate(p.publishedAt)} · <a href={p.url} target="_blank" rel="noreferrer">{p.url}</a>
                  </div>
                </div>
                <div className="row">
                  <div className="small muted" style={{ textAlign: "right" }}>
                    <div>스타 {p.baselineStars ?? "?"} → {p.latestStars ?? "?"}</div>
                    <div>{p.series.at(-1)?.uniques !== undefined ? `방문자(14d) ${p.series.at(-1)?.uniques}` : ""}</div>
                  </div>
                  <Spark values={p.series.map((s) => s.stars)} />
                </div>
              </div>
              <ManualStats id={p._id} stats={p.manualStats} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function ManualStats({ id, stats }: { id: Id<"publications">; stats?: { likes?: number; comments?: number; reposts?: number } }) {
  const set = useMutation(api.publications.setManualStats);
  const [v, setV] = useState({ likes: stats?.likes ?? 0, comments: stats?.comments ?? 0, reposts: stats?.reposts ?? 0 });
  return (
    <div className="row small" style={{ marginTop: 10 }}>
      {(["likes", "comments", "reposts"] as const).map((k) => (
        <label key={k} className="row" style={{ gap: 4 }}>
          <span className="muted">{k}</span>
          <input type="number" value={v[k]} style={{ width: 80 }} onChange={(ev) => setV({ ...v, [k]: Number(ev.target.value) })} />
        </label>
      ))}
      <button onClick={() => void set({ id, ...v })}>반응 저장</button>
    </div>
  );
}
