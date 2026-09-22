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
    const manager = getAuthManager();
    let token: string | null = null;
    if (manager) token = await manager.fetchApiToken();
    else { try { token = localStorage.getItem("somun.token"); } catch { /* anonymous mode can work without storage */ } }
    if (current !== generation || !listeners.size) return;
    const stream = new EventSource(`/api/events${token ? `?token=${encodeURIComponent(token)}` : ""}`, { withCredentials: true });
    source = stream;
    stream.addEventListener("open", () => { if (source === stream) retryMs = 1000; });
    stream.addEventListener("change", (event) => {
      if (source !== stream) return;
      let change: ChangeEvent;
      try { change = JSON.parse((event as MessageEvent).data) as ChangeEvent; } catch { return; }
      for (const listener of listeners) listener(change);
    });
    // EventSource would reuse the expired query token; reconnect with a freshly fetched token.
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
