import { Link } from "react-router-dom";
import type { ProductRow } from "@shared/types";
import { ErrorState, Skeleton } from "../components/ui";
import { useResource } from "../lib/api";
import { dateLocale, t } from "../i18n";

const STATUS: Record<ProductRow["status"], [string, string]> = {
  ready: ["준비됨", "badge ok"],
  needs_line: ["한 줄 소개 필요", "badge warn"],
  hold: ["보관", "badge outline"],
};

/** 해가 바뀐 지난 게시도 최근처럼 보이지 않게 연도까지 쓴다. */
const fullDate = (ts: number) => new Date(ts).toLocaleDateString(dateLocale(), { year: "numeric", month: "numeric", day: "numeric" });

/** 제품 표: 무엇을 먼저 알릴지 고르도록 제품마다 승인한 한 줄, 주소, 최근 스타, 마지막 게시를 한곳에 모은다. */
export default function Products() {
  // 다시 수집해 스타·홈페이지만 바뀐 경우도 반영하도록 소스 변경에도 다시 불러온다.
  const { data: rows, error, reload } = useResource<ProductRow[]>("/products", ["candidates", "publications", "sources"]);
  if (error) return <ErrorState title={t("제품 목록을 불러오지 못했습니다")} message={error} onRetry={reload} />;
  // 지금 알릴 수 있는 것과 글감이 있는 것만 먼저 보이고, 글감이 없는 저장소와 보관은 접어 둔다.
  const main = rows?.filter((p) => p.status === "ready" || (p.status === "needs_line" && p.candidateId)) ?? [];
  const rest = rows?.filter((p) => !main.includes(p)) ?? [];
  const row = (p: ProductRow) => {
    const [label, cls] = STATUS[p.status];
    return (
      <div key={p.repo} className="pub">
        <span className={cls}>{t(label)}</span>
        <div className="min-w-0">
          {p.candidateId ? (
            <Link to={`/c/${p.candidateId}`} className="pub-title">
              {p.name}
            </Link>
          ) : (
            <b className="pub-title">{p.name}</b>
          )}
          <div className="tiny muted">
            {p.repo}
            {p.stars !== undefined ? ` · ${t("스타 {n}", { n: p.stars })}` : ""}
            {` · ${p.lastPublishedAt ? t("마지막 게시 {date}", { date: fullDate(p.lastPublishedAt) }) : t("아직 게시 안 함")}`}
          </div>
          <div className="small">
            <span className="badge outline">KO</span> {p.oneLinerKo ?? <span className="muted">{t("승인한 한 줄 없음")}</span>}
          </div>
          <div className="small">
            <span className="badge outline">EN</span> {p.oneLinerEn ?? <span className="muted">{t("승인한 한 줄 없음")}</span>}
          </div>
          {p.homepage && /^https?:\/\//i.test(p.homepage) && (
            <div className="tiny">
              <a href={p.homepage} target="_blank" rel="noreferrer">
                {p.homepage.replace(/^https?:\/\//, "")}
              </a>
            </div>
          )}
        </div>
      </div>
    );
  };
  return (
    <>
      <header className="page-head workspace-head">
        <div>
          <h1>{t("제품")}</h1>
          <p className="lede">
            {t("제품마다 승인한 한 줄 소개, 주소, 최근 스타, 마지막 게시를 한곳에서 보고 무엇을 먼저 알릴지 고르세요.")}
          </p>
        </div>
      </header>
      {rows === undefined ? (
        <Skeleton rows={3} />
      ) : rows.length === 0 ? (
        <div className="state-panel">
          <h2>{t("아직 제품 프로필이 없습니다.")}</h2>
          <p>{t("저장소를 연결해 글감을 모으면 제품 프로필이 만들어지고 여기에 나타납니다.")}</p>
          <Link to="/connectors" className="btn primary">
            {t("연결 관리로 가기")}
          </Link>
        </div>
      ) : (
        <>
          <p className="tiny muted">{t("스타와 주소는 가장 최근 글감을 수집할 때의 값입니다.")}</p>
          <div className="rows">{main.map(row)}</div>
          {rest.length > 0 && (
            <details className="raw mt-8">
              <summary>{t("그 밖의 저장소 {n}개 (글감 없음·보관)", { n: rest.length })}</summary>
              <div className="rows">{rest.map(row)}</div>
            </details>
          )}
        </>
      )}
    </>
  );
}
