import { useState } from "react";
import type { BridgeTokenView, VideoConfigView } from "@shared/video";
import { fmtDate } from "../components/ui";
import { api, post, useResource } from "../lib/api";
import { t } from "../i18n";

/**
 * 영상 bridge 토큰. 내 컴퓨터의 Claude Code를 영상 서버에 붙일 때 쓴다.
 * 토큰 원문은 발급 직후 한 번만 보여 준다(서버는 해시만 둔다).
 */
export default function VideoBridges({ showToast }: { showToast: (m: string) => void }) {
  const { data: cfg } = useResource<VideoConfigView>("/video", []);
  const { data: tokens, reload } = useResource<BridgeTokenView[]>(cfg?.enabled ? "/video/bridges" : null, []);
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<{ token: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!cfg?.enabled) return null;

  const issue = async () => {
    setBusy(true);
    try {
      const r = await post<{ token: string; label: string }>("/video/bridges", { label: label || "bridge" });
      setIssued(r); setLabel(""); reload();
    } catch (e) {
      showToast(`${t("토큰을 만들지 못했습니다.")} ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    try {
      const r = await api<{ synced: boolean }>(`/video/bridges/${encodeURIComponent(id)}`, { method: "DELETE" });
      showToast(r.synced ? t("토큰을 폐기했습니다.") : t("폐기했습니다. 영상 서버에는 5분 안에 반영됩니다."));
      reload();
    } catch (e) {
      showToast((e as Error).message);
    }
  };
  const command = (token: string) => `VIDEO_SERVER_URL=${cfg.bridgeUrl ?? ""} VIDEO_BRIDGE_TOKEN=${token} npm run video-bridge`;

  return (
    <div className="card stack" style={{ gap: 12 }}>
      <h3 style={{ margin: 0 }}>{t("영상 bridge")}</h3>
      <p className="small muted" style={{ margin: 0 }}>{t("짧은 영상의 연출은 내 컴퓨터의 Claude Code가 합니다(본인 구독). 토큰을 만들고 somun 저장소에서 아래 명령을 실행하세요. 영상 서버에는 연결하지만 서버가 내 컴퓨터로 들어오지는 않습니다.")}</p>
      {issued && (
        <div className="callout stack" style={{ gap: 6 }}>
          <b className="small">{t("\"{label}\" 토큰입니다. 이 화면을 벗어나면 다시 볼 수 없습니다.", { label: issued.label })}</b>
          <pre className="evidence" style={{ margin: 0 }}>{command(issued.token)}</pre>
          <div className="toolbar">
            <button className="sm" onClick={() => void navigator.clipboard.writeText(command(issued.token)).then(() => showToast(t("복사했습니다")))}>{t("명령 복사")}</button>
            <button className="sm" onClick={() => setIssued(null)}>{t("닫기")}</button>
          </div>
        </div>
      )}
      {tokens?.length ? (
        <div className="stack small">
          {tokens.map((b) => (
            <div key={b.id} className="row between">
              <span><span className={`badge ${b.connected ? "ok" : "outline"}`}>{b.connected ? t("연결됨") : t("대기")}</span> {b.label} <span className="muted">· {t("만듦 {when}", { when: fmtDate(b.createdAt) })}{b.lastSeenAt ? ` · ${t("마지막 연결 {when}", { when: fmtDate(b.lastSeenAt) })}` : ""}</span></span>
              <button className="sm danger" onClick={() => void revoke(b.id)}>{t("폐기")}</button>
            </div>
          ))}
        </div>
      ) : <p className="small muted" style={{ margin: 0 }}>{t("아직 만든 토큰이 없습니다.")}</p>}
      <div className="row" style={{ gap: 8 }}>
        <input aria-label={t("토큰 이름")} placeholder={t("이름 (예: 맥북)")} value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} style={{ width: 200 }} />
        <button className="primary sm" disabled={busy} onClick={() => void issue()}>{t("토큰 만들기")}</button>
      </div>
    </div>
  );
}
