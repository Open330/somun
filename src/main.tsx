import { ConvexProvider, ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { isAuthEnabled } from "./lib/auth/config";
import { AuthProvider, useConvexAuthAdapter } from "./lib/auth/context";
import "./styles.css";

const convexUrl = import.meta.env.VITE_CONVEX_URL;
if (!convexUrl) throw new Error("VITE_CONVEX_URL이 없습니다. `npx convex dev`를 먼저 실행하세요.");
const convex = new ConvexReactClient(convexUrl);

function ConvexRoot({ children }: { children: ReactNode }) {
  if (!isAuthEnabled()) return <ConvexProvider client={convex}>{children}</ConvexProvider>;
  return (
    <ConvexProviderWithAuth client={convex} useAuth={useConvexAuthAdapter}>
      {children}
    </ConvexProviderWithAuth>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <ConvexRoot>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ConvexRoot>
    </AuthProvider>
  </StrictMode>,
);
