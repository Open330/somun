import { Link } from "react-router-dom";

/** 받침이 있으면 "을", 없으면 "를". */
const objectParticle = (word: string) => {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return code >= 0 && code <= 11171 && code % 28 !== 0 ? "을" : "를";
};

/** 없는 주소나 지워진·남의 글감. 서버는 둘을 구분하지 않고 404로 답한다. */
export default function NotFound({ what = "페이지" }: { what?: string }) {
  return <div className="state-panel" role="status"><span className="state-symbol" aria-hidden>?</span><h2>{what}{objectParticle(what)} 찾을 수 없습니다</h2><p>주소가 바뀌었거나 지워졌을 수 있습니다.</p><Link className="btn primary" to="/">글감으로 가기</Link></div>;
}
