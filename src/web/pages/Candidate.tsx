import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { enabledTargets, targetKey, type Channel } from "@core/channels";
import { DEFAULT_DRAFT_MODEL } from "@core/models";
import { voicePreset } from "@core/voice";
import type { CandidateDetail, Draft, KeyStatus, SettingsView } from "@shared/types";
import { channelLabel, typeLabel, ChannelIcon, ErrorState, Menu, Meter, Skeleton, StageChip, Toast, fmtDate, stageOf, useToast } from "../components/ui";
import { GenerationStatus } from "../components/GenerationStatus";
import { post, useResource } from "../lib/api";
import DraftPanel from "./candidate/DraftPanel";
import ProfileBlock from "./candidate/ProfileBlock";
import VideoBlock from "./candidate/VideoBlock";
import LaunchCheckBlock from "./candidate/LaunchCheckBlock";
import NotFound from "./NotFound";
import { t } from "../i18n";

/**
 * 글감 하나.
 * 머리: 제목, 단계, 각도(한 문장), 판단 미터, 동작.
 * 초안 검토·수정과 직접 게시·링크 기록을 먼저 배치하고, 근거는 보조 영역에서 확인한다.
 * 다시 쓰기는 지침을 붙일 수 있고 이전 판을 남긴다.
 */
export default function Candidate() {
  const { id } = useParams<{ id: string }>();
  const cid = Number(id);
  const validId = Number.isInteger(cid) && cid > 0;
  const { data, error, status, reload } = useResource<CandidateDetail>(validId ? `/candidates/${cid}` : null, ["candidates", "drafts", "publications"]);
  const { data: settings } = useResource<SettingsView>("/settings", ["settings"]);
  const { data: keys } = useResource<KeyStatus[]>("/keys", ["keys"]);
  const [busy, setBusy] = useState<string | null>(null);
  const [unsaved, setUnsaved] = useState(false);
  const [generationNotice, setGenerationNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const switchDraft = (change: () => void) => { if (!unsaved || window.confirm(t("저장하지 않은 수정 내용이 있습니다. 내용을 버리고 이동할까요?"))) change(); };
  const [tab, setTab] = useState<string | null>(null); // channel
  const [langByCh, setLangByCh] = useState<Record<string, string>>({});
  const [toast, showToast] = useToast();

  const draftsByTarget = useMemo(() => {
    const m = new Map<string, Draft[]>();
    for (const d of data?.drafts ?? []) { const k = targetKey(d.channel, d.lang); m.set(k, [...(m.get(k) ?? []), d]); }
    return m;
  }, [data?.drafts]);
  const targets = useMemo(() => {
    const enabled = enabledTargets(settings?.channelLangs ?? {});
    const fromDrafts = [...draftsByTarget.keys()].map((k) => { const [channel, lang] = k.split(":"); return { channel: channel as Channel, lang }; });
    const seen = new Set<string>();
    return [...enabled, ...fromDrafts].filter((x) => { const k = targetKey(x.channel, x.lang); if (seen.has(k)) return false; seen.add(k); return true; });
  }, [draftsByTarget, settings?.channelLangs]);
  // 채널 단위 탭. 언어는 채널 안에서 고른다 (활성 언어가 둘 이상일 때만 토글이 보인다).
  const channels = useMemo(() => [...new Set(targets.map((x) => x.channel))], [targets]);
  const langsOf = (ch: Channel) => targets.filter((x) => x.channel === ch).map((x) => x.lang);
  useEffect(() => { if ((!tab || !channels.includes(tab as Channel)) && channels.length) setTab(channels.find((ch) => targets.some((x) => x.channel === ch && draftsByTarget.get(targetKey(x.channel, x.lang))?.some((d) => d.status !== "dropped"))) ?? channels[0]); }, [channels, tab, targets, draftsByTarget]);

  if (!validId || status === 404) return <NotFound what="candidate" />;
  if (error) return <ErrorState title={t("글감을 열지 못했습니다")} message={error} onRetry={reload} />;
  if (!data) return <Skeleton rows={6} />;
  const { candidate: c, judgments, publications, profile, told, consistency } = data;
  const j = judgments[0];
  const e = c.evidence;
  const stage = stageOf({ ...c, judgment: j, unpublishedDraftCount: data.unpublishedDraftCount });
  const reasoning = j?.reasoning, angle = j?.angle;
  const decision = j?.overriddenDecision ?? j?.decision;
  const curLangs = tab ? langsOf(tab as Channel) : [];
  const curLang = tab ? (langByCh[tab] && curLangs.includes(langByCh[tab]) ? langByCh[tab] : curLangs[0]) : undefined;
  const current = tab && curLang ? { channel: tab as Channel, lang: curLang } : null;
  const curKey = current ? targetKey(current.channel, current.lang) : null;

  const redraft = async (ts: { channel: Channel; lang: string }[], instruction?: string, key = "draft", introduction?: boolean) => {
    setBusy(key); setGenerationNotice(null);
    try {
      const r = await post<{ started?: string; [key: string]: unknown }>(`/candidates/${cid}/redraft`, { targets: ts, instruction, introduction });
      const results = Object.values(r).filter((value): value is { error?: string; queued?: boolean } => typeof value === "object" && value !== null);
      const failure = results.find((value) => value.error);
      if (failure) throw new Error(failure.error);
      if (r?.started || results.some((value) => value.queued)) setGenerationNotice({ text: settings?.llm.provider === "local-agent" ? t("로컬 워커에 요청했습니다. 워커를 실행해 두면 완성된 초안이 여기에 도착합니다.") : t("초안 준비를 요청했습니다. 진행 상태에서 대기·완료·실패를 확인할 수 있습니다.") });
      else showToast(t("새 초안을 준비했습니다. 내용을 확인해 주세요."));
      reload();
      return true;
    } catch (err) { setGenerationNotice({ text: `${t("초안을 만들지 못했습니다.")} ${(err as Error).message}`, error: true }); return false; } finally { setBusy(null); }
  };
  const redraftAll = () => redraft(enabledTargets(settings?.channelLangs ?? {}));

  return (
    <>
      <div className="cand-head">
        <div className="row wrap tiny muted" style={{ marginBottom: 8 }}><Link to="/">{t("글감")}</Link><span>/</span><span>{typeLabel(c.type)}</span><span>·</span><a href={e.repoUrl} target="_blank" rel="noreferrer">{e.repo}</a>{e.version && <span>· {e.version}</span>}</div>
        <div className="cand-head-row">
          <div style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}><h1 style={{ margin: 0 }}>{c.title}</h1><StageChip stage={stage} /></div>
            {angle && <p className="angle">{angle}</p>}
          </div>
          <div className="toolbar">
            {["dropped", "deferred"].includes(c.status) && <button disabled={busy !== null} onClick={async () => { setBusy("restore"); try { await post(`/candidates/${cid}/status`, { status: data.drafts.some((draft) => draft.status !== "dropped") ? "drafted" : j ? "judged" : "new" }); reload(); showToast(t("글감 목록으로 되돌렸습니다.")); } catch (err) { showToast(`${t("복원하지 못했습니다.")} ${(err as Error).message}`); } finally { setBusy(null); } }}>{t("글감으로 복원")}</button>}
            {decision !== "draft" && j && <button className="primary" disabled={busy !== null} onClick={async () => { try { await post(`/candidates/${cid}/override`, { decision: "draft", reason: "other", note: "manual draft request" }); await redraftAll(); } catch (err) { showToast(`${t("요청하지 못했습니다.")} ${(err as Error).message}`); } }}>{busy === "draft" ? t("쓰는 중…") : t("그래도 초안 쓰기")}</button>}
            <Menu items={[
              { label: busy === "judge" ? t("판단 중…") : t("다시 분석하기"), onClick: async () => { setBusy("judge"); try { await post(`/candidates/${cid}/rejudge`); showToast(t("분석을 접수했습니다. 생성 진행 상태를 확인해 주세요.")); } catch (err) { showToast(`${t("실패:")} ${(err as Error).message}`); } finally { setBusy(null); } } },
              { label: t("모든 채널 다시 쓰기"), onClick: redraftAll },
              { label: t("보류"), onClick: async () => { await post(`/candidates/${cid}/status`, { status: "deferred" }); showToast(t("보류했습니다")); } },
              { label: t("글감 아님으로 보관"), danger: true, onClick: async () => { if (!window.confirm(t("이 글감을 보관할까요? 글감의 보관 필터에서 다시 열 수 있습니다."))) return; await post(`/candidates/${cid}/override`, { decision: "drop", reason: "not_worth" }); showToast(t("보관했습니다. 보관 필터에서 다시 열 수 있습니다.")); } },
            ]} />
          </div>
        </div>
        {j && (
          <details className="judge-details"><summary>{t("추천점수 {n} · 평가 기준 보기", { n: j.total })}</summary><div className="cand-judge">
            <Meter scores={j.scores} />
            <span className="small muted">{t("합 {total} · {decision} · 기준 초안 {draft} / 보류 {defer}", { total: j.total, decision: decision === "draft" ? t("초안") : decision === "defer" ? t("보류") : t("추가 근거 필요"), draft: settings?.draftThreshold ?? 6, defer: settings?.deferThreshold ?? 4 })}{j.overriddenDecision ? ` · ${t("수동")} ${j.overriddenDecision}` : ""}</span>
          </div></details>
        )}
      </div>

      {generationNotice && <div className={`inline-notice ${generationNotice.error ? "is-error" : ""}`} role={generationNotice.error ? "alert" : "status"}><span>{generationNotice.text}</span><Link to="/settings?tab=model">{t("모델 설정 확인")}</Link><button className="ghost sm" aria-label={t("안내 닫기")} onClick={() => setGenerationNotice(null)}>×</button></div>}
      <GenerationStatus candidateId={cid} onChange={reload} />
      <ol className="editor-journey" aria-label={t("게시까지의 과정")}><li><span>1</span> {t("초안 검토·수정")}</li><li><span>2</span> {t("복사해 직접 게시")}</li><li><span>3</span> {t("게시 링크 기록")}</li></ol>
      <div className="cand-layout">


        <section className="cand-main">
          <div className="row between" style={{ alignItems: "baseline", marginBottom: 4 }}>
            <h2 style={{ margin: 0 }}>{t("초안")}</h2>
            {settings && <Link to="/voice" className="tiny muted">{t("문체:")} {t(voicePreset(settings.voice.preset).name)}{settings.voice.guide ? t(" + 내 지침") : ""} ↗</Link>}
          </div>
          {consistency.length > 0 && (
            <div className="callout" style={{ marginBottom: 10 }}>
              <b>{t("언어 간 숫자가 다릅니다.")}</b> {consistency.map((x) => `${channelLabel(x.channel)}: ${x.onlyIn.map((o) => t("{lang}에만 {numbers}", { lang: o.lang.toUpperCase(), numbers: o.numbers.join(", ") })).join(" · ")}`).join(" / ")}. {t("한쪽에만 있는 숫자는 사실 확인 뒤 맞추세요.")}
            </div>
          )}
          <div className="chtabs" role="group" aria-label={t("초안 채널")}>
            {channels.map((ch) => {
              const ls = langsOf(ch);
              const live = ls.map((l) => [...(draftsByTarget.get(targetKey(ch, l)) ?? [])].sort((a, b) => b.version - a.version).find((d) => d.status !== "dropped")).filter(Boolean) as Draft[];
              const pub = live.length === ls.length && live.every((d) => publications.some((p) => p.draftId === d.id));
              // 기호는 눈으로 훑기용이고, 화면 낭독기에는 같은 뜻을 글로 준다.
              const [st, stText] = pub ? ["✓", t("게시함")] : live.length === ls.length ? (live.every((d) => d.lint.every((l) => l.ok)) ? ["●", t("초안 준비됨")] : ["!", t("확인할 부분 있음")]) : live.length ? [`${live.length}/${ls.length}`, t("언어 {total}개 중 {n}개 초안 있음", { total: ls.length, n: live.length })] : busy === "draft" || stage.busy ? ["…", t("쓰는 중")] : ["", ""];
              return <button key={ch} aria-pressed={tab === ch} className={tab === ch ? "active" : ""} onClick={() => switchDraft(() => setTab(ch))}><ChannelIcon channel={ch} />{channelLabel(ch)}{st && <><span className="st" aria-hidden title={stText}>{st}</span><span className="sr-only">, {stText}</span></>}</button>;
            })}
          </div>
          {!channels.length && <div className="state-panel"><h2>{t("게시할 채널을 먼저 골라주세요")}</h2><p>{t("초안을 만들 채널과 언어를 하나 이상 선택하면 시작할 수 있어요.")}</p><Link className="btn primary" to="/settings?tab=channels">{t("채널 선택하기")}</Link></div>}
          {current && curKey && (
            <DraftPanel key={`${cid}:${curKey}`} cid={cid} channel={current.channel} lang={current.lang} langs={curLangs} onDirty={setUnsaved} onLang={(l) => switchDraft(() => setLangByCh({ ...langByCh, [current.channel]: l }))} expectedModel={settings?.llm.provider === "gemini" ? (settings.llm.draftModel || DEFAULT_DRAFT_MODEL.gemini) : undefined} draftModelResetAt={keys ? keys.filter((k) => k.label.endsWith(settings?.llm.draftModel || DEFAULT_DRAFT_MODEL.gemini || "") && k.cooldownUntil).map((k) => k.cooldownUntil!).sort()[0] : undefined}
              drafts={draftsByTarget.get(curKey) ?? []} publications={publications.filter((p) => p.channel === current.channel && (p.lang ?? current.lang) === current.lang)}
              busy={busy === `draft:${curKey}` || busy === "draft"} showToast={showToast} homepage={e.homepage} track={settings?.trackLinks !== false} onRedraft={(instruction, introduction) => redraft([current], instruction, `draft:${curKey}`, introduction)} />
          )}
          <VideoBlock cid={cid} repo={c.repo} drafts={data.drafts} />
        </section>

        <aside className="cand-side">
          <details className="context-details"><summary>{t("프로젝트 배경과 문체 참고")}</summary><ProfileBlock repo={c.repo} view={profile} showToast={showToast} /></details>
          <section className="side-block">
            <h2>{t("무엇이 달라졌나")}</h2>
            {e.highlights?.length ? <ul className="hl check">{e.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul> : <p className="small muted" style={{ margin: 0 }}>{stage.busy ? t("다이제스트를 만드는 중입니다.") : t("초안 만들기를 누르면 이 글감의 변경 내용을 먼저 정리합니다.")}</p>}
            {e.unverifiedHighlights?.length ? <details className="raw"><summary>{t("원자료에서 확인하지 못해 뺀 요약 {n}개", { n: e.unverifiedHighlights.length })}</summary>
              <p className="tiny muted">{t("요약에 원자료에 없는 수치가 있어 판단과 초안에 넘기지 않았습니다. 맞는 내용이면 원자료(릴리스 노트 등)에 수치를 적은 뒤 다시 분석해 주세요.")}</p>
              <ul className="hl small">{e.unverifiedHighlights.map((h, i) => <li key={i}>{h.text} <span className="badge warn">{h.numbers.join(", ")}</span></li>)}</ul>
            </details> : null}
            {e.ompSummary && <details className="raw"><summary>{t("에이전트 세션 요약")}</summary><pre className="evidence">{e.ompSummary}</pre></details>}
            {told.length > 0 && (
              <details className="raw"><summary>{t("이 저장소에서 이미 다룬 변경 {n}개 · 발행 {published}개", { n: told.length, published: told.filter((x) => x.publishedAt).length })}</summary>
                <ul className="hl small told">{told.map((x, i) => <li key={i} className={x.publishedAt ? "pub" : ""}>{x.text}{x.publishedAt && <span className="badge ok" style={{ marginLeft: 6 }}>{t("{channel} 발행", { channel: x.publishedChannel ?? "" })}</span>}</li>)}</ul>
              </details>
            )}
          </section>

          <section className="side-block">
            <h2>{t("사실")}</h2>
            <dl className="kv">
              {e.stars !== undefined && <><dt>{t("스타")}</dt><dd>{e.stars}</dd></>}
              {e.forks !== undefined && <><dt>{t("포크")}</dt><dd>{e.forks}</dd></>}
              {e.commitCount !== undefined && <><dt>{t("커밋")}</dt><dd>{e.commitCount}</dd></>}
              {e.releaseCount !== undefined && <><dt>{t("릴리스")}</dt><dd>{e.releaseCount}{e.version ? ` · ${t("최신")} ${e.version}` : ""}</dd></>}
              {e.firstReleaseAt && <><dt>{t("첫 릴리스")}</dt><dd>{e.firstReleaseAt}</dd></>}
              {e.npmPackage && <><dt>npm</dt><dd>{e.npmPackage} · {e.npmMonthlyDownloads}/{t("월")}</dd></>}
              {(e.language || e.license) && <><dt>{t("언어 · 라이선스")}</dt><dd>{[e.language, e.license].filter(Boolean).join(" · ")}</dd></>}
              {e.milestones?.length ? <><dt>{t("이번 창 임계")}</dt><dd>{e.milestones.map((m) => `${m.metric === "stars" ? t("스타") : t("다운로드")} ${m.threshold}`).join(" · ")}</dd></> : null}
              <dt>{t("데모")}</dt><dd className={e.demoAsset ? "" : "muted"}>{e.demoAsset ? e.demoAsset.split("/").pop() : t("없음 (올리기 전 GIF나 스크린샷을 준비하세요)")}</dd>
            </dl>
            <h2 style={{ marginTop: 14 }}>{t("한계")}</h2>
            {e.limitations?.length ? e.limitations.map((l, i) => <div key={i} className="callout" style={{ marginTop: i ? 6 : 0 }}>{l}</div>) : <div className="callout muted-box">{t("수집한 자료에 명시된 한계가 없습니다. 게시 전에 알려진 제약이 있는지 직접 확인하세요.")}</div>}
          </section>

          <LaunchCheckBlock cid={cid} homepage={e.homepage} />

          {j && (
            <section className="side-block">
              <h2>{t("판단 이유")}</h2>
              <p className="small" style={{ lineHeight: 1.65, margin: 0 }}>{reasoning}</p>
              <div className="meta-line"><code>{j.model.split("@")[0].replace("gemini/", "")}</code><span>{fmtDate(j.createdAt)}</span></div>
            </section>
          )}

          <section className="side-block">
            <details className="raw"><summary>{t("원자료 · 릴리스 노트, 머지된 PR, 커밋 제목")}</summary>
              <pre className="evidence">{[e.releaseNotes && `${t("릴리스 노트")}\n${e.releaseNotes}`, e.mergedPrTitles?.length && `${t("머지된 PR")}\n- ${e.mergedPrTitles.join("\n- ")}`, e.commitSubjects?.length && `${t("커밋")}\n- ${e.commitSubjects.slice(0, 40).join("\n- ")}`].filter(Boolean).join("\n\n") || t("(없음)")}</pre>
            </details>
          </section>

          {publications.length > 0 && (
            <section className="side-block">
              <h2>{t("발행됨")}</h2>
              <div className="stack small">{publications.map((p) => <div key={p.id} className="row between"><span className="row" style={{ gap: 6 }}><ChannelIcon channel={p.channel} size={14} />{channelLabel(p.channel)}</span><a href={p.url} target="_blank" rel="noreferrer">{p.url.replace(/^https?:\/\//, "").slice(0, 40)}</a><span className="muted">{fmtDate(p.publishedAt)}</span></div>)}</div>
            </section>
          )}
        </aside>
      </div>
      <Toast msg={toast} />
    </>
  );
}
