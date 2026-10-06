import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getAuthManager } from "../lib/auth/manager";
import { t } from "../i18n";

export default function AuthCallback() {
  const nav = useNavigate();
  const exchange = useRef<Promise<void> | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    if (!exchange.current) {
      const url = new URL(window.location.href);
      const code = url.searchParams.get("code");
      const manager = getAuthManager();
      if (!code || !manager) {
        nav("/", { replace: true });
        return;
      }
      // Codes are single-use; keep the same promise across effect replay and remove it from the address.
      url.searchParams.delete("code");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      exchange.current = manager.exchangeCode(code);
    }
    exchange.current
      .then(() => {
        if (active) nav("/", { replace: true });
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [nav]);
  return (
    <div className="empty">
      {error ? (
        <>
          <p>{t("로그인을 완료하지 못했습니다. 로그인 화면에서 다시 시작해 주세요.")}</p>
          <Link to="/">{t("로그인 화면으로")}</Link>
        </>
      ) : (
        t("로그인 처리 중…")
      )}
    </div>
  );
}
