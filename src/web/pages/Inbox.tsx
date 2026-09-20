import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { CandidateListItem, Source } from "@shared/types";
import { Section, Skeleton, StageChip, TYPE_LABEL, Toast, relTime, stageOf, useToast } from "../components/ui";
import { post, useResource } from "../lib/api";

/**
 * 트리아지. 위에서부터 "지금 할 것" 순서: 검수할 초안 → 판단 대기·처리 중 → 보류.
 * 키보드: j/k 이동, Enter 열기, l 보류.
 */
export default function Inbox() {
  const nav = useNavigate();
  const { data: rows } = useResource<CandidateListItem[]>("/candidates", ["candidates", "drafts"]);
  const { data: sources } = useResource<Source[]>("/sources", ["sources"]);
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState(0);
  const [toast, showToast] = useToast();
  const github = (sources ?? []).filter((s) => s.kind === "github");

  const groups = useMemo(() => {
    const open = (rows ?? []).filter((c) => !["dropped", "published"].includes(c.status));
    const by = (k: string[]) => open.filter((c) => k.includes(stageOf(c).key)).sort((a, b) => (b.judgment?.total ?? -1) - (a.judgment?.total ?? -1) || b.updatedAt - a.updatedAt);
    return { review: by(["review"]), working: by(["working", "ask"]), deferred: by(["deferred"]) };
  }, [rows]);
  const flat = [...groups.review, ...groups.working, ...groups.deferred];

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || ev.metaKey || ev.ctrlKey) return;
      if (ev.key === "j") setFocus((f) => Math.min(flat.length - 1, f + 1));
      if (ev.key === "k") setFocus((f) => Math.max(0, f - 1));
      if (ev.key === "Enter" && flat[focus]) nav(`/c/${flat[focus].id}`);
      if (ev.key === "l" && flat[focus] && flat[focus].status !== "deferred") { void post(`/candidates/${flat[focus].id}/status`, { status: "deferred" }); showToast("보류했습니다"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flat, focus, nav, showToast]);

  const lastPolled = github.map((s) => s.lastPolledAt ?? 0).sort().at(-1);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>글감</h1>
          <p className="lede">{groups.review.length ? `검수할 초안 ${groups.review.length}개` : "검수할 초안이 없습니다"}{groups.working.length ? ` · ${groups.working.length}개 처리 중` : ""}{lastPolled ? ` · 마지막 확인 ${relTime(lastPolled)}` : ""}</p>
        </div>
        <div className="toolbar">
          <span className="tiny muted"><span className="kbd">j</span><span className="kbd">k</span> 이동 · <span className="kbd">↵</span> 열기 · <span className="kbd">l</span> 보류</span>
          <button className="primary" disabled={busy || !github.length} title={!github.length ? "연결에서 GitHub를 먼저 연결하세요" : ""}
            onClick={async () => { setBusy(true); try { await post("/collect"); showToast("확인했습니다. 새 후보는 판단이 끝나면 나타납니다."); } finally { setBusy(false); } }}>
            {busy ? "확인 중…" : "지금 확인"}
          </button>
        </div>
      </div>

      {!github.length && <Onboarding hasCandidates={Boolean(rows?.length)} />}
      {rows === undefined ? <Skeleton rows={5} /> : (
        <>
          <Section title="검수할 초안" count={groups.review.length} hint="초안이 준비된 글감. 열어서 복사하거나 고쳐서 올리세요.">
            {groups.review.length ? <Rows items={groups.review} flat={flat} focus={focus} onFocus={setFocus} /> : <div className="empty small">지금은 없습니다. 처리 중인 후보의 판단이 끝나면 여기 쌓입니다.</div>}
          </Section>
          {groups.working.length > 0 && (
            <Section title="처리 중" count={groups.working.length} hint="다이제스트 → 판단 → 초안이 자동으로 이어집니다.">
              <Rows items={groups.working} flat={flat} focus={focus} onFocus={setFocus} />
            </Section>
          )}
          {groups.deferred.length > 0 && (
            <Section title="보류" count={groups.deferred.length} hint="점수가 낮거나 나중으로 미룬 것. 언제든 열어 초안을 요청할 수 있습니다.">
              <Rows items={groups.deferred} flat={flat} focus={focus} onFocus={setFocus} />
            </Section>
          )}
          {flat.length === 0 && github.length > 0 && <div className="empty">아직 후보가 없습니다. 매일 09:00에 확인하거나 "지금 확인"을 누르세요.</div>}
        </>
      )}
      <Toast msg={toast} />
    </>
  );
}

function Rows({ items, flat, focus, onFocus }: { items: CandidateListItem[]; flat: CandidateListItem[]; focus: number; onFocus: (i: number) => void }) {
  const nav = useNavigate();
  return (
    <div className="rows">
      {items.map((c) => {
        const idx = flat.indexOf(c);
        const st = stageOf(c);
        const reason = c.judgment ? c.judgment.reasoning.split("\n")[0] : c.evidence.highlights?.[0] ?? "";
        return (
          <div key={c.id} className={`rowi ${idx === focus ? "focus" : ""}`} onClick={() => nav(`/c/${c.id}`)} onMouseEnter={() => onFocus(idx)}>
            <span className="ty">{TYPE_LABEL[c.type] ?? c.type}</span>
            <div style={{ minWidth: 0 }}>
              <div className="t">{c.title}</div>
              <div className="r">{reason}</div>
            </div>
            <span className={`sc ${(c.judgment?.total ?? 0) < 4 ? "low" : ""}`}>{c.judgment ? c.judgment.total : ""}</span>
            <div className="row" style={{ gap: 8 }}>
              <StageChip stage={st} />
              <Link to={`/c/${c.id}`} className="btn sm" onClick={(e) => e.stopPropagation()}>{st.key === "review" ? "검수" : "열기"}</Link>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Onboarding({ hasCandidates }: { hasCandidates: boolean }) {
  return (
    <div className="steps" style={{ marginBottom: 24 }}>
      <div className="step"><div className="n">1 · 연결</div><h3>GitHub를 연결합니다</h3><p className="small muted">App을 설치하거나 조직·저장소를 지정하면 릴리스, PR, 커밋, 스타를 읽습니다.</p><Link to="/connectors" className="btn primary sm">연결 열기</Link></div>
      <div className={`step ${hasCandidates ? "done" : ""}`}><div className="n">2 · 첫 스캔</div><h3>최근 14일을 훑습니다</h3><p className="small muted">글감 후보를 묶고, 다이제스트와 판단이 자동으로 이어집니다.</p></div>
      <div className="step"><div className="n">3 · 검수</div><h3>초안을 고쳐 올립니다</h3><p className="small muted">복사하거나 고쳐서 올리고 URL을 등록하면, 다음 초안이 그 문체를 따릅니다.</p></div>
    </div>
  );
}
