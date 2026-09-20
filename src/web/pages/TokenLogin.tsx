import { useState } from "react";

/** SOMUN_TOKEN 모드 로그인. 토큰은 이 브라우저의 localStorage에만 저장된다. */
export default function TokenLogin({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="main">
      <h1>소문</h1>
      <p className="muted">소문낼 줄 모르는 개발자를 위한 PR 도우미. 접근 토큰을 넣으면 시작합니다.</p>
      <form
        className="row"
        onSubmit={async (ev) => {
          ev.preventDefault();
          const res = await fetch("/api/me", { headers: { Authorization: `Bearer ${token.trim()}` } });
          if (!res.ok) { setError("토큰이 맞지 않습니다."); return; }
          try { localStorage.setItem("somun.token", token.trim()); } catch { /* 저장 불가 환경 */ }
          onDone();
        }}
      >
        <input type="password" placeholder="SOMUN_TOKEN" value={token} onChange={(ev) => setToken(ev.target.value)} autoFocus />
        <button className="primary" disabled={!token.trim()}>들어가기</button>
      </form>
      {error && <p className="small" style={{ color: "var(--danger)" }}>{error}</p>}
    </div>
  );
}
