import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { CandidateListItem, SettingsView, Source } from "@shared/types";
import { ErrorState, Section, Skeleton, StageChip, TYPE_LABEL, relTime, stageOf } from "../components/ui";
import { post, useResource } from "../lib/api";
import { GenerationStatus } from "../components/GenerationStatus";
import { Onboarding } from "../components/Onboarding";

type Filter = "all" | "review" | "fresh" | "attention" | "deferred" | "archived";
const FILTERS: [Filter, string][] = [["all", "전체"], ["review", "검토할 초안"], ["fresh", "새 글감"], ["attention", "확인 필요"], ["deferred", "보류"], ["archived", "보관"]];
const category = (c: CandidateListItem): Exclude<Filter, "all"> => {
  const key = stageOf(c).key;
  return key === "published" || key === "dropped" ? "archived" : key === "working" || key === "ask" ? "attention" : key;
};

export default function Inbox() {
  const { data: rows, error, reload } = useResource<CandidateListItem[]>("/candidates", ["candidates", "drafts"]);
  const { data: sources, error: sourceError, reload: reloadSources } = useResource<Source[]>("/sources", ["sources"]);
  const { data: settings } = useResource<SettingsView>("/settings", ["settings"]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [requested, setRequested] = useState<number[]>([]);
  const collectable = (sources ?? []).filter((s) => s.enabled && s.targets.length && ["github", "blog"].includes(s.kind));
  const latestPoll = Math.max(0, ...collectable.map((s) => s.lastPolledAt ?? 0));
  const counts = useMemo(() => {
    const result = { all: 0, review: 0, fresh: 0, attention: 0, deferred: 0, archived: 0 };
    for (const c of rows ?? []) { const key = category(c); result[key]++; if (key !== "archived") result.all++; }
    return result;
  }, [rows]);
  const visible = useMemo(() => (rows ?? []).filter((c) => (filter === "all" ? category(c) !== "archived" : category(c) === filter) && `${c.title} ${c.repo}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt), [rows, filter, query]);

  async function collect() {
    setBusy(true); setMessage(null);
    try {
      const result = await post<Record<string, Record<string, number> | { error: string }>>("/collect");
      const values = Object.values(result).flatMap((r) => Object.values(r));
      const failed = values.some((v) => typeof v === "string" || v < 0);
      const count = values.reduce<number>((n, value) => n + (typeof value === "number" && value > 0 ? value : 0), 0);
      setMessage({ text: failed ? "일부 소스를 확인하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요." : count ? `새 변경 ${count}건을 가져왔습니다. 아래에서 글감을 골라보세요.` : "확인을 마쳤습니다. 새로 가져올 변경은 없습니다.", error: failed });
      reload(); reloadSources();
    } catch (err) { setMessage({ text: `변경을 가져오지 못했습니다. ${(err as Error).message}`, error: true }); }
    finally { setBusy(false); }
  }
  async function judge(id: number) {
    setRequested((ids) => [...ids, id]); setMessage(null);
    try {
      await post("/candidates/judge", { ids: [id] });
      setMessage({ text: "초안 준비를 요청했습니다. 결과가 도착하면 목록이 갱신됩니다. 오래 기다리면 글감을 열어 상태를 확인해 주세요." });
      reload();
    } catch (err) { setMessage({ text: `요청하지 못했습니다. ${(err as Error).message}`, error: true }); }
    finally { setRequested((ids) => ids.filter((value) => value !== id)); }
  }

  if (error || sourceError) return <ErrorState title="글감을 불러오지 못했습니다" message={error ?? sourceError!} onRetry={() => { reload(); reloadSources(); }} />;
  if (!rows || !sources) return <Skeleton rows={4} />;
  const firstDraft = rows.find((c) => category(c) === "review");
  const firstUse = rows.length === 0;
  return (
    <>
      <header className="page-head workspace-head">
        <div><span className="eyebrow">내 작업 공간</span><h1>글감</h1><p className="lede">{firstUse ? "작은 변화도, 전할 이야기가 됩니다." : counts.review ? `검토할 초안 ${counts.review}개가 준비되어 있어요.` : counts.fresh ? `새 글감 ${counts.fresh}개 중 알리고 싶은 변화를 골라보세요.` : "모아둔 이야기를 살펴보고 다음 게시글을 준비하세요."}</p></div>
        {!firstUse && <div className="toolbar">{collectable.length > 0 && <button disabled={busy} onClick={() => void collect()}>{busy ? "변경 가져오는 중…" : "새 변경 가져오기"}</button>}{firstDraft && <Link className="btn primary" to={`/c/${firstDraft.id}`}>초안 검토하기 <span aria-hidden>→</span></Link>}</div>}
      </header>
      {message && <div className={`inline-notice ${message.error ? "is-error" : ""}`} role={message.error ? "alert" : "status"}><span>{message.text}</span>{message.error && <Link to="/connectors">연결 확인</Link>}<button className="ghost sm" aria-label="알림 닫기" onClick={() => setMessage(null)}>×</button></div>}
      <GenerationStatus candidateTitles={Object.fromEntries(rows.map((row) => [row.id, row.title]))} onChange={reload} />
      {firstUse ? <>
        <Onboarding rows={rows} sources={sources} />
        {collectable.length > 0 && <div className="next-action"><div><h2>연결 준비가 끝났어요</h2><p>최근 변경을 가져와 첫 글감을 찾아보세요.</p></div><button className="primary" disabled={busy} onClick={() => void collect()}>{busy ? "변경 가져오는 중…" : "첫 글감 가져오기 →"}</button></div>}
      </> : <>
        <div className="inbox-controls"><div className="filter-strip" role="group" aria-label="글감 상태 필터">{FILTERS.map(([key, label]) => <button key={key} aria-pressed={filter === key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>{label}<span>{counts[key]}</span></button>)}</div><label className="search-field"><span className="sr-only">글감 제목 또는 저장소 검색</span><input type="search" placeholder="제목 또는 저장소 검색" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
        <div className="list-meta"><span>{visible.length}개 글감</span><span>{settings?.watch.mode === "auto" ? "자동 준비 켜짐" : "선택한 글감만 초안 준비"}{latestPoll ? ` · 마지막 수집 ${relTime(latestPoll)}` : ""}</span></div>
        {visible.length === 0 ? <div className="state-panel"><span className="state-symbol" aria-hidden>⌕</span><h2>{query ? "검색 결과가 없어요" : "이 상태의 글감은 아직 없어요"}</h2><p>{query ? "다른 검색어를 입력하거나 필터를 초기화해 보세요." : "다른 글감을 살펴보거나 새 변경을 가져와 보세요."}</p><button onClick={() => { setQuery(""); setFilter("all"); }}>전체 글감 보기</button></div> : (
          (filter === "all" ? FILTERS.filter(([key]) => !["all", "archived"].includes(key)) : FILTERS.filter(([key]) => key === filter)).map(([key, label]) => {
            const items = visible.filter((c) => category(c) === key);
            if (!items.length) return null;
            return <Section key={key} title={label} count={items.length}><div className="story-list">{items.map((c) => <article className="story-row" key={c.id}>
              <div className="story-content"><div className="story-meta"><span>{c.repo}</span><span>·</span><span>{TYPE_LABEL[c.type] ?? c.type}</span><span>· {relTime(c.updatedAt)}</span></div><Link className="story-title" to={`/c/${c.id}`}>{c.title}</Link><p>{c.judgment?.reasoning.split("\n")[0] || c.evidence.highlights?.[0] || "이 변화에서 알릴 만한 내용을 찾아 초안으로 정리할 수 있어요."}</p></div>
              <div className="story-actions"><StageChip stage={stageOf(c)} />{c.judgment && <span className="story-score" title="설정한 판단 기준의 가중 합계">추천점수 {c.judgment.total}</span>}<div className="toolbar">{category(c) === "fresh" && <button className="sm" disabled={requested.includes(c.id)} onClick={() => void judge(c.id)}>{requested.includes(c.id) ? "요청 중…" : "초안 준비"}</button>}<Link className="btn sm" to={`/c/${c.id}`}>{category(c) === "review" ? "초안 검토" : "자세히 보기"}<span aria-hidden> →</span></Link></div></div>
            </article>)}</div></Section>;
          })
        )}
      </>}
    </>
  );
}
