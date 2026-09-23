import { Link } from "react-router-dom";
import { t } from "../i18n";

/** 없는 주소나 지워진·남의 글감. 서버는 둘을 구분하지 않고 404로 답한다. */
export default function NotFound({ what = "page" }: { what?: "page" | "candidate" }) {
  return <div className="state-panel" role="status"><span className="state-symbol" aria-hidden>?</span><h2>{what === "candidate" ? t("글감을 찾을 수 없습니다") : t("페이지를 찾을 수 없습니다")}</h2><p>{t("주소가 바뀌었거나 지워졌을 수 있습니다.")}</p><Link className="btn primary" to="/">{t("글감으로 가기")}</Link></div>;
}
