import { NavLink, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth/context";
import { AUTH_PROVIDERS } from "./lib/auth/config";
import AuthCallback from "./pages/AuthCallback";
import Candidate from "./pages/Candidate";
import Inbox from "./pages/Inbox";
import Published from "./pages/Published";
import Settings from "./pages/Settings";

function Login() {
  const auth = useAuth();
  return (
    <div className="main">
      <h1>소문</h1>
      <p className="muted">소문낼 줄 모르는 개발자를 위한 PR 도우미. 로그인하면 시작합니다.</p>
      <div className="toolbar">
        {AUTH_PROVIDERS.map((p) => (
          <button key={p} onClick={() => auth.signIn(p)}>
            {p}로 로그인
          </button>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const auth = useAuth();
  if (auth.enabled && auth.isLoading) return <div className="empty">세션 확인 중…</div>;
  if (auth.enabled && !auth.isAuthenticated) {
    return (
      <Routes>
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          소문<small>somun · PR for the reluctant</small>
        </div>
        <nav className="nav">
          <NavLink to="/" end>Inbox</NavLink>
          <NavLink to="/published">Published</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="spacer" />
        {auth.enabled && (
          <div className="small muted row between">
            <span>{auth.user?.displayName ?? auth.user?.username}</span>
            <button onClick={() => void auth.signOut()}>로그아웃</button>
          </div>
        )}
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Inbox />} />
          <Route path="/c/:id" element={<Candidate />} />
          <Route path="/published" element={<Published />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
        </Routes>
      </main>
    </div>
  );
}
