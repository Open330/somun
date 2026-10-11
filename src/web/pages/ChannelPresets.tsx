import { useEffect, useState } from "react";
import { ALL_CHANNELS, channelCatalog, channelSpec, type BuiltinChannel, type CustomChannel } from "@core/channels";
import type { SettingsView } from "@shared/types";
import { t } from "../i18n";

type Props = { settings: SettingsView; onSave: (patch: Record<string, unknown>) => Promise<boolean>; onDirty: (dirty: boolean) => void };
/** 계정별 프리셋: 기존 채널을 복제하고 독자와 편집 목적에 맞춰 조정한다. */
export default function ChannelPresets({ settings, onSave, onDirty }: Props) {
  const [form, setForm] = useState<CustomChannel | null>(null);
  const [original, setOriginal] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [base, setBase] = useState<BuiltinChannel>("threads");
  const dirty = form !== null && JSON.stringify(form) !== original;
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  const begin = (preset: BuiltinChannel, existing?: CustomChannel) => {
    const spec = channelSpec(preset);
    const next: CustomChannel = existing ?? {
      ...spec,
      id: `custom_${crypto.randomUUID()}`,
      label: "",
      fixedLang: undefined,
      identity: spec.identity!,
    };
    setBase(preset);
    setForm(next);
    setOriginal(JSON.stringify(next));
  };
  const cancel = () => {
    setForm(null);
    setOriginal("");
  };
  return (
    <section className="stack gap-12">
      <h3>{t("채널 정체성 프리셋")}</h3>
      <p className="small muted">{t("독자·목적·어조·구조를 확인하고 내 채널로 복제하세요. 개인 프리셋은 이 계정에만 저장됩니다.")}</p>
      {channelCatalog(settings.customChannels).map((spec) => (
        <details key={spec.id} className="card">
          <summary>
            <b>{spec.label}</b>
            {spec.id.startsWith("custom_") ? ` · ${t("개인 프리셋")}` : ""}
          </summary>
          {spec.identity && (
            <dl>
              {[
                [t("독자"), spec.identity.audience],
                [t("목적"), spec.identity.purpose],
                [t("어조"), spec.identity.tone],
                [t("구조"), spec.identity.structure],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="small muted">{t(label)}</dt>
                  <dd className="m-0 small">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          <button
            className="ghost sm"
            disabled={busy || form !== null}
            onClick={() => (spec.id.startsWith("custom_") ? begin("threads", spec as CustomChannel) : begin(spec.id as BuiltinChannel))}
          >
            {spec.id.startsWith("custom_") ? t("프리셋 수정") : t("내 채널로 복제")}
          </button>
        </details>
      ))}
      {!form && (
        <button className="ghost" onClick={() => begin("threads")}>
          {t("커스텀 채널 추가")}
        </button>
      )}
      {form && (
        <form
          className="card stack gap-12"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            try {
              const presets = settings.customChannels ?? [];
              const next = presets.some((p) => p.id === form.id) ? presets.map((p) => (p.id === form.id ? form : p)) : [...presets, form];
              const { fixedLang: _fixed, ...preset } = form;
              void _fixed;
              const clean = next.map((p) => (p.id === form.id ? preset : p));
              if (
                await onSave({
                  customChannels: clean,
                  channelLangs: { ...settings.channelLangs, [form.id]: settings.channelLangs[form.id] ?? form.defaultLangs },
                })
              )
                cancel();
            } finally {
              setBusy(false);
            }
          }}
        >
          <h3>{t("내 채널 프리셋")}</h3>
          {!settings.customChannels?.some((p) => p.id === form.id) && (
            <label className="field">
              <span>{t("시작 프리셋")}</span>
              <select
                value={base}
                onChange={(e) => {
                  const chosen = e.target.value as BuiltinChannel;
                  const spec = channelSpec(chosen);
                  setBase(chosen);
                  setForm({ ...spec, id: form.id, label: form.label, fixedLang: undefined, identity: spec.identity! });
                }}
              >
                {ALL_CHANNELS.map((id) => (
                  <option key={id} value={id}>
                    {channelSpec(id).label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>{t("채널 이름")}</span>
            <input autoFocus required maxLength={80} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </label>
          {(
            [
              ["audience", t("대상 독자")],
              ["purpose", t("채널 목적")],
              ["tone", t("채널 어조")],
              ["structure", t("글 구조")],
            ] as const
          ).map(([key, label]) => (
            <label className="field" key={key}>
              <span>{t(label)}</span>
              <textarea
                required
                maxLength={key === "structure" ? 1000 : 500}
                rows={2}
                value={form.identity[key]}
                onChange={(e) => setForm({ ...form, identity: { ...form.identity, [key]: e.target.value } })}
              />
            </label>
          ))}
          <label className="field">
            <span>{t("추가 작성 규칙")}</span>
            <textarea required maxLength={4000} rows={4} value={form.rules} onChange={(e) => setForm({ ...form, rules: e.target.value })} />
          </label>
          <label className="field">
            <span>{t("미디어 안내")}</span>
            <textarea maxLength={500} rows={2} value={form.mediaHint} onChange={(e) => setForm({ ...form, mediaHint: e.target.value })} />
          </label>
          <label className="field">
            <span>{t("게시 전 체크리스트 (한 줄에 하나)")}</span>
            <textarea
              rows={4}
              value={form.runbook.join("\n")}
              onChange={(e) => setForm({ ...form, runbook: e.target.value.split("\n") })}
            />
          </label>
          <label className="field">
            <span>{t("최대 글자 수")}</span>
            <input
              type="number"
              min={100}
              max={30000}
              value={form.maxChars ?? ""}
              onChange={(e) => setForm({ ...form, maxChars: e.target.value ? Number(e.target.value) : null })}
            />
          </label>
          <label className="row gap-8">
            <input
              type="checkbox"
              checked={form.hasTitle}
              onChange={(e) =>
                setForm({ ...form, hasTitle: e.target.checked, titleMaxChars: e.target.checked ? (form.titleMaxChars ?? 80) : undefined })
              }
            />
            {t("제목 사용")}
          </label>
          {form.hasTitle && (
            <label className="field">
              <span>{t("제목 최대 글자 수")}</span>
              <input
                type="number"
                required
                min={10}
                max={300}
                value={form.titleMaxChars ?? 80}
                onChange={(e) => setForm({ ...form, titleMaxChars: Number(e.target.value) })}
              />
            </label>
          )}
          <label className="field">
            <span>{t("링크 위치")}</span>
            <select
              value={form.linkPlacement ?? "body"}
              onChange={(e) => setForm({ ...form, linkPlacement: e.target.value as "body" | "reply" | "none" })}
            >
              <option value="body">{t("본문")}</option>
              <option value="reply">{t("첫 답글")}</option>
              <option value="none">{t("링크 생략")}</option>
            </select>
          </label>
          <label className="field">
            <span>{t("작성 화면 URL (선택)")}</span>
            <input type="url" value={form.composeUrl} onChange={(e) => setForm({ ...form, composeUrl: e.target.value })} />
          </label>
          <p className="small muted">
            {t("저장하면 채널 목록에서 사용할 언어를 바꾸거나 사용을 끌 수 있습니다. 글은 복사해서 직접 게시합니다.")}
          </p>
          <div className="row gap-8">
            <button disabled={busy || !form.label.trim()} type="submit">
              {busy ? t("저장 중…") : t("프리셋 저장")}
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={cancel}>
              {t("취소")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
