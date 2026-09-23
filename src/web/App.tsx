import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import type { CandidateListItem } from "@shared/types";
import { api, clearStoredToken, UNAUTHORIZED_EVENT, useResource } from "./lib/api";
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
import Pick from "./pages/Pick";
import SetupGithubApp from "./pages/SetupGithubApp";
import { Lockup, Mark } from "./components/Mark";

const NAV = [["/", "글감"], ["/published", "발행 기록"], ["/connectors", "연결 관리"], ["/voice", "문체"], ["/settings", "설정"]] as const;

export default function App() {
  const auth = useAuth();
  const [tokenState, setTokenState] = useState<"checking" | "ok" | "need" | "form">("checking");
  useEffect(() => {
    if (auth.enabled) return;
    api("/me").then(() => setTokenState("ok")).catch(() => setTokenState("need"));
  }, [auth.enabled]);
  // 세션이 끝나면 멈춘 화면 대신 로그인으로 돌아간다.
  useEffect(() => {
    const onUnauthorized = () => {
      if (auth.enabled) void auth.signOut();
      else { clearStoredToken(); setTokenState((s) => (s === "form" ? s : "need")); }
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [auth]);
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
  const { data: suggestions } = useResource<{ id: number }[]>("/suggestions", ["settings"]);
  const review = (rows ?? []).filter((c) => c.status === "drafted").length;
  const pending = suggestions?.length ?? 0;
  const links = NAV.map(([to, label]) => <NavLink key={to} to={to} end={to === "/"}>{label}{to === "/" && review ? <span className="count">{review}</span> : null}{to === "/voice" && pending ? <span className="count" title="지침 제안">{pending}</span> : null}</NavLink>);
  return (
    <div className="layout">
      <a className="skip-link" href="#main-content">본문으로 바로 가기</a>
      <aside className="sidebar">
        <div className="brand"><Lockup size={30} /></div>
        <span className="nav-caption">워크스페이스</span><nav className="nav" aria-label="주 메뉴">{links}</nav>
        <div className="spacer" /><div className="sidebar-note"><b>만드는 일에 집중하세요.</b><p>알릴 이야기는 여기 모아둘게요.</p></div>
        <div className="who"><span>{who}</span><button className="ghost sm" onClick={() => void onSignOut()}>나가기</button></div>
      </aside>
      <div>
        <div className="topbar"><div className="brand"><Mark size={26} /></div>{links}<button className="ghost sm mobile-signout" onClick={() => void onSignOut()}>나가기</button></div>
        <main className="main" id="main-content" tabIndex={-1}>
          <Routes>
            <Route path="/" element={<Inbox />} />
            <Route path="/c/:id" element={<Candidate />} />
            <Route path="/published" element={<Published />} />
            <Route path="/connectors" element={<Connectors />} />
            <Route path="/voice" element={<Voice />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/welcome" element={<Landing />} />
            <Route path="/github/setup" element={<GithubSetup />} />
            <Route path="/github/pick" element={<Pick />} />
            <Route path="/setup/github-app" element={<SetupGithubApp />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
