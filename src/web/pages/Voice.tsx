import { useState } from "react";
import { ALL_CHANNELS, CHANNELS, LANGS, type Channel } from "@core/channels";
import { SAMPLE_WORK, VOICE_PRESETS } from "@core/voice";
import type { Example, GuideSuggestion, LearningBucket, LearningStats, SettingsView } from "@shared/types";
import { channelLabel, ErrorState, Skeleton, Toast, relTime, useToast, langLabel } from "../components/ui";
import { del, patch, post, useResource } from "../lib/api";
import { getLocale, t } from "../i18n";

/**
 * 문체. 위: 프리셋과 내 지침(초안 프롬프트에 들어가는 것). 가운데: 학습 효과. 아래: 예시 문장(복사한 초안에서 생기고, 켜 두면 프롬프트에 붙는다).
 * 문체를 예시에서 유추하게 두면 어느 문장 때문에 그렇게 나왔는지 알 수 없다. 지침이 먼저고 예시는 보조다.
 */
const CAT_LABEL: Record<string, string> = { voice: "말투", structure: "구성", facts: "사실", format: "형식" };

export default function Voice() {
  const { data: examples, error: examplesError, reload: reloadExamples } = useResource<Example[]>("/examples", ["examples"]);
  const { data: settings, error, reload } = useResource<SettingsView>("/settings", ["settings"]);
  const { data: suggestions } = useResource<GuideSuggestion[]>("/suggestions", ["settings"]);
  const [guide, setGuide] = useState<string | null>(null);
  const [sampleLang, setSampleLang] = useState<"ko" | "en">(getLocale());
  const [openSample, setOpenSample] = useState<string | null>(null);
  const [ch, setCh] = useState<Channel | "all">("all");
  const [openId, setOpenId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ channel: Channel; lang: string; title: string; body: string }>({
    channel: "x",
    lang: "en",
    title: "",
    body: "",
  });
  const [toast, showToast] = useToast();
  if (error || examplesError)
    return (
      <ErrorState
        message={error ?? examplesError!}
        onRetry={() => {
          reload();
          reloadExamples();
        }}
      />
    );
  if (!examples) return <Skeleton rows={4} />;
  const list = examples.filter((e) => ch === "all" || e.channel === ch);
  const own = examples.filter((e) => e.source !== "seed" && e.active).length;
  const seed = examples.filter((e) => e.source === "seed" && e.active).length;
  const voice = settings?.voice;
  /** 요청 하나. 실패하면 조용히 넘어가지 않고 알린다. 성공 여부를 돌려준다. */
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) showToast(done);
      return true;
    } catch (err) {
      showToast(`${t("저장하지 못했습니다.")} ${(err as Error).message}`);
      return false;
    }
  };
  const saveVoice = async (next: Partial<NonNullable<typeof voice>>) => {
    if (!voice) return false;
    return act(
      () => patch("/settings", { voice: { ...voice, ...next, chosenAt: voice.chosenAt ?? Date.now() } }),
      t("문체를 저장했습니다. 다음 초안부터 적용됩니다."),
    );
  };

  return (
    <>
      <header className="page-head workspace-head">
        <div>
          <h1>{t("문체")}</h1>
          <p className="lede">
            {t("초안이 어떤 말투로 쓰일지 정합니다. 프리셋 하나를 고르고, 필요하면 내 지침을 덧붙입니다. 예시 문장은 선택입니다.")}
          </p>
        </div>
      </header>

      {voice && (
        <div className="card stack gap-14 mb-20">
          <div>
            <div className="row between wrap gap-8 mb-8">
              <h3 className="m-0">{t("프리셋")}</h3>
              <div className="row gap-8">
                <span className="tiny muted">{t("샘플 언어")}</span>
                <div className="lang-seg">
                  {(["ko", "en"] as const).map((l) => (
                    <button key={l} className={sampleLang === l ? "on" : ""} onClick={() => setSampleLang(l)}>
                      {l.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="sample-work">
              <b>{t("같은 작업물, 다른 문체")}</b>
              <span className="muted">
                {SAMPLE_WORK.name}: {t(SAMPLE_WORK.what)}
              </span>
              <div className="facts">
                {SAMPLE_WORK.facts.map((f) => (
                  <span key={f} className="badge">
                    {t(f)}
                  </span>
                ))}
              </div>
            </div>
            <div className="presets">
              {VOICE_PRESETS.map((p) => (
                <div key={p.id} className={`preset ${voice.preset === p.id ? "on" : ""}`}>
                  <button className="preset-pick" onClick={() => void saveVoice({ preset: p.id })}>
                    <b>{t(p.name)}</b>
                    <span>{t(p.description)}</span>
                  </button>
                  <div className="preset-sample">{p.sample[sampleLang]}</div>
                  <button className="ghost sm" onClick={() => setOpenSample(openSample === p.id ? null : p.id)}>
                    {openSample === p.id ? t("지침 닫기") : t("지침 보기")}
                  </button>
                  {openSample === p.id && <div className="sample">{sampleLang === "ko" ? p.ko : p.en}</div>}
                </div>
              ))}
            </div>
          </div>
          <div>
            <h3 className="mb-4">
              {t("내 지침")} <span className="tiny muted">{t("선택 · 프리셋보다 우선")}</span>
            </h3>
            <p className="small muted mb-8">
              {t(
                '글마다 반복해서 고치던 것을 여기 적어 두세요. 예: "링크는 항상 마지막 줄에", "회사 이름은 쓰지 않기", "영어 글에서는 I 대신 we".',
              )}
            </p>
            <textarea
              value={guide ?? voice.guide}
              onChange={(ev) => setGuide(ev.target.value)}
              placeholder={t("비워 두면 프리셋 지침만 씁니다.")}
              className="guide-input"
            />
            <div className="row between wrap gap-8 mt-8">
              <label className="row small gap-6 use-examples-toggle">
                <input type="checkbox" checked={voice.useExamples} onChange={(ev) => void saveVoice({ useExamples: ev.target.checked })} />{" "}
                {t("내가 복사한 글을 문체 예시로 프롬프트에 붙이기")}
              </label>
              <button
                className="primary"
                disabled={guide === null || guide === voice.guide}
                onClick={async () => {
                  if (await saveVoice({ guide: guide ?? "" })) setGuide(null);
                }}
              >
                {t("지침 저장")}
              </button>
            </div>
          </div>
        </div>
      )}

      {suggestions && suggestions.length > 0 && (
        <div className="card stack gap-10 mb-20 suggestions-card">
          <div>
            <h3 className="m-0">
              {t("지침 제안")} <span className="tiny muted">{t("수정과 버림에서 배운 것 · 승인하면 내 지침에 붙습니다")}</span>
            </h3>
          </div>
          <div className="stack gap-6">
            {suggestions.map((g) => (
              <div key={g.id} className="sugg">
                <div className="min-w-0">
                  <div className="small sugg-rule">{g.rule}</div>
                  <div className="tiny muted">
                    {t(CAT_LABEL[g.category] ?? g.category)} · {t("{n}번 관찰 · 마지막 {when}", { n: g.count, when: relTime(g.updatedAt) })}
                  </div>
                </div>
                <span className="toolbar">
                  <button
                    className="sm primary"
                    onClick={() => void act(() => post(`/suggestions/${g.id}/accept`), t("지침에 추가했습니다."))}
                  >
                    {t("지침에 추가")}
                  </button>
                  <button className="ghost sm" onClick={() => void act(() => post(`/suggestions/${g.id}/dismiss`))}>
                    {t("무시")}
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <LearningPanel />

      <div className="page-head mt-8">
        <div>
          <h2 className="examples-title">
            {t("예시 문장")}{" "}
            <span className="tiny muted">{voice?.useExamples ? t("프롬프트에 참고로 들어감") : t("지금은 프롬프트에 들어가지 않음")}</span>
          </h2>
          <p className="lede small">
            {t(
              "내 예시 {own}개 · 참고 예시 {seed}개. 복사한 초안이 내 예시가 됩니다(금지 표현·이모지 글머리·빈칸 표시·원자료에 없는 수치나 주장·저장소 이름·용어 섞임 같은 점검 경고가 남은 글은 제외). 채널마다 내 예시가 2개 이상이면 그것만 쓰고, 최근 8개까지 남깁니다.",
              { own, seed },
            )}
          </p>
        </div>
        <div className="toolbar">
          <button onClick={() => setAdding((a) => !a)}>{adding ? t("닫기") : t("예시 직접 추가")}</button>
        </div>
      </div>
      {adding && (
        <div className="card stack mb-16">
          <div className="row">
            <select
              value={draft.channel}
              onChange={(ev) => {
                const c = ev.target.value as Channel;
                setDraft({ ...draft, channel: c, lang: CHANNELS[c].fixedLang ?? draft.lang });
              }}
            >
              {ALL_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {channelLabel(c)}
                </option>
              ))}
            </select>
            <select
              value={draft.lang}
              disabled={Boolean(CHANNELS[draft.channel].fixedLang)}
              onChange={(ev) => setDraft({ ...draft, lang: ev.target.value })}
            >
              {Object.keys(LANGS).map((l) => (
                <option key={l} value={l}>
                  {langLabel(l)}
                </option>
              ))}
            </select>
            {CHANNELS[draft.channel].hasTitle && (
              <input placeholder={t("제목")} value={draft.title} onChange={(ev) => setDraft({ ...draft, title: ev.target.value })} />
            )}
          </div>
          <textarea
            placeholder={t("내가 실제로 올렸거나 올리고 싶은 문장")}
            value={draft.body}
            onChange={(ev) => setDraft({ ...draft, body: ev.target.value })}
            className="example-input"
          />
          <div>
            <button
              className="primary"
              disabled={!draft.body.trim()}
              onClick={async () => {
                if (
                  await act(
                    () =>
                      post("/examples", { channel: draft.channel, lang: draft.lang, title: draft.title || undefined, body: draft.body }),
                    t("추가했습니다"),
                  )
                ) {
                  setDraft({ ...draft, body: "", title: "" });
                  setAdding(false);
                }
              }}
            >
              {t("추가")}
            </button>
          </div>
        </div>
      )}
      <div className="chtabs">
        <button className={ch === "all" ? "active" : ""} onClick={() => setCh("all")}>
          {t("전체")}
          <span className="st">{examples.length}</span>
        </button>
        {ALL_CHANNELS.map((c) => (
          <button key={c} className={ch === c ? "active" : ""} onClick={() => setCh(c)}>
            {channelLabel(c)}
            <span className="st">{examples.filter((e) => e.channel === c).length || ""}</span>
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <div className="empty small">{t("이 채널의 예시가 없습니다.")}</div>
      ) : (
        <div className="rows">
          {list.map((e) => (
            <div key={e.id} className="rowi example-row">
              <div className="min-w-0">
                <div className="row wrap gap-6 mb-2">
                  <span className="badge outline">
                    {channelLabel(e.channel)} · {e.lang.toUpperCase()}
                  </span>
                  <span className={`badge ${e.source === "seed" ? "" : "ok"}`}>
                    {e.source === "seed" ? t("참고") : e.source === "edited" ? t("내가 고침") : t("내가 승인")}
                  </span>
                  {!e.active && <span className="badge bad">{t("비활성")}</span>}
                  <span className="tiny muted">
                    {relTime(e.createdAt)}
                    {e.note ? ` · ${e.note}` : ""}
                  </span>
                </div>
                <div className={openId === e.id ? "draft-body mt-6" : "r"} onClick={() => setOpenId(openId === e.id ? null : e.id)}>
                  {e.title ? `${e.title} — ` : ""}
                  {e.body}
                </div>
              </div>
              <div className="toolbar">
                <button className="ghost sm" onClick={() => void act(() => post(`/examples/${e.id}/active`, { active: !e.active }))}>
                  {e.active ? t("끄기") : t("켜기")}
                </button>
                <button className="ghost sm danger" onClick={() => void act(() => del(`/examples/${e.id}`))}>
                  {t("삭제")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <Toast msg={toast} />
    </>
  );
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const BucketLine = ({ b }: { b: LearningBucket }) => (
  <span className="mono">
    {t("그대로 {unchanged} · 고친 글 평균 수정량 {edited} · {n}건", {
      unchanged: pct(b.unchangedRate),
      edited: b.avgEditRatio === undefined ? "—" : pct(b.avgEditRatio),
      n: b.copied,
    })}
  </span>
);

/**
 * 학습 효과. 복사한 초안을 얼마나 고쳤는지. 문체 설정을 바꾸거나 제안을 승인한 뒤 "고친 양"이 줄어야 학습이 된 것이다.
 * 표본이 적으면 흔들리므로 건수를 같이 보여준다.
 */
function LearningPanel() {
  const { data } = useResource<LearningStats>("/learning/stats", ["drafts", "settings", "examples"]);
  if (!data || data.copied === 0) return null;
  const weeks = data.byWeek.slice(-8);
  return (
    <div className="card stack gap-10 mb-20">
      <div>
        <h3 className="m-0">
          {t("학습 효과")} <span className="tiny muted">{t("복사한 초안 {n}건 기준", { n: data.copied })}</span>
        </h3>
        <p className="small muted learning-intro">
          {t("실제 복사한 초안만 집계합니다. 링크만 등록한 글과 외부에서의 수정은 포함하지 않습니다.")}{" "}
          {t(
            "초안을 고치지 않고 그대로 쓴 비율과, 고친 글만 놓고 원문 대비 바꾼 단어 비율의 평균입니다. 지침·예시가 쌓일수록 그대로 쓴 비율은 늘고 수정량은 줄어야 합니다.",
          )}
        </p>
      </div>
      <div className="perf-row">
        <b>{t("전체")}</b>
        <BucketLine b={data} />
      </div>
      {weeks.length > 1 && (
        <div className="stack gap-4">
          <span className="tiny muted">{t("주별")}</span>
          {weeks.map((w) => (
            <div key={w.week} className="perf-row small">
              <span>{w.week}</span>
              <BucketLine b={w} />
            </div>
          ))}
        </div>
      )}
      {data.byStyle.length > 1 && (
        <div className="stack gap-4">
          <span className="tiny muted">{t("문체 설정 버전별 (처음 쓴 순서)")}</span>
          {data.byStyle.map((g, i) => (
            <div key={g.styleKey} className="perf-row small">
              <span>
                {g.styleKey === "unknown" ? t("기록 전") : t("설정 {n}", { n: i + 1 })}
                {g.current ? ` · ${t("지금")}` : ""} <span className="muted">{t("{when}부터", { when: relTime(g.firstAt) })}</span>
              </span>
              <BucketLine b={g} />
            </div>
          ))}
        </div>
      )}
      <span className="tiny muted">
        {t("지침 {lines}줄 · 활성 내 예시 {examples}개", { lines: data.guideLines, examples: data.activeOwnExamples })}
      </span>
    </div>
  );
}
