import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { CandidateListItem, SettingsView, Source } from "@shared/types";
import { Section, Skeleton, StageChip, TYPE_LABEL, Toast, relTime, stageOf, useToast } from "../components/ui";
import { post, useResource } from "../lib/api";
import { Onboarding } from "../components/Onboarding";

/**
 * 트리아지. 위에서부터 "지금 할 것" 순서: 검수할 초안 → 판단 대기·처리 중 → 보류.
 * 키보드: j/k 이동, Enter 열기, l 보류.
 */
export default function Inbox() {
  const nav = useNavigate();
  const { data: rows } = useResource<CandidateListItem[]>("/candidates", ["candidates", "drafts"]);
  const { data: sources } = useResource<Source[]>("/sources", ["sources"]);
  const { data: settings } = useResource<SettingsView>("/settings", ["settings"]);
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState(0);
  const [toast, showToast] = useToast();
  const github = (sources ?? []).filter((s) => s.kind === "github");

  const groups = useMemo(() => {
    const open = (rows ?? []).filter((c) => !["dropped", "published"].includes(c.status));
    const by = (k: string[]) => open.filter((c) => k.includes(stageOf(c).key)).sort((a, b) => (b.judgment?.total ?? -1) - (a.judgment?.total ?? -1) || b.updatedAt - a.updatedAt);
    return { review: by(["review"]), fresh: by(["fresh"]), working: by(["working", "ask"]), deferred: by(["deferred"]) };
  }, [rows]);
  const flat = [...groups.review, ...groups.fresh, ...groups.working, ...groups.deferred];

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
            onClick={async () => { setBusy(true); try { await post("/collect"); showToast(settings?.watch.mode === "auto" ? "확인했습니다. 새 글감은 판단이 끝나면 나타납니다." : "확인했습니다. 새 글감은 \"새 글감\"에 쌓입니다."); } finally { setBusy(false); } }}>
            {busy ? "확인 중…" : "지금 확인"}
          </button>
        </div>
      </div>

      <Onboarding rows={rows} />
      {rows === undefined ? <Skeleton rows={5} /> : (
        <>
          <Section title="검수할 초안" count={groups.review.length} hint="초안이 준비된 글감. 열어서 복사하거나 고쳐서 올리세요.">
            {groups.review.length ? <Rows items={groups.review} flat={flat} focus={focus} onFocus={setFocus} /> : <div className="empty small">지금은 없습니다. 처리 중인 후보의 판단이 끝나면 여기 쌓입니다.</div>}
          </Section>
          {groups.fresh.length > 0 && (
            <Section title="새 글감" count={groups.fresh.length} hint={settings?.watch.mode === "auto" ? "자동 모드: 곧 판단이 시작됩니다. 오래된 것은 직접 판단을 눌러야 합니다." : "아직 판단하지 않았습니다. 볼 만한 것만 골라 판단하세요. 모델 호출은 이때 일어납니다."}>
              <div className="row between small" style={{ padding: "8px 14px", borderBottom: "1px solid var(--line)" }}>
                <span className="muted">{groups.fresh.length}개 중 어떤 걸 만들어볼까요?</span>
                <button className="sm" disabled={busy} onClick={async () => { setBusy(true); try { await post("/candidates/judge", { ids: groups.fresh.slice(0, 50).map((c) => c.id) }); showToast("판단을 시작했습니다. 끝나면 검수할 초안에 나타납니다."); } finally { setBusy(false); } }}>모두 판단 ({Math.min(50, groups.fresh.length)})</button>
              </div>
              <Rows items={groups.fresh} flat={flat} focus={focus} onFocus={setFocus} onJudge={async (id) => { try { await post("/candidates/judge", { ids: [id] }); showToast("판단을 시작했습니다."); } catch (e) { showToast(`시작 실패: ${(e as Error).message}`); } }} />
            </Section>
          )}
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

function Rows({ items, flat, focus, onFocus, onJudge }: { items: CandidateListItem[]; flat: CandidateListItem[]; focus: number; onFocus: (i: number) => void; onJudge?: (id: number) => Promise<void> }) {
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
              {onJudge && st.key === "fresh" && <button className="sm primary" onClick={(e) => { e.stopPropagation(); void onJudge(c.id); }}>판단</button>}
              <Link to={`/c/${c.id}`} className="btn sm" onClick={(e) => e.stopPropagation()}>{st.key === "review" ? "검수" : "열기"}</Link>
            </div>
          </div>
        );
      })}
    </div>
  );
}

