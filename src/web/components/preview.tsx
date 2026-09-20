import type { Channel } from "@core/channels";

/** 채널 모양대로 보여주는 미리보기. 글자 수와 줄바꿈이 실제 화면과 비슷하게 읽히도록. */
export function ChannelPreview({ channel, title, body, author }: { channel: Channel; title?: string; body: string; author: string }) {
  if (channel === "x" || channel === "threads") {
    return (
      <div className="pv pv-x">
        <div className="pv-head"><span className="pv-avatar" /><b>{author}</b><span className="muted">@{author.toLowerCase().replace(/\s+/g, "")} · 지금</span></div>
        <div className="pv-body">{body}</div>
        <div className="pv-foot muted">{channel === "threads" ? "답글 · 리포스트 · 좋아요" : "답글 · 리포스트 · 좋아요 · 조회"}</div>
      </div>
    );
  }
  if (channel === "show_hn") {
    return (
      <div className="pv pv-hn">
        <div className="pv-hn-title"><span className="pv-hn-tri">▲</span> <b>{title || "Show HN: …"}</b> <span className="muted tiny">(github.com)</span></div>
        <div className="pv-hn-meta tiny muted">1 point by {author.toLowerCase()} 0 minutes ago | hide | past | favorite | discuss</div>
        <div className="pv-hn-comment"><div className="tiny muted">{author.toLowerCase()} 0 minutes ago</div><div className="pv-body">{body}</div></div>
      </div>
    );
  }
  if (channel === "show_gn") {
    return (
      <div className="pv pv-gn">
        <div className="pv-gn-title"><b>{title || "Show GN: …"}</b> <span className="tiny muted">(github.com/…)</span></div>
        <div className="pv-body">{body}</div>
      </div>
    );
  }
  if (channel === "linkedin") {
    const [first, ...rest] = body.split("\n");
    return (
      <div className="pv pv-li">
        <div className="pv-head"><span className="pv-avatar sq" /><div><b>{author}</b><div className="tiny muted">지금 · 🌐</div></div></div>
        <div className="pv-body"><span style={{ fontWeight: 500 }}>{first}</span>{rest.length ? "\n" + rest.join("\n") : ""}</div>
        <div className="tiny muted">…더 보기 접힘선은 첫 줄 아래에 옵니다</div>
      </div>
    );
  }
  return <div className="pv"><div className="pv-body">{title ? `${title}\n\n` : ""}{body}</div></div>;
}

/** 단어 단위 diff (LCS). 수정 전후를 한 줄로 보여줄 때 쓴다. */
export function WordDiff({ before, after }: { before: string; after: string }) {
  const a = before.split(/(\s+)/), b = after.split(/(\s+)/);
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { t: "eq" | "del" | "ins"; s: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: "eq", s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: "del", s: a[i] }); i++; }
    else { out.push({ t: "ins", s: b[j] }); j++; }
  }
  while (i < n) out.push({ t: "del", s: a[i++] });
  while (j < m) out.push({ t: "ins", s: b[j++] });
  return <div className="draft-body diff">{out.map((x, k) => x.t === "eq" ? <span key={k}>{x.s}</span> : x.t === "del" ? <del key={k}>{x.s}</del> : <ins key={k}>{x.s}</ins>)}</div>;
}
