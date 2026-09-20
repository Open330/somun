/**
 * 소문 마크. docs/brand/mark.svg 와 같은 기하 (활자 방식 ㅅ + ㅁ, 밑선 공유).
 * ink: 마크 색, paper: ㅁ 안쪽 반전 색. 기본은 디자인 토큰을 따른다.
 */
export function Mark({ size = 28, ink = "var(--accent)", paper = "var(--surface)", title = "소문" }: { size?: number; ink?: string; paper?: string; title?: string }) {
  const left = "474.0,160 610.2,160 241.5,800 105.3,800";
  const right = "322.2,352 458.4,352 717.1,800 580.9,800";
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" role="img" aria-label={title} style={{ display: "block", flexShrink: 0 }}>
      <defs><clipPath id={`somun-box-${size}`}><rect x="420" y="336" width="464" height="464" rx="72" /></clipPath></defs>
      <rect x="420" y="336" width="464" height="464" rx="72" fill={ink} />
      <g fill={ink}><polygon points={left} /><polygon points={right} /></g>
      <g clipPath={`url(#somun-box-${size})`} fill={paper}><polygon points={left} /><polygon points={right} /></g>
    </svg>
  );
}

/** 마크 + 소문 + somun. */
export function Lockup({ size = 28, dim = false }: { size?: number; dim?: boolean }) {
  return (
    <span className="lockup" style={{ display: "inline-flex", alignItems: "center", gap: Math.round(size * 0.4) }}>
      <Mark size={size} />
      <span className="word" style={{ fontSize: Math.round(size * 0.8), lineHeight: 1 }}>소문</span>
      {!dim && <span className="roman" style={{ fontSize: Math.max(11, Math.round(size * 0.42)) }}>somun</span>}
    </span>
  );
}
