import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";

/** GitHub가 설치 완료 후 보내는 곳. 로그인 세션으로 설치를 내 계정에 기록하고 글감으로 간다. */
export default function GithubSetup() {
  const nav = useNavigate();
  const [msg, setMsg] = useState("GitHub 설치를 기록하는 중…");
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("installation_id");
    if (!id) { setMsg("installation_id가 없습니다."); return; }
    api<{ account: string; repos: string[] }>(`/github/setup?installation_id=${encodeURIComponent(id)}`)
      .then((r) => { setMsg(`${r.account}의 저장소 ${r.repos.length}개를 연결했습니다. 첫 스캔을 시작합니다.`); return api("/collect", { method: "POST" }).catch(() => undefined); })
      .then(() => setTimeout(() => nav("/", { replace: true }), 1200))
      .catch((e: Error) => setMsg(`연결 실패: ${e.message}`));
  }, [nav]);
  return <div className="empty" style={{ margin: 40 }}>{msg}</div>;
}
