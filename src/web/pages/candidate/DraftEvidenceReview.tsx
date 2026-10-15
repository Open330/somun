import { useState } from "react";
import type { Evidence } from "@shared/types";
import { t } from "../../i18n";

type Source = { label: string; text: string; url?: string };

/** Show collected material, never generated highlights as source evidence. */
function sourceMaterial(e: Evidence): Source[] {
  const sources: Source[] = [];
  const add = (label: string, text?: string, url?: string) => {
    if (text?.trim()) sources.push({ label, text, url });
  };
  add(t("프로젝트 설명"), e.description);
  add("README", e.readmeForChecks || e.readmeExcerpt);
  const releases = e.windowReleaseNotes ?? [];
  for (const release of releases) add(`${t("릴리스 노트")} · ${release.tag}`, release.notes);
  if (e.releaseNotes && !releases.some((release) => release.notes === e.releaseNotes)) {
    add(`${t("릴리스 노트")}${e.version ? ` · ${e.version}` : ""}`, e.releaseNotes);
  }
  for (const title of e.mergedPrTitles ?? []) add(t("머지된 PR"), title);
  for (const pr of e.mergedPrDetails ?? []) add(`${t("머지된 PR")} #${pr.number} · ${pr.title}`, pr.body, pr.url);
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
}: {
  title?: string;
  body: string;
  lang: string;
  evidence: Evidence;
  editing: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const parts = [...(title?.trim() ? [title.trim()] : []), ...sentences(body, lang)];
  // A changed sentence must not keep the selection from the previous wording.
  const active = selected && parts.includes(selected) ? selected : null;
  const sources = sourceMaterial(evidence);
  const search = query.trim().toLocaleLowerCase();
  const visible = sources.filter((source) => !search || source.text.toLocaleLowerCase().includes(search));
  const sourceUrl = safeSourceUrl(evidence.repoUrl);
  return (
    <details className="draft-evidence-review">
      <summary>{t("문장과 원자료 대조")}</summary>
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
                <pre>{highlight(source.text, query.trim())}</pre>
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
