/**
 * 페이지에 주입하는 가상 시계. 영상의 시간은 벽시계가 아니라 __seek(ms)로만 흐른다.
 * 타이머·rAF·Date·performance.now를 가로채고, CSS 애니메이션과 WAAPI는 멈춘 뒤 currentTime을 맞춘다.
 * 그래서 프레임마다 캡처가 얼마나 걸리든 결과가 같다(결정적 렌더).
 *
 * 브라우저에서 도는 코드라 문자열로 둔다(서버 tsconfig에는 DOM 타입이 없다).
 */
export const VIRTUAL_CLOCK = String.raw`(() => {
  let now = 0;
  const epoch = Date.UTC(2026, 0, 1);
  const timers = new Map();
  const frames = new Map();
  let seq = 1;
  const born = new WeakMap();
  const RealDate = Date;
  class VDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(epoch + now); else super(...a); }
    static now() { return epoch + now; }
  }
  window.Date = VDate;
  // WebRTC는 요청 가로채기를 거치지 않고 임의 주소로 연결할 수 있다. 영상에는 필요 없으므로 없앤다.
  for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"]) { try { Object.defineProperty(window, k, { value: undefined, configurable: false, writable: false }); } catch (e) { /* 없음 */ } }
  performance.now = () => now;
  window.setTimeout = (fn, ms = 0, ...args) => { const id = seq++; timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, args }); return id; };
  window.setInterval = (fn, ms = 0, ...args) => { const every = Math.max(1, Number(ms) || 0); const id = seq++; timers.set(id, { at: now + every, fn, args, every }); return id; };
  window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };
  window.requestAnimationFrame = (fn) => { const id = seq++; frames.set(id, fn); return id; };
  window.cancelAnimationFrame = (id) => { frames.delete(id); };
  const call = (fn, args) => { try { if (typeof fn === "function") fn(...args); } catch (e) { console.error(e && e.stack ? e.stack : String(e)); } };
  // 새로 생긴 애니메이션은 생긴 시각을 기억하고 멈춘다. 이후 currentTime = 지금 - 생긴 시각.
  const adopt = () => {
    for (const a of document.getAnimations()) {
      if (!born.has(a)) { born.set(a, now); a.pause(); }
    }
  };
  // 한 번 옮길 때 실행하는 타이머 수의 상한. setTimeout(f, 0)을 스스로 다시 거는 코드가 시계를 멈추지 못하게.
  const MAX_TIMER_RUNS = 5000;
  window.__seek = (t) => {
    for (let runs = 0; ; runs++) {
      if (runs >= MAX_TIMER_RUNS) throw new Error("too many timers fired in one frame (a timer keeps re-arming itself at the same time)");
      let next = null;
      for (const [id, tm] of timers) if (tm.at <= t && (!next || tm.at < next[1].at)) next = [id, tm];
      if (!next) break;
      const [id, tm] = next;
      now = tm.at;
      if (tm.every) tm.at += tm.every; else timers.delete(id);
      call(tm.fn, tm.args);
      adopt();
    }
    now = t;
    const cbs = [...frames.values()];
    frames.clear();
    for (const cb of cbs) call(cb, [now]);
    adopt();
    for (const a of document.getAnimations()) { try { a.currentTime = Math.max(0, now - born.get(a)); } catch (e) { /* 끝난 애니메이션 */ } }
  };
  // 로드 직후 렌더러가 부른다. 처음부터 있던 CSS 애니메이션은 0초에 태어난 것으로 친다.
  window.__adopt = adopt;
})();`;

/**
 * t 시점에 화면에 보이는 글자와 프레임 밖으로 넘친 글자를 모은다.
 * 투명도(조상 포함)가 거의 0이거나 화면과 겹치지 않는 글자는 보이지 않은 것으로 친다.
 */
export const VISIBLE_TEXT = String.raw`(() => {
  const W = innerWidth, H = innerHeight;
  const alpha = (el) => { let a = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const s = getComputedStyle(e); if (s.display === "none" || s.visibility === "hidden") return 0; a *= Number(s.opacity); } return a; };
  const text = [], overflow = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const value = n.textContent.replace(/\s+/g, " ").trim();
    if (!value || !n.parentElement || ["SCRIPT", "STYLE"].includes(n.parentElement.tagName)) continue;
    if (alpha(n.parentElement) < 0.15) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const inside = r.right > 0 && r.bottom > 0 && r.left < W && r.top < H;
    if (!inside) continue;
    text.push(value);
    if (r.left < -2 || r.top < -2 || r.right > W + 2 || r.bottom > H + 2) overflow.push(JSON.stringify(value.slice(0, 60)));
  }
  return { text, overflow };
})()`;
