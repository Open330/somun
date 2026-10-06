import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { t } from "../i18n";

/** GitHub installation proof is single-use; replaying an effect must share the first request. */
export default function GithubSetup() {
  const nav = useNavigate();
  const request = useRef<{ id: string; result: Promise<{ account: string; repos: string[] }> } | null>(null);
  const [failed, setFailed] = useState(false);
  const [msg, setMsg] = useState(t("GitHub 설치를 기록하는 중…"));
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!request.current) {
      const params = new URLSearchParams(window.location.search);
      const id = params.get("installation_id");
      if (!id) {
        setMsg(t("installation_id가 없습니다."));
        setFailed(true);
        return;
      }
      const code = params.get("code"),
        state = params.get("state");
      if (code || state)
        window.history.replaceState(window.history.state, "", `${window.location.pathname}?installation_id=${encodeURIComponent(id)}`);
      const extra = `${code ? `&code=${encodeURIComponent(code)}` : ""}${state ? `&state=${encodeURIComponent(state)}` : ""}`;
      request.current = { id, result: api(`/github/setup?installation_id=${encodeURIComponent(id)}${extra}`) };
    }
    const { id, result } = request.current;
    result
      .then((r) => {
        if (!active) return;
        setMsg(
          t("{account}의 저장소 {n}개에 접근할 수 있습니다. 무엇을 지켜볼지 고르러 갑니다.", { account: r.account, n: r.repos.length }),
        );
        timer = setTimeout(() => nav(`/github/pick?installation_id=${encodeURIComponent(id)}`, { replace: true }), 700);
      })
      .catch((e: Error) => {
        if (active) {
          setMsg(t("연결 실패: {message}", { message: e.message }));
          setFailed(true);
        }
      });
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [nav]);
  return (
    <div className="empty setup-status">
      <p>{msg}</p>
      {failed && <Link to="/connectors">{t("연결 관리로 돌아가기")}</Link>}
    </div>
  );
}
