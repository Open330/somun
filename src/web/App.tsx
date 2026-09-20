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

export default function App() {
  const auth = useAuth();
  const [tokenState, setTokenState] = useState<"checking" | "ok" | "need" | "form">("checking");
  useEffect(() => {
    if (auth.enabled) return;
    api("/me").then(() => setTokenState("ok")).catch(() => setTokenState("need"));
  }, [auth.enabled]);

  if (!auth.enabled && tokenState === "checking") return <div className="empty" style={{ margin: 40 }}>확인 중…</div>;
  if (!auth.enabled && tokenState === "need") return <Landing onToken={() => setTokenState("form")} />;
  if (!auth.enabled && tokenState === "form") return <TokenLogin onDone={() => setTokenState("ok")} />;
  if (auth.enabled && auth.isLoading) return <div className="empty" style={{ margin: 40 }}>세션 확인 중…</div>;
  if (auth.enabled && !auth.isAuthenticated) {
    return (
      <Routes>
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="*" element={<Landing />} />
      </Routes>
    );
  }
  return <Shell onSignOut={async () => { if (auth.enabled) await auth.signOut(); else { clearStoredToken(); setTokenState("need"); } }} who={auth.enabled ? auth.user?.displayName ?? auth.user?.username ?? "" : "토큰 세션"} />;
}

function Shell({ onSignOut, who }: { onSignOut: () => void | Promise<void>; who: string }) {
  const { data: rows } = useResource<CandidateListItem[]>("/candidates", ["candidates"]);
  const open = (rows ?? []).filter((c) => !["dropped", "published"].includes(c.status)).length;
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand"><span className="word">소문</span><span className="roman">somun</span></div>
        <nav className="nav">
          <NavLink to="/" end>Inbox <span className="count">{open || ""}</span></NavLink>
          <NavLink to="/published">Published</NavLink>
          <NavLink to="/connectors">Connectors</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="spacer" />
        <div className="who"><span>{who}</span><button className="ghost sm" onClick={() => void onSignOut()}>나가기</button></div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Inbox />} />
          <Route path="/c/:id" element={<Candidate />} />
          <Route path="/published" element={<Published />} />
          <Route path="/connectors" element={<Connectors />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/welcome" element={<Landing />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
        </Routes>
      </main>
    </div>
  );
}
