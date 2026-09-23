import { useEffect, useState } from "react";
import type { RepoProfileView } from "@shared/types";
import { fmtDate } from "../../components/ui";
import { patch, post } from "../../lib/api";
import { t } from "../../i18n";

const STAGE_LABEL: Record<string, string> = { experiment: "실험", beta: "베타", stable: "안정", archived: "보관", unknown: "단계 미상" };

/** 프로젝트 프로필: 정체성의 기준선. 여기 적힌 것은 "변경"으로 다시 알리지 않는다. 사용자가 고치면 재생성해도 유지된다. */
export default function ProfileBlock({ repo, view, showToast }: { repo: string; view?: RepoProfileView; showToast: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const p = view?.profile;
  const [what, setWhat] = useState(p?.what ?? "");
  const [audience, setAudience] = useState(p?.audience ?? "");
  const [claims, setClaims] = useState((p?.claims ?? []).join("\n"));
  const [avoid, setAvoid] = useState((p?.avoid ?? []).join(", "));
  useEffect(() => { setWhat(p?.what ?? ""); setAudience(p?.audience ?? ""); setClaims((p?.claims ?? []).join("\n")); setAvoid((p?.avoid ?? []).join(", ")); }, [p?.what, p?.audience, p?.claims, p?.avoid]);
  const regen = async () => { setBusy(true); try { const r = await post<{ queued: boolean; busy?: boolean }>(`/profiles/${repo}/regenerate`); showToast(r?.busy ? t("로컬 워커가 이 저장소의 프로필을 만들고 있습니다. 끝난 뒤 다시 요청해 주세요.") : r?.queued ? t("로컬 워커에 프로필 만들기를 요청했습니다. 글감 목록의 생성 상태에서 진행을 볼 수 있습니다.") : t("프로필을 다시 만들었습니다.")); } catch (e) { showToast(`${t("실패:")} ${(e as Error).message}`); } finally { setBusy(false); } };
  return (
    <section className="side-block profile">
      <div className="row between" style={{ alignItems: "baseline" }}>
        <h2 style={{ margin: 0 }}>{t("프로젝트")} <span className="tiny muted" style={{ textTransform: "none", letterSpacing: 0 }}>{t("기준선")}</span></h2>
        {!editing && <span className="row" style={{ gap: 6 }}>{view && <button className="ghost sm" onClick={() => setEditing(true)}>{t("고치기")}</button>}<button className="ghost sm" disabled={busy} onClick={() => void regen()}>{busy ? t("만드는 중…") : view ? t("다시 생성") : t("프로필 만들기")}</button></span>}
      </div>
      {!view && !editing && <p className="small muted" style={{ margin: "8px 0 0" }}>{t("아직 프로필이 없습니다. 다음 수집 때 README로 만들어지며, 지금 만들 수도 있습니다. 프로필이 있어야 다이제스트가 \"무엇이 원래 있던 것\"과 \"무엇이 바뀐 것\"을 나눕니다.")}</p>}
      {view && !editing && (
        <div className="stack" style={{ gap: 6, marginTop: 8 }}>
          <p className="small" style={{ margin: 0, lineHeight: 1.55 }}>{p!.what || <span className="muted">{t("설명 없음")}</span>}</p>
          <div className="tiny muted">{p!.audience}</div>
          <div className="row wrap" style={{ gap: 6 }}><span className="badge outline">{t(STAGE_LABEL[p!.stage] ?? p!.stage)}</span>{p!.naming && <span className="badge outline">{p!.naming}</span>}{view.editedFields.length > 0 && <span className="badge ok">{t("내가 고침")}</span>}</div>
          {p!.claims.length > 0 && <ul className="hl small" style={{ marginTop: 4 }}>{p!.claims.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          {p!.avoid.length > 0 && <div className="tiny muted">{t("쓰지 않음:")} {p!.avoid.join(", ")}</div>}
          <div className="meta-line"><code>{view.model.split("@")[0].replace("gemini/", "")}</code><span>{fmtDate(view.updatedAt)}</span></div>
        </div>
      )}
      {editing && (
        <div className="stack" style={{ gap: 8, marginTop: 8 }}>
          <label className="field"><span>{t("무엇인가")}</span><textarea value={what} onChange={(ev) => setWhat(ev.target.value)} style={{ minHeight: 56 }} /></label>
          <label className="field"><span>{t("누구를 위한 것인가")}</span><input value={audience} onChange={(ev) => setAudience(ev.target.value)} /></label>
          <label className="field"><span>{t("핵심 주장 (한 줄에 하나)")}</span><textarea value={claims} onChange={(ev) => setClaims(ev.target.value)} style={{ minHeight: 70 }} /></label>
          <label className="field"><span>{t("글에 쓰지 않을 말 (쉼표로)")}</span><input value={avoid} onChange={(ev) => setAvoid(ev.target.value)} placeholder={t("회사명, 내부 호스트명…")} /></label>
          <div className="toolbar">
            <button className="primary" disabled={busy} onClick={async () => {
              setBusy(true);
              try { await patch(`/profiles/${repo}`, { what, audience, claims: claims.split("\n").map((x) => x.trim()).filter(Boolean), avoid: avoid.split(",").map((x) => x.trim()).filter(Boolean) }); setEditing(false); showToast(t("프로필을 저장했습니다. 다음 다이제스트부터 반영됩니다.")); }
              catch (err) { showToast(`${t("저장하지 못했습니다.")} ${(err as Error).message}`); }
              finally { setBusy(false); }
            }}>{t("저장")}</button>
            <button className="ghost" onClick={() => setEditing(false)}>{t("취소")}</button>
          </div>
        </div>
      )}
    </section>
  );
}
