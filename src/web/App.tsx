import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import type { CandidateListItem } from "@shared/types";
import { api, clearStoredToken, useResource } from "./lib/api";
import { useAuth } from "./lib/auth/context";
import AuthCallback from "./pages/AuthCallback";
import Candidate from "./pages/Candidate";
import Connectors from "./pages/Connectors";
import Inbox from "./pages/Inbox";
import Landing from "./pages/Landing";
import Published from "./pages/Published";
import Settings from "./pages/Settings";
import TokenLogin from "./pages/TokenLogin";
import Voice from "./pages/Voice";
import GithubSetup from "./pages/GithubSetup";
import SetupGithubApp from "./pages/SetupGithubApp";
import type { ConnectorsView } from "@shared/types";

const NAV = [["/", "글감"], ["/published", "발행"], ["/connectors", "연결"], ["/voice", "문체"], ["/settings", "설정"]] as const;

export default function App() {
  const auth = useAuth();
  const [tokenState, setTokenState] = useState<"checking" | "ok" | "need" | "form">("checking");
  useEffect(() => {
    if (auth.enabled) return;
    api("/me").then(() => setTokenState("ok")).catch(() => setTokenState("need"));
  }, [auth.enabled]);
  if (!auth.enabled && tokenState === "checking") return null;
  if (!auth.enabled && tokenState === "need") return <Landing onToken={() => setTokenState("form")} />;
  if (!auth.enabled && tokenState === "form") return <TokenLogin onDone={() => setTokenState("ok")} />;
  if (auth.enabled && auth.isLoading) return null;
  if (auth.enabled && !auth.isAuthenticated) {
    return <Routes><Route path="/auth/callback" element={<AuthCallback />} /><Route path="*" element={<Landing />} /></Routes>;
  }
  return <Shell onSignOut={async () => { if (auth.enabled) await auth.signOut(); else { clearStoredToken(); setTokenState("need"); } }} who={auth.enabled ? auth.user?.displayName ?? auth.user?.username ?? "" : "토큰 세션"} />;
}

function Shell({ onSignOut, who }: { onSignOut: () => void | Promise<void>; who: string }) {
  const { data: rows } = useResource<CandidateListItem[]>("/candidates", ["candidates"]);
  const { data: conn } = useResource<ConnectorsView>("/connectors", ["sources"]);
  const { data: app } = useResource<{ configured: boolean; installUrl?: string }>("/github/app", []);
  // 첫 실행 동의: 앱이 준비돼 있고 아직 아무 연결도 없으면 권한 허용을 먼저 묻는다.
  const needConsent = conn && app?.configured && app.installUrl && conn.github.installations.length === 0 && conn.github.manualTargets.length === 0 && !window.location.pathname.startsWith("/github/") && !window.location.pathname.startsWith("/connectors");
  const review = (rows ?? []).filter((c) => c.status === "drafted").length;
  const links = NAV.map(([to, label]) => <NavLink key={to} to={to} end={to === "/"}>{label}{to === "/" && review ? <span className="count">{review}</span> : null}</NavLink>);
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand"><span className="word">소문</span><span className="roman">somun</span></div>
        <nav className="nav">{links}</nav>
        <div className="spacer" />
        <div className="who"><span>{who}</span><button className="ghost sm" onClick={() => void onSignOut()}>나가기</button></div>
      </aside>
      <div>
        <div className="topbar"><div className="brand"><span className="word">소문</span></div>{links}</div>
        <main className="main">
          {needConsent ? <Consent installUrl={app!.installUrl!} /> : (
          <Routes>
            <Route path="/" element={<Inbox />} />
            <Route path="/c/:id" element={<Candidate />} />
            <Route path="/published" element={<Published />} />
            <Route path="/connectors" element={<Connectors />} />
            <Route path="/voice" element={<Voice />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/welcome" element={<Landing />} />
            <Route path="/github/setup" element={<GithubSetup />} />
            <Route path="/setup/github-app" element={<SetupGithubApp />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
          </Routes>
          )}
        </main>
      </div>
    </div>
  );
}

function Consent({ installUrl }: { installUrl: string }) {
  return (
    <div className="card lift" style={{ maxWidth: 560, margin: "48px auto", padding: 28 }}>
      <h1 style={{ marginBottom: 8 }}>저장소 읽기 권한이 필요합니다</h1>
      <p className="muted">소문은 GitHub의 릴리스, 머지된 PR, 커밋, 스타를 읽어 글감을 찾습니다. 쓰기 권한은 요청하지 않고, 어느 조직·저장소를 허용할지는 GitHub 화면에서 고릅니다.</p>
      <div className="toolbar" style={{ marginTop: 16 }}>
        <a className="btn primary" href={installUrl}>GitHub 권한 허용</a>
        <a className="btn ghost" href="/connectors">저장소를 직접 지정할래요</a>
      </div>
    </div>
  );
}
