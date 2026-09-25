import { useState } from "react";
import type { CheckItem } from "@core/launch-check";
import type { LaunchCheck } from "@shared/types";
import { api } from "../../lib/api";
import { t } from "../../i18n";

const LABEL: Record<CheckItem["id"], string> = { title: "검색 제목", description: "검색 설명", og_text: "링크 카드 제목·설명", og_image: "링크 카드 이미지", twitter_card: "X 카드 형식", text_without_js: "JS 없이 보이는 본문", robots: "robots.txt", sitemap: "sitemap.xml" };

/** 항목별 안내. 통과한 항목은 읽은 값을, 아닌 항목은 고칠 방법을 한 줄로. */
function hint(item: CheckItem): string | undefined {
  const { id, level, value } = item;
  if (id === "robots") return value === "none" ? t("없음 (모두 허용)") : value === "html" ? t("HTML이 나옵니다. SPA가 모든 경로에 index.html을 돌려주는지 확인하세요.") : value === "disallow" ? t("모든 크롤러를 막고 있습니다.") : value ? t("응답 {status}", { status: value }) : undefined;
  if (id === "sitemap") return level === "ok" ? t("URL {n}개", { n: value ?? "0" }) : value === "html" ? t("HTML이 나옵니다. SPA가 모든 경로에 index.html을 돌려주는지 확인하세요.") : t("없습니다. 페이지가 여럿이면 만들어 두세요.");
  if (level === "ok") return value;
  if (id === "title") return level === "fail" ? t("<title>이 없습니다.") : t("{value} · 10~70자가 좋습니다.", { value: value ?? "" });
  if (id === "description") return level === "fail" ? t("meta description이 없습니다. 검색 결과 아래 줄에 쓰입니다.") : t("40자 이상으로 써 주세요.");
  if (id === "og_text") return level === "fail" ? t("og:title·og:description이 없습니다.") : t("og:title과 og:description 중 하나만 있습니다.");
  if (id === "og_image") return level === "fail" ? t("og:image가 없어 X·LinkedIn 카드에 그림이 나오지 않습니다.") : t("og:image는 https로 시작하는 절대 주소여야 합니다.");
  if (id === "twitter_card") return t("twitter:card가 없습니다. 큰 이미지 카드는 summary_large_image입니다.");
  if (id === "text_without_js") return t("JS를 돌리지 않는 크롤러(네이버 등)와 미리보기에는 빈 페이지로 보입니다.");
  return undefined;
}

const MARK: Record<CheckItem["level"], [string, string]> = { ok: ["✓", "badge ok"], warn: ["!", "badge warn"], fail: ["✕", "badge bad"] };

/** 올리기 전 링크 점검: 글감의 홈페이지가 검색과 링크 미리보기에 어떻게 보이는지. 펼칠 때 한 번 불러온다. */
export default function LaunchCheckBlock({ cid, homepage }: { cid: number; homepage?: string }) {
  const [data, setData] = useState<LaunchCheck | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const load = async () => {
    setState("loading");
    try { setData(await api<LaunchCheck>(`/candidates/${cid}/launch-check`)); setState("idle"); } catch { setState("error"); }
  };
  const failing = data?.items.filter((i) => i.level !== "ok").length ?? 0;
  return (
    <section className="side-block">
      <details className="raw" onToggle={(ev) => { if ((ev.target as HTMLDetailsElement).open && !data && state !== "loading") void load(); }}>
        <summary>{t("링크 미리보기 점검")}{data?.items.length ? <span className={`badge ${failing ? "warn" : "ok"}`} style={{ marginLeft: 6 }}>{failing ? t("고칠 곳 {n}", { n: failing }) : t("통과")}</span> : null}</summary>
        <p className="tiny muted" style={{ margin: "6px 0" }}>{t("글에 넣을 홈페이지가 검색 결과와 X·LinkedIn 링크 카드에 어떻게 보이는지 올리기 전에 확인합니다.")}</p>
        {!homepage && <p className="small muted" style={{ margin: 0 }}>{t("저장소에 홈페이지가 없습니다. GitHub 저장소의 Website 칸에 사이트 주소를 넣으면 다음 수집부터 점검합니다.")}</p>}
        {homepage && state === "loading" && <p className="small muted" style={{ margin: 0 }}>{t("점검하는 중…")}</p>}
        {homepage && state === "error" && <p className="small muted" style={{ margin: 0 }}>{t("점검하지 못했습니다.")} <button className="ghost sm" onClick={() => void load()}>{t("다시 시도")}</button></p>}
        {data?.unreachable && <p className="small muted" style={{ margin: 0 }}>{t("{url}을 열지 못했습니다.", { url: data.homepage ?? "" })}</p>}
        {data && homepage && !data.unreachable && !data.items.length && <p className="small muted" style={{ margin: 0 }}>{t("GitHub 저장소 페이지는 링크 미리보기가 이미 갖춰져 있습니다.")}</p>}
        {data?.items.length ? (
          <ul className="launch-check small">
            {data.items.map((item) => { const [mark, cls] = MARK[item.level]; const h = hint(item); return (
              <li key={item.id}><span className={cls} aria-label={item.level}>{mark}</span> <b>{t(LABEL[item.id])}</b>{h && <div className="tiny muted">{h}</div>}</li>
            ); })}
          </ul>
        ) : null}
        {data?.homepage && data.items.length > 0 && <div className="meta-line"><a href={data.homepage} target="_blank" rel="noreferrer">{data.homepage.replace(/^https?:\/\//, "")}</a></div>}
      </details>
    </section>
  );
}
