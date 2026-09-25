import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "@shared/types";
import { getAuthManager } from "./auth/manager";
import { resetEvents, subscribeEvents } from "./events";

/**
 * 토큰 모드: 토큰을 한 번 보내 HttpOnly 세션 쿠키를 받는다. 예전 버전이 localStorage에 둔 토큰은 이때 지운다.
 * OAuth 모드는 쿠키 대신 Authorization 헤더(메모리의 액세스 토큰)를 쓴다.
 */
export async function startSession(token: string): Promise<boolean> {
  // 예전 버전이 저장한 토큰은 교환에 성공하든 실패하든 지운다(실패하면 다시 로그인하면 된다).
  forgetLegacyToken();
  const res = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token.trim() }) }).catch(() => null);
  if (res?.ok) resetEvents();
  return Boolean(res?.ok);
}
export async function endSession(): Promise<void> {
  await fetch("/api/session", { method: "DELETE" }).catch(() => undefined);
  forgetLegacyToken();
  resetEvents();
}
const LEGACY_TOKEN = "somun.token";
/** 예전 버전이 저장한 토큰. 한 번 세션으로 바꾸고 지운다. */
export function legacyToken(): string | null {
  try { return localStorage.getItem(LEGACY_TOKEN); } catch { return null; }
}
function forgetLegacyToken(): void {
  try { localStorage.removeItem(LEGACY_TOKEN); } catch { /* ignore */ }
}

async function authHeader(force = false): Promise<Record<string, string>> {
  const m = getAuthManager();
  const token = m ? await m.fetchApiToken(force) : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** HTTP 오류. 화면은 문구가 아니라 상태 코드로 판단한다(404 → 찾을 수 없음). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** 세션이 끝났을 때(토큰 무효·만료) 앱이 로그인 화면으로 돌아가도록 알린다. */
export const UNAUTHORIZED_EVENT = "somun:unauthorized";

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const send = async (force: boolean) => fetch(`/api${path}`, { ...init, headers: { "Content-Type": "application/json", ...(await authHeader(force)), ...(init.headers ?? {}) } });
  let res = await send(false);
  // OAuth 토큰은 만료될 수 있다. 한 번 새로 받아 다시 보내고, 그래도 401이면 세션이 끝난 것이다.
  if (res.status === 401 && getAuthManager()) res = await send(true);
  if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((data as { error?: string })?.error ?? `HTTP ${res.status}`, res.status);
  return data as T;
}
/** JSON이 아닌 응답(영상 파일)을 인증을 붙여 받는다. <video src>는 헤더를 못 붙이므로 받은 뒤 object URL로 쓴다. */
export async function apiBlob(path: string): Promise<Blob> {
  const res = await fetch(`/api${path}`, { headers: await authHeader(false) });
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
  return res.blob();
}
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const del = (path: string) => api<void>(path, { method: "DELETE" });

export const REFETCH_DEBOUNCE_MS = 150;

/**
 * GET + 변경 시 자동 재조회. 서버 상태를 구독하는 유일한 훅.
 * resources: 이 데이터가 의존하는 자원 이름. 그 자원의 change 이벤트가 오면 다시 가져온다.
 */
export function useResource<T>(path: string | null, resources: ChangeEvent["resource"][]): { data: T | undefined; error: string | null; status?: number; reload: () => void } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | undefined>(undefined);
  const resKey = resources.join(",");
  const resRef = useRef(resources);
  resRef.current = resources;
  const request = useRef<AbortController | null>(null);
  const debounce = useRef<number | undefined>(undefined);
  const load = useCallback(() => {
    request.current?.abort();
    if (!path) return;
    const controller = new AbortController();
    request.current = controller;
    api<T>(path, { signal: controller.signal }).then((d) => {
      if (!controller.signal.aborted) { setData(d); setError(null); setStatus(undefined); }
    }).catch((e: Error) => {
      if (!controller.signal.aborted) { setError(e.message); setStatus(e instanceof ApiError ? e.status : undefined); }
    });
  }, [path]);
  useEffect(() => {
    setData(undefined);
    setError(null);
    setStatus(undefined);
    load();
    // 생성 중에는 이벤트가 몰려 온다. 짧게 모아 한 번만 다시 가져온다.
    const unsubscribe = path ? subscribeEvents((ev) => {
      if (!resRef.current.includes(ev.resource)) return;
      window.clearTimeout(debounce.current);
      debounce.current = window.setTimeout(load, REFETCH_DEBOUNCE_MS);
    }) : undefined;
    return () => { request.current?.abort(); window.clearTimeout(debounce.current); unsubscribe?.(); };
  }, [load, path, resKey]);
  return { data, error, status, reload: load };
}
