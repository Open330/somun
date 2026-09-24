import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { t } from "../i18n";

/** GitHub가 설치 완료 후 보내는 곳. 로그인 세션으로 설치를 내 계정에 기록하고 저장소 고르기로 간다. */
export default function GithubSetup() {
  const nav = useNavigate();
  const [msg, setMsg] = useState(t("GitHub 설치를 기록하는 중…"));
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("installation_id");
    if (!id) { setMsg(t("installation_id가 없습니다.")); return; }
    // 설치 중 GitHub 계정 인증을 마치면 code가 온다. 서버가 이 계정이 설치에 접근할 수 있는지 확인하는 데 쓴다(한 번만 유효).
    const code = params.get("code");
    window.history.replaceState(null, "", window.location.pathname);
    api<{ account: string; repos: string[] }>(`/github/setup?installation_id=${encodeURIComponent(id)}${code ? `&code=${encodeURIComponent(code)}` : ""}`)
      .then((r) => { setMsg(t("{account}의 저장소 {n}개에 접근할 수 있습니다. 무엇을 지켜볼지 고르러 갑니다.", { account: r.account, n: r.repos.length })); setTimeout(() => nav(`/github/pick?installation_id=${encodeURIComponent(id)}`, { replace: true }), 700); })
      .catch((e: Error) => setMsg(t("연결 실패: {message}", { message: e.message })));
  }, [nav]);
  return <div className="empty" style={{ margin: 40 }}>{msg}</div>;
}
