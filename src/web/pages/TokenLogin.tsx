import { useState } from "react";
import { Lockup } from "../components/Mark";
import { t } from "../i18n";
import { startSession } from "../lib/api";

/** SOMUN_TOKEN 모드 로그인. 토큰은 한 번만 보내고, 서버가 준 HttpOnly 세션 쿠키로 인증한다(브라우저 저장소에 토큰을 두지 않는다). */
export default function TokenLogin({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="main">
      <div style={{ marginBottom: 12 }}><Lockup size={36} /></div>
      <p className="muted">{t("소문낼 줄 모르는 개발자를 위한 PR 도우미. 접근 토큰을 넣으면 시작합니다.")}</p>
      <form
        className="row"
        onSubmit={async (ev) => {
          ev.preventDefault();
          if (!await startSession(token)) { setError(t("토큰이 맞지 않습니다.")); return; }
          onDone();
        }}
      >
        <input type="password" placeholder="SOMUN_TOKEN" value={token} onChange={(ev) => setToken(ev.target.value)} autoFocus />
        <button className="primary" disabled={!token.trim()}>{t("들어가기")}</button>
      </form>
      {error && <p className="small" style={{ color: "var(--danger)" }}>{error}</p>}
    </div>
  );
}
