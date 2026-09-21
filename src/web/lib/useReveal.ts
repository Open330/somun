import { useEffect } from "react";

/**
 * 스크롤로 들어오는 요소에 .in을 붙인다. JS가 없거나 reduced-motion이면 그냥 보인다.
 * data-reveal 속성이 있는 요소만 대상. 한 번 들어오면 관찰을 멈춘다.
 */
export function useReveal(root?: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const scope = root?.current ?? document;
    const els = Array.from(scope.querySelectorAll<HTMLElement>("[data-reveal]"));
    if (els.length === 0) return;
    if (!("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { for (const el of els) el.classList.add("in"); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { (e.target as HTMLElement).classList.add("in"); io.unobserve(e.target); }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    for (const el of els) { el.classList.add("pending"); io.observe(el); }
    return () => io.disconnect();
  }, [root]);
}
