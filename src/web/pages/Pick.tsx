import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { InstallationRepo, SettingsView } from "@shared/types";
import { Skeleton, Toast, relTime, useToast } from "../components/ui";
import { api, patch, post, useResource } from "../lib/api";
import { t } from "../i18n";
import { tr } from "../i18n/rich";

const DAY = 86400e3;
type Recent = 7 | 30 | 90 | 0;

/**
 * 연결 직후 "무엇을 만들어볼까요?". 설치가 볼 수 있는 저장소를 보여주고 지켜볼 것을 고른다.
 * 여기서 고른 것만 수집하고, 자동 모드를 켜지 않으면 글감은 쌓이기만 하고 판단은 사용자가 시킨다.
 */
export default function Pick() {
  const nav = useNavigate();
  const instId = Number(new URLSearchParams(window.location.search).get("installation_id") ?? 0);
  const [repos, setRepos] = useState<InstallationRepo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { data: settings } = useResource<SettingsView>("/settings", ["settings"]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [recent, setRecent] = useState<Recent>(30);
  const [minStars, setMinStars] = useState(0);
  const [hideForks, setHideForks] = useState(true);
  const [hideArchived, setHideArchived] = useState(true);
  const [q, setQ] = useState("");
  const [auto, setAuto] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, showToast] = useToast();

  useEffect(() => {
    if (!instId) { setErr(t("installation_id가 없습니다.")); return; }
    api<InstallationRepo[]>(`/github/installations/${instId}/repos`).then((r) => { setRepos(r); setSel(new Set(r.filter((x) => x.watched).map((x) => x.fullName))); }).catch((e: Error) => setErr(e.message));
  }, [instId]);
  useEffect(() => { if (settings && auto === null) setAuto(settings.watch.mode === "auto"); }, [settings, auto]);

  const visible = useMemo(() => {
    if (!repos) return [];
    const since = recent ? Date.now() - recent * DAY : 0;
    const needle = q.trim().toLowerCase();
    return repos.filter((r) => (!since || (r.pushedAt ?? 0) >= since) && r.stars >= minStars && (!hideForks || !r.fork) && (!hideArchived || !r.archived) && (!needle || r.fullName.toLowerCase().includes(needle) || (r.description ?? "").toLowerCase().includes(needle)));
  }, [repos, recent, minStars, hideForks, hideArchived, q]);

  const toggle = (name: string) => setSel((s) => { const n = new Set(s); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  const allVisible = visible.length > 0 && visible.every((r) => sel.has(r.fullName));

  async function save() {
    setBusy(true);
    try {
      if (settings && auto !== null && (settings.watch.mode === "auto") !== auto) await patch("/settings", { watch: { mode: auto ? "auto" : "manual", recentDays: settings.watch.recentDays } });
      const r = await post<{ count: number }>(`/github/installations/${instId}/watch`, { repos: [...sel] });
      showToast(t("{n}개를 지켜봅니다. 첫 확인을 시작했습니다.", { n: r.count }));
      setTimeout(() => nav("/", { replace: true }), 900);
    } catch (e) { showToast(`${t("저장 실패:")} ${(e as Error).message}`); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t("무엇을 만들어볼까요?")}</h1>
          <p className="lede">{tr("지켜볼 저장소를 고르세요. 고른 것만 읽고, 아래 방식대로 글감을 만듭니다. 나중에 {link}에서 바꿀 수 있습니다.", { link: <a href="/connectors">{t("연결")}</a> })}</p>
        </div>
        <div className="toolbar">
          <button className="primary" disabled={busy || sel.size === 0 || !repos} onClick={() => void save()}>{busy ? t("저장 중…") : t("{n}개 지켜보기", { n: sel.size })}</button>
        </div>
      </div>

      {err && <div className="empty">{err}</div>}
      {!repos && !err && <Skeleton rows={6} />}
      {repos && (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <b className="small">{t("글감 처리")}</b>
              <label className="row small" style={{ gap: 6 }}><input type="radio" name="mode" checked={auto === false} onChange={() => setAuto(false)} /> {t("모아두고 내가 고른 것만 판단")}</label>
              <label className="row small" style={{ gap: 6 }}><input type="radio" name="mode" checked={auto === true} onChange={() => setAuto(true)} /> {t("자동: 최근 {n}일 안에 생긴 글감은 바로 판단·초안", { n: settings?.watch.recentDays ?? 30 })}</label>
            </div>
            <p className="tiny muted" style={{ marginTop: 6 }}>{t("자동은 모델 호출이 많아집니다. 처음엔 수동으로 두고 어떤 글감이 오는지 본 뒤 켜는 편이 낫습니다.")}</p>
          </div>

          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
            <input placeholder={t("검색")} value={q} onChange={(ev) => setQ(ev.target.value)} style={{ width: 200 }} />
            <div className="tabs" style={{ margin: 0 }}>
              {([7, 30, 90, 0] as Recent[]).map((d) => <button key={d} className={`sm ${recent === d ? "active" : ""}`} onClick={() => setRecent(d)}>{d ? t("최근 {n}일 갱신", { n: d }) : t("전체")}</button>)}
            </div>
            <label className="row small" style={{ gap: 6 }}>{t("스타 ≥")} <input type="number" min={0} value={minStars} onChange={(ev) => setMinStars(Number(ev.target.value) || 0)} style={{ width: 64 }} /></label>
            <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={hideForks} onChange={(ev) => setHideForks(ev.target.checked)} /> {t("포크 제외")}</label>
            <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={hideArchived} onChange={(ev) => setHideArchived(ev.target.checked)} /> {t("아카이브 제외")}</label>
            <span className="tiny muted">{t("{shown}/{total}개 표시 · {selected}개 선택", { shown: visible.length, total: repos.length, selected: sel.size })}</span>
            <button className="ghost sm" onClick={() => setSel((s) => { const n = new Set(s); for (const r of visible) { if (allVisible) n.delete(r.fullName); else n.add(r.fullName); } return n; })}>{allVisible ? t("표시된 것 모두 해제") : t("표시된 것 모두 선택")}</button>
          </div>

          <div className="rows">
            {visible.length === 0 && <div className="empty small">{t("조건에 맞는 저장소가 없습니다. 기간을 넓히거나 필터를 풀어보세요.")}</div>}
            {visible.map((r) => (
              <label key={r.fullName} className="pick-row">
                <input type="checkbox" checked={sel.has(r.fullName)} onChange={() => toggle(r.fullName)} />
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
                    <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.fullName}</b>
                    {r.isPrivate && <span className="badge outline">{t("비공개")}</span>}
                    {r.fork && <span className="badge outline">{t("포크")}</span>}
                    {r.archived && <span className="badge outline">{t("아카이브")}</span>}
                  </div>
                  {r.description && <div className="small muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.description}</div>}
                </div>
                <div className="tiny muted" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <div>★ {r.stars}{r.language ? ` · ${r.language}` : ""}</div>
                  <div>{r.pushedAt ? t("갱신 {when}", { when: relTime(r.pushedAt) }) : t("갱신 기록 없음")}</div>
                </div>
              </label>
            ))}
          </div>
        </>
      )}
      <Toast msg={toast} />
    </>
  );
}
