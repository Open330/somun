import { useState } from "react";
import type { ConditionReviewState, Evidence } from "@shared/types";
import { reviewConditionParagraphs } from "@core/condition-review";
import { t } from "../../i18n";

type Source = { label: string; text: string; url?: string; truncated?: boolean; conditions?: string[] };

/** Show collected material, never generated highlights as source evidence. */
function sourceMaterial(e: Evidence): Source[] {
  const sources: Source[] = [];
  const add = (label: string, text?: string, url?: string) => {
    if (text?.trim()) sources.push({ label, text, url, conditions: reviewConditionParagraphs(text) });
  };
  add(t("프로젝트 설명"), e.description);
  add(t("수집된 README 발췌"), e.readmeForChecks || e.readmeExcerpt);
  const releases = e.windowReleaseNotes ?? [];
  for (const release of releases) add(`${t("릴리스 노트")} · ${release.tag}`, release.notes);
  if (e.releaseNotes && !releases.some((release) => release.notes === e.releaseNotes)) {
    add(`${t("릴리스 노트")}${e.version ? ` · ${e.version}` : ""}`, e.releaseNotes);
  }
  for (const title of e.mergedPrTitles ?? []) add(t("머지된 PR"), title);
  for (const pr of e.mergedPrDetails ?? [])
    sources.push({
      label: `${t("머지된 PR")} #${pr.number} · ${pr.title}`,
      text: pr.body,
      url: pr.url,
      truncated: pr.bodyTruncated,
      conditions: reviewConditionParagraphs(pr.body),
    });
  for (const subject of e.commitSubjects ?? []) add(t("커밋 제목"), subject);
  const metrics: [string, number | undefined][] = [
    [t("스타"), e.stars],
    [t("포크"), e.forks],
    [t("커밋"), e.commitCount],
    [t("릴리스"), e.releaseCount],
    [t("npm 월간 다운로드"), e.npmMonthlyDownloads],
  ];
  add(
    t("수집 당시 수치"),
    metrics
      .filter(([, value]) => value !== undefined)
      .map(([label, value]) => `${label}: ${value}`)
      .join("\n"),
  );
  return sources;
}

function sentences(body: string, lang: string): string[] {
  let locale = lang;
  try {
    Intl.getCanonicalLocales(locale);
  } catch {
    locale = "en";
  }
  return [...new Intl.Segmenter(locale, { granularity: "sentence" }).segment(body)].map((part) => part.segment.trim()).filter(Boolean);
}

function safeSourceUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function highlight(text: string, query: string) {
  if (!query) return text;
  const normalized = text.toLocaleLowerCase();
  const search = query.toLocaleLowerCase();
  // Case folding can change character offsets; keep the original text intact.
  if (normalized.length !== text.length || search.length !== query.length) return text;
  const pieces = [];
  let start = 0;
  let at = normalized.indexOf(search);
  while (at !== -1) {
    pieces.push(text.slice(start, at), <mark key={at}>{text.slice(at, at + query.length)}</mark>);
    start = at + query.length;
    at = normalized.indexOf(search, start);
  }
  pieces.push(text.slice(start));
  return pieces;
}

export default function DraftEvidenceReview({
  title,
  body,
  lang,
  evidence,
  editing,
  review,
  dirty = false,
  busy = false,
  onConfirm,
}: {
  title?: string;
  body: string;
  lang: string;
  evidence: Evidence;
  editing: boolean;
  review?: ConditionReviewState;
  dirty?: boolean;
  busy?: boolean;
  onConfirm?: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const parts = [...(title?.trim() ? [title.trim()] : []), ...sentences(body, lang)];
  // A changed sentence must not keep the selection from the previous wording.
  const active = selected && parts.includes(selected) ? selected : null;
  const sources = sourceMaterial(evidence);
  const search = query.trim().toLocaleLowerCase();
  const visible = sources.filter((source) => !search || source.text.toLocaleLowerCase().includes(search));
  const incomplete = sources.filter((source) => source.truncated || !source.text.trim());
  const sourceUrl = safeSourceUrl(evidence.repoUrl);
  const confirmed = review?.confirmedAt !== undefined && !dirty;
  const labels = { readme: t("수집된 README 발췌"), release: t("릴리스 노트"), pr: t("머지된 PR"), profile: t("프로필 제한사항") };
  return (
    <details className="draft-evidence-review" open={review?.required && !confirmed ? true : undefined}>
      <summary>
        {t("문장과 원자료 대조")}
        {review?.required && (
          <span className={`badge ${confirmed ? "outline" : "warn"}`}>{confirmed ? t("사용자 확인 완료") : t("원문 조건 확인 필요")}</span>
        )}
      </summary>
      <p className="small muted">{t("문장을 고르고 원문 표현으로 자료를 검색하세요. 검색 결과는 사실 확인 완료를 뜻하지 않습니다.")}</p>
      {editing && <p className="small">{t("수정 중인 문장을 보여줍니다. 자동 점검 결과는 저장 후 갱신됩니다.")}</p>}
      <div className="evidence-review-grid">
        <div>
          <h3>{t("확인할 문장")}</h3>
          <div className="evidence-sentences" role="group" aria-label={t("확인할 문장")}>
            {parts.map((part, index) => (
              <button key={index} aria-pressed={active === part} onClick={() => setSelected(part)}>
                <span aria-hidden="true">{index + 1}.</span> {part}
              </button>
            ))}
          </div>
        </div>
        <div>
          <h3>{t("글감에 저장된 자료")}</h3>
          {review?.required && (
            <section className="condition-review" aria-label={t("원문 조건 확인")}>
              <p className="small">{t("이 글의 주장에 해당하는 전제와 제외 조건을 원자료와 직접 대조한 뒤 복사하세요.")}</p>
              <p className="small muted">
                {t("조건 후보는 일부 표현을 찾은 보조자료이며 빠진 내용이 있을 수 있습니다. 사용자 확인은 자동 정확성 검증이 아닙니다.")}
              </p>
              {review.sources.map((source, index) => (
                <details className="evidence-condition-excerpts" key={index}>
                  <summary>
                    {labels[source.kind]} {source.ref}
                  </summary>
                  {source.excerpts.map((text, at) => (
                    <pre key={at}>{text}</pre>
                  ))}
                  {source.incomplete && <p className="small">{t("본문이 없거나 일부만 수집됐습니다. 원문에서 빠진 조건을 확인하세요.")}</p>}
                  {source.url && safeSourceUrl(source.url) && (
                    <a href={safeSourceUrl(source.url)} target="_blank" rel="noopener noreferrer">
                      {t("원문 열기")} ↗
                    </a>
                  )}
                </details>
              ))}
              {confirmed ? (
                <p className="small">
                  {t("사용자 확인 완료")}
                  {" · "}
                  {t("본문이나 원자료가 바뀌면 다시 확인해야 합니다.")}
                </p>
              ) : (
                <>
                  {editing && <p className="small">{t("수정 내용을 먼저 저장한 뒤 원문 조건을 확인하세요.")}</p>}
                  <button className="primary" disabled={busy || editing || !onConfirm} onClick={() => void onConfirm?.()}>
                    {t("원문 조건을 확인했습니다")}
                  </button>
                </>
              )}
            </section>
          )}
          {incomplete.length > 0 && (
            <aside className="evidence-source-warning" aria-label={t("추가 원문 확인 필요")}>
              <p className="small">{t("본문이 없거나 일부만 수집된 PR이 있습니다. 빠진 조건은 원문에서 확인하세요.")}</p>
              <ul>
                {incomplete.map((source, index) => (
                  <li key={index}>
                    {source.url && safeSourceUrl(source.url) ? (
                      <a href={safeSourceUrl(source.url)} target="_blank" rel="noopener noreferrer">
                        {source.label} ↗
                      </a>
                    ) : (
                      source.label
                    )}
                    {" · "}
                    {source.truncated ? t("본문 일부 수집") : t("본문 없음")}
                  </li>
                ))}
              </ul>
            </aside>
          )}
          {active && <blockquote className="evidence-selected">{active}</blockquote>}
          <label>
            {t("원자료 검색")}
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("원문 단어나 수치 입력")}
            />
          </label>
          {search && (
            <button className="ghost sm" onClick={() => setQuery("")}>
              {t("전체 자료 보기")}
            </button>
          )}
          <div className="evidence-source-results" role="region" aria-label={t("검색한 원자료")}>
            {visible.map((source, index) => (
              <section key={index} className="evidence-source-card">
                <h4>
                  {source.url && safeSourceUrl(source.url) ? (
                    <a href={safeSourceUrl(source.url)} target="_blank" rel="noopener noreferrer">
                      {source.label} ↗
                    </a>
                  ) : (
                    source.label
                  )}
                </h4>
                {source.conditions && source.conditions.length > 0 && (
                  <details className="evidence-condition-excerpts">
                    <summary>
                      {t("조건·예외로 보이는 원문")} · {source.conditions.length}
                    </summary>
                    <p className="small muted">
                      {t("일부 조건 표현을 모은 보조자료입니다. 빠진 내용이 있을 수 있으니 전체 본문도 확인하세요.")}
                    </p>
                    {source.conditions.map((paragraph, at) => (
                      <pre key={at}>{highlight(paragraph, query.trim())}</pre>
                    ))}
                  </details>
                )}
                {source.text.trim() ? (
                  <pre>{highlight(source.text, query.trim())}</pre>
                ) : (
                  <p className="small">{t("본문이 수집되지 않았습니다. 원문 링크에서 확인하세요.")}</p>
                )}
              </section>
            ))}
            {!visible.length && (
              <p role="status" className="small">
                {sources.length
                  ? t("일치하는 원문 표현이 없습니다. 다른 단어로 검색하거나 전체 자료를 확인하세요. 번역·의역은 직접 대조해야 합니다.")
                  : t("대조할 원문이 저장돼 있지 않습니다. 프로젝트 원문을 확인한 뒤 게시해 주세요.")}
              </p>
            )}
          </div>
          <p className="tiny muted">
            {t("수집된 자료이며 생성 당시 자료와 다를 수 있습니다. PR·커밋 제목만으로 세부 동작을 확정하지 마세요.")}
          </p>
          {sourceUrl && (
            <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
              {t("프로젝트 원문 열기")} ↗
            </a>
          )}
        </div>
      </div>
    </details>
  );
}
