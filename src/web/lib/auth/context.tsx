import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { isAuthEnabled, type AuthProviderName } from "./config";
import { getAuthManager, type AuthSnapshot, type AuthUser } from "./manager";

export type AuthState = {
  enabled: boolean;
  isLoading: boolean;
  isAuthenticated: boolean;
  user: AuthUser | null;
  signIn: (p: AuthProviderName) => void;
  signOut: () => Promise<void>;
};

const DISABLED: AuthSnapshot = { status: "signedOut", user: null };
const AuthContext = createContext<AuthState | null>(null);

function useAuthSnapshot(): AuthSnapshot {
  const m = getAuthManager();
  return useSyncExternalStore(m?.subscribe ?? (() => () => {}), m?.getSnapshot ?? (() => DISABLED), m?.getSnapshot ?? (() => DISABLED));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const m = getAuthManager();
  const snap = useAuthSnapshot();
  useEffect(() => {
    void m?.restore();
  }, [m]);
  const value = useMemo<AuthState>(
    () => ({
      enabled: isAuthEnabled(),
      isLoading: snap.status === "loading",
      isAuthenticated: snap.status === "signedIn",
      user: snap.user,
      signIn: (p) => m?.signIn(p),
      signOut: async () => {
        await m?.signOut();
      },
    }),
    [m, snap],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const s = useContext(AuthContext);
  if (!s) throw new Error("useAuth는 AuthProvider 안에서만");
  return s;
}
