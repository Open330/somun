import type { ChangeEvent } from "@shared/types";
import { getAuthManager } from "./auth/manager";

type Listener = (ev: ChangeEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
let connecting = false;
let retryMs = 1000;

function stop() {
  generation++;
  connecting = false;
  source?.close();
  source = null;
  clearTimeout(retry);
  retry = undefined;
}

function reconnect() {
  stop();
  if (!listeners.size) return;
  retry = setTimeout(() => { retry = undefined; void connect(); }, retryMs);
  retryMs = Math.min(retryMs * 2, 30_000);
}

async function connect() {
  if (source || connecting || !listeners.size) return;
  connecting = true;
  const current = generation;
  try {
    // EventSource는 헤더를 못 붙인다. 토큰 대신 1회용 티켓을 받아 주소에 넣는다(토큰·JWT가 주소·로그에 남지 않게).
    const manager = getAuthManager();
    const token = manager ? await manager.fetchApiToken() : null;
    const res = await fetch("/api/events/ticket", { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error(`ticket ${res.status}`);
    const { ticket } = (await res.json()) as { ticket: string };
    if (current !== generation || !listeners.size) return;
    const stream = new EventSource(`/api/events?ticket=${encodeURIComponent(ticket)}`, { withCredentials: true });
    source = stream;
    stream.addEventListener("open", () => { if (source === stream) retryMs = 1000; });
    stream.addEventListener("change", (event) => {
      if (source !== stream) return;
      let change: ChangeEvent;
      try { change = JSON.parse((event as MessageEvent).data) as ChangeEvent; } catch { return; }
      for (const listener of listeners) listener(change);
    });
    // A ticket is single-use: every reconnect fetches a fresh one.
    stream.addEventListener("error", () => { if (source === stream) reconnect(); });
  } catch {
    if (current === generation) reconnect();
  } finally {
    if (current === generation) connecting = false;
  }
}

export function resetEvents() {
  stop();
  retryMs = 1000;
  if (listeners.size) void connect();
}

export function subscribeEvents(listener: Listener): () => void {
  listeners.add(listener);
  if (!retry) void connect();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { stop(); retryMs = 1000; }
  };
}
