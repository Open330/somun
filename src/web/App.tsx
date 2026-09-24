import { lazy, Suspense, useEffect, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import type { CandidateListItem, SettingsView } from "@shared/types";
import { api, endSession, legacyToken, startSession, UNAUTHORIZED_EVENT, useResource } from "./lib/api";
import { useAuth } from "./lib/auth/context";
import { Skeleton } from "./components/ui";
import { ChunkBoundary } from "./components/ChunkBoundary";
import { LocaleSwitch, useAccountLocaleSync } from "./components/LocaleSwitch";
import AuthCallback from "./pages/AuthCallback";
import Landing from "./pages/Landing";
import TokenLogin from "./pages/TokenLogin";
import NotFound from "./pages/NotFound";
import { Lockup, Mark } from "./components/Mark";
import { t } from "./i18n";

// 로그인 뒤 화면은 필요할 때 받는다. 첫 화면(랜딩·로그인)이 가벼워진다.
const Candidate = lazy(() => import("./pages/Candidate"));
const Connectors = lazy(() => import("./pages/Connectors"));
const Inbox = lazy(() => import("./pages/Inbox"));
const Published = lazy(() => import("./pages/Published"));
const Settings = lazy(() => import("./pages/Settings"));
const Voice = lazy(() => import("./pages/Voice"));
const GithubSetup = lazy(() => import("./pages/GithubSetup"));
const Pick = lazy(() => import("./pages/Pick"));
const SetupGithubApp = lazy(() => import("./pages/SetupGithubApp"));

/** 인증 확인 중. 빈 화면 대신 로고와 상태를 보여준다. */
const Booting = () => <div className="booting" role="status" aria-live="polite"><Mark size={32} /><span>{t("불러오는 중…")}</span></div>;

const NAV = [["/", "글감"], ["/published", "발행 기록"], ["/connectors", "연결 관리"], ["/voice", "문체"], ["/settings", "설정"]] as const;

export default function App() {
  const auth = useAuth();
  const [tokenState, setTokenState] = useState<"checking" | "ok" | "need" | "form">("checking");
  useEffect(() => {
    if (auth.enabled) return;
    // 예전 버전이 localStorage에 둔 토큰이 있으면 세션 쿠키로 바꾼다(한 번).
    const legacy = legacyToken();
    (legacy ? startSession(legacy).catch(() => false) : Promise.resolve(false))
      .then(() => api("/me")).then(() => setTokenState("ok")).catch(() => setTokenState("need"));
  }, [auth.enabled]);
  // 세션이 끝나면 멈춘 화면 대신 로그인으로 돌아간다.
  useEffect(() => {
    const onUnauthorized = () => {
      if (auth.enabled) void auth.signOut();
      else setTokenState((s) => (s === "form" ? s : "need"));
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [auth]);
  if (!auth.enabled && tokenState === "checking") return <Booting />;
  if (!auth.enabled && tokenState === "need") return <Landing onToken={() => setTokenState("form")} />;
  if (!auth.enabled && tokenState === "form") return <TokenLogin onDone={() => setTokenState("ok")} />;
  if (auth.enabled && auth.isLoading) return <Booting />;
  if (auth.enabled && !auth.isAuthenticated) {
    return <Routes><Route path="/auth/callback" element={<AuthCallback />} /><Route path="*" element={<Landing />} /></Routes>;
  }
  return <Shell onSignOut={async () => { if (auth.enabled) await auth.signOut(); else { await endSession(); setTokenState("need"); } }} who={auth.enabled ? auth.user?.displayName ?? auth.user?.username ?? "" : t("토큰 세션")} />;
}

function Shell({ onSignOut, who }: { onSignOut: () => void | Promise<void>; who: string }) {
  const location = useLocation();
  const { data: rows } = useResource<CandidateListItem[]>("/candidates", ["candidates"]);
  const { data: suggestions } = useResource<{ id: number }[]>("/suggestions", ["settings"]);
  const { data: settings } = useResource<SettingsView>("/settings", ["settings"]);
  useAccountLocaleSync(settings);
  const review = (rows ?? []).filter((c) => c.status === "drafted").length;
  const pending = suggestions?.length ?? 0;
  const links = NAV.map(([to, label]) => <NavLink key={to} to={to} end={to === "/"}>{t(label)}{to === "/" && review ? <span className="count">{review}</span> : null}{to === "/voice" && pending ? <span className="count" title={t("지침 제안")}>{pending}</span> : null}</NavLink>);
  return (
    <div className="layout">
      <a className="skip-link" href="#main-content">{t("본문으로 바로 가기")}</a>
      <aside className="sidebar">
        <div className="brand"><Lockup size={30} /></div>
        <span className="nav-caption">{t("워크스페이스")}</span><nav className="nav" aria-label={t("주 메뉴")}>{links}</nav>
        <div className="spacer" /><div className="sidebar-note"><b>{t("만드는 일에 집중하세요.")}</b><p>{t("알릴 이야기는 여기 모아둘게요.")}</p></div>
        <div className="who-locale"><LocaleSwitch compact /></div>
        <div className="who"><span>{who}</span><button className="ghost sm" onClick={() => void onSignOut()}>{t("나가기")}</button></div>
      </aside>
      <div>
        <div className="topbar"><div className="brand"><Mark size={26} /></div>{links}<span className="mobile-locale"><LocaleSwitch compact /></span><button className="ghost sm mobile-signout" onClick={() => void onSignOut()}>{t("나가기")}</button></div>
        <main className="main" id="main-content" tabIndex={-1}>
          <ChunkBoundary resetKey={location.pathname}>
          <Suspense fallback={<Skeleton rows={4} />}>
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
            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
          </ChunkBoundary>
        </main>
      </div>
    </div>
  );
}
