import { Link } from "react-router-dom";
import type { CandidateListItem, Source } from "@shared/types";

/** 첫 결과까지 필요한 행동만 안내한다. 문체와 자동화는 결과를 본 뒤 조정할 수 있다. */
export function Onboarding({ rows, sources }: { rows: CandidateListItem[]; sources: Source[] }) {
  const connected = sources.some((s) => s.enabled && s.targets.length > 0 && ["github", "blog"].includes(s.kind));
  if (rows.length > 0) return null;
  return (
    <section className="first-result" aria-labelledby="first-result-title">
      <div className="first-result-copy">
        <span className="eyebrow">첫 게시글 만들기</span>
        <h2 id="first-result-title">만든 것에서,<br />알릴 만한 이야기로.</h2>
        <p>저장소의 변경이나 블로그 글을 모으면, 소문이 채널에 맞는 초안을 준비합니다. 마지막 문장은 직접 확인하고 올리세요.</p>
        <ol className="journey" aria-label="첫 게시글까지의 과정">
          <li className={connected ? "complete" : "current"}><span>{connected ? "✓" : "1"}</span><div><b>소스 연결</b><small>저장소 또는 블로그 하나면 충분해요</small></div></li>
          <li className={connected ? "current" : ""}><span>2</span><div><b>글감 선택</b><small>알리고 싶은 변화 하나를 골라요</small></div></li>
          <li><span>3</span><div><b>초안 검토 후 게시</b><small>수정하고 복사해 원하는 채널에 올려요</small></div></li>
        </ol>
        {!connected && <Link className="btn primary" to="/connectors">첫 소스 연결하기 <span aria-hidden>→</span></Link>}
      </div>
      <div className="result-example" aria-label="초안 완성 예시">
        <span className="eyebrow">이렇게 활용해요 · 예시</span>
        <div className="example-source"><span aria-hidden>↗</span><div><b>내 프로젝트의 새 릴리스</b><small>변경 내용 · 해결한 문제 · 알려진 한계</small></div></div>
        <div className="example-rule" aria-hidden>↓</div>
        <div className="example-post"><span className="badge outline">Threads · 한국어</span><p>매번 반복하던 작업을 이번 릴리스에서 줄였습니다.</p><p>어떻게 바뀌었는지, 아직 어떤 한계가 있는지 짧게 설명하고 프로젝트 링크로 이어갑니다.</p><span className="tiny muted">실제 초안은 연결한 소스의 근거로 작성됩니다.</span></div>
        <p className="example-foot">초안은 소문이, 게시 전 확인은 내가.</p>
      </div>
    </section>
  );
}
