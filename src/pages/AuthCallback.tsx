import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getAuthManager } from "../lib/auth/manager";

export default function AuthCallback() {
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("code");
    const m = getAuthManager();
    if (!code || !m) {
      nav("/", { replace: true });
      return;
    }
    m.exchangeCode(code)
      .then(() => nav("/", { replace: true }))
      .catch((e: Error) => setError(e.message));
  }, [nav]);
  return <div className="empty">{error ?? "로그인 처리 중…"}</div>;
}
