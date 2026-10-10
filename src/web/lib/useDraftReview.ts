import { useEffect, useRef } from "react";
import { patch } from "./api";

/** 화면이 보이고 창이 활성화된 시간만 누적한다. 주기 저장과 최종 저장은 같은 세션을 갱신한다. */
export function useDraftReview(draftId: number | undefined) {
  const flush = useRef<() => Promise<unknown>>(() => Promise.resolve());
  useEffect(() => {
    if (!draftId || typeof crypto.randomUUID !== "function") {
      flush.current = () => Promise.resolve();
      return;
    }
    const sessionId = crypto.randomUUID();
    let activeMs = 0,
      last = performance.now();
    let active = document.visibilityState === "visible" && document.hasFocus();
    const sample = () => {
      const now = performance.now();
      if (active) activeMs += Math.min(now - last, 5000);
      last = now;
    };
    const save = () => {
      sample();
      return Promise.resolve(
        patch(`/drafts/${draftId}/review`, { sessionId, activeSeconds: Math.min(86400, Math.floor(activeMs / 1000)) }),
      ).catch(() => undefined);
    };
    flush.current = save;
    const update = () => {
      sample();
      active = document.visibilityState === "visible" && document.hasFocus();
      void save();
    };
    const tick = window.setInterval(sample, 1000);
    const checkpoint = window.setInterval(() => void save(), 15000);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    void save();
    return () => {
      void save();
      window.clearInterval(tick);
      window.clearInterval(checkpoint);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      flush.current = () => Promise.resolve();
    };
  }, [draftId]);
  return () => flush.current();
}
