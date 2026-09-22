import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "@shared/types";
import { getAuthManager } from "./auth/manager";
import { resetEvents, subscribeEvents } from "./events";

/** fetch 래퍼. 인증 토큰이 있으면 Bearer로. */
export function storedToken(): string | null {
  try { return localStorage.getItem("somun.token"); } catch { return null; }
}
export function clearStoredToken(): void {
  try { localStorage.removeItem("somun.token"); } catch { /* ignore */ }
  resetEvents();
}

async function authHeader(): Promise<Record<string, string>> {
  const m = getAuthManager();
  const token = m ? await m.fetchApiToken() : storedToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, { ...init, headers: { "Content-Type": "application/json", ...(await authHeader()), ...(init.headers ?? {}) } });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data as { error?: string })?.error ?? `HTTP ${res.status}`);
  return data as T;
}
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const del = (path: string) => api<void>(path, { method: "DELETE" });

/**
 * GET + 변경 시 자동 재조회. 서버 상태를 구독하는 유일한 훅.
 * resources: 이 데이터가 의존하는 자원 이름. 그 자원의 change 이벤트가 오면 다시 가져온다.
 */
export function useResource<T>(path: string | null, resources: ChangeEvent["resource"][]): { data: T | undefined; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const resKey = resources.join(",");
  const resRef = useRef(resources);
  resRef.current = resources;
  const request = useRef<AbortController | null>(null);
  const load = useCallback(() => {
    request.current?.abort();
    if (!path) return;
    const controller = new AbortController();
    request.current = controller;
    api<T>(path, { signal: controller.signal }).then((d) => {
      if (!controller.signal.aborted) { setData(d); setError(null); }
    }).catch((e: Error) => {
      if (!controller.signal.aborted) setError(e.message);
    });
  }, [path]);
  useEffect(() => {
    setData(undefined);
    setError(null);
    load();
    const unsubscribe = path ? subscribeEvents((ev) => { if (resRef.current.includes(ev.resource)) load(); }) : undefined;
    return () => { request.current?.abort(); unsubscribe?.(); };
  }, [load, path, resKey]);
  return { data, error, reload: load };
}
