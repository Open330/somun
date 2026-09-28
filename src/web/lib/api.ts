import { useCallback, useEffect, useSyncExternalStore } from "react";
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
  if (res?.ok) { clearResourceCache(); resetEvents(); }
  return Boolean(res?.ok);
}
export async function endSession(): Promise<void> {
  const res = await fetch("/api/session", { method: "DELETE" });
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
  forgetLegacyToken();
  clearResourceCache();
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
/** 방금 받은 데이터는 다시 붙는 화면이 있어도 새로 요청하지 않는다(사이드바와 본문이 같은 목록을 동시에 여는 경우). */
const FRESH_MS = 2000;

/**
 * 경로별 공유 캐시. 같은 경로를 여러 화면이 동시에 열어도 요청은 하나이고,
 * 화면을 옮겼다 돌아오면 받아 둔 데이터를 먼저 보여 준 뒤 뒤에서 새로 받는다(빈 화면 깜빡임 없음).
 * 쓰는 화면이 모두 사라지면 진행 중인 요청을 끊는다. 계정이 바뀌면 clearResourceCache로 비운다.
 */
type Entry = { data?: unknown; error: string | null; status?: number; fetchedAt: number };
const entries = new Map<string, Entry>();
const watchers = new Map<string, Set<() => void>>();
const inflight = new Map<string, AbortController>();
const timers = new Map<string, number>();
const EMPTY: Entry = { error: null, fetchedAt: 0 };

function publish(path: string, next: Entry) {
  entries.set(path, next);
  for (const w of watchers.get(path) ?? []) w();
}

function fetchResource(path: string, force = false) {
  const running = inflight.get(path);
  if (running && !force) return;
  running?.abort();
  const controller = new AbortController();
  inflight.set(path, controller);
  api<unknown>(path, { signal: controller.signal }).then((data) => {
    if (!controller.signal.aborted) publish(path, { data, error: null, fetchedAt: Date.now() });
  }).catch((e: Error) => {
    if (!controller.signal.aborted) publish(path, { ...(entries.get(path) ?? EMPTY), error: e.message, status: e instanceof ApiError ? e.status : undefined, fetchedAt: Date.now() });
  }).finally(() => { if (inflight.get(path) === controller) inflight.delete(path); });
}

/** 생성 중에는 이벤트가 몰려 온다. 경로마다 짧게 모아 한 번만 다시 가져온다. */
function scheduleRefetch(path: string) {
  window.clearTimeout(timers.get(path));
  timers.set(path, window.setTimeout(() => { timers.delete(path); if (watchers.get(path)?.size) fetchResource(path, true); }, REFETCH_DEBOUNCE_MS));
}

function watch(path: string, onChange: () => void): () => void {
  let set = watchers.get(path);
  if (!set) watchers.set(path, (set = new Set()));
  set.add(onChange);
  return () => {
    set.delete(onChange);
    if (set.size) return;
    watchers.delete(path);
    inflight.get(path)?.abort();
    inflight.delete(path);
    window.clearTimeout(timers.get(path));
    timers.delete(path);
  };
}

/** 로그인·로그아웃 때 부른다. 다른 계정의 데이터가 화면에 남지 않게 한다. */
export function clearResourceCache(): void {
  for (const c of inflight.values()) c.abort();
  inflight.clear();
  entries.clear();
}

/**
 * GET + 변경 시 자동 재조회. 서버 상태를 구독하는 유일한 훅.
 * resources: 이 데이터가 의존하는 자원 이름. 그 자원의 change 이벤트가 오면 다시 가져온다.
 */
export function useResource<T>(path: string | null, resources: ChangeEvent["resource"][]): { data: T | undefined; error: string | null; status?: number; reload: () => void } {
  const resKey = resources.join(",");
  const entry = useSyncExternalStore(
    useCallback((onChange: () => void) => (path ? watch(path, onChange) : () => {}), [path]),
    () => (path ? entries.get(path) ?? EMPTY : EMPTY),
  );
  useEffect(() => {
    if (!path) return;
    const known = entries.get(path);
    if (!known || Date.now() - known.fetchedAt > FRESH_MS) fetchResource(path);
    const wanted = resKey.split(",");
    return subscribeEvents((ev) => { if (wanted.includes(ev.resource)) scheduleRefetch(path); });
  }, [path, resKey]);
  const reload = useCallback(() => { if (path) fetchResource(path, true); }, [path]);
  return { data: entry.data as T | undefined, error: entry.error, status: entry.status, reload };
}
