import { useEffect } from "react";
import type { SettingsView } from "@shared/types";
import { clearPendingChoice, getLocale, hasPendingChoice, LOCALES, setLocale, t, useLocale, type Locale } from "../i18n";
import { patch } from "../lib/api";
import { hasUnsaved } from "../lib/unsaved";

/** 화면 언어 선택. 바꾸면 화면 전체를 새 언어로 다시 그리므로, 저장하지 않은 수정이 있으면 먼저 묻는다. */
export function LocaleSwitch({ compact }: { compact?: boolean }) {
  const locale = useLocale();
  const change = (select: HTMLSelectElement) => {
    const next = select.value as Locale;
    // 취소하면 목록도 지금 언어로 되돌린다(상태가 바뀌지 않아 다시 그려지지 않으므로).
    if (hasUnsaved() && !window.confirm(t("저장하지 않은 수정 내용이 있습니다. 언어를 바꾸면 사라집니다. 바꿀까요?"))) { select.value = locale; return; }
    setLocale(next);
  };
  return (
    <label className={`locale-switch ${compact ? "compact" : ""}`}>
      <span className={compact ? "sr-only" : "small muted"}>{t("화면 언어")}</span>
      <select value={locale} onChange={(ev) => change(ev.target)} aria-label={t("화면 언어")}>
        {LOCALES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
      </select>
    </label>
  );
}

/** 페이지를 연 뒤 계정 언어와 처음 맞췄는지. 다시 그려도(언어 변경) 유지된다. */
let adopted = false;
/** 테스트용: 새 페이지를 연 것처럼 되돌린다. */
export const resetLocaleSync = (): void => { adopted = false; };

/**
 * 계정 언어(ui.locale)와 화면 언어 맞추기. 로그인한 화면의 뿌리에서 한 번만 쓴다.
 *  - 사용자가 직접 고른 언어가 저장 전이면(랜딩에서 고른 것 포함) 그것을 계정에 저장한다. 저장이 끝나야 표시를 지운다.
 *  - 계정에 언어가 없으면 지금 언어를 저장한다.
 *  - 그 밖에는 페이지를 연 뒤 처음 한 번만 계정 언어를 따른다(다른 기기에서 정한 언어). 수정 중이면 따르지 않는다.
 */
export function useAccountLocaleSync(settings: SettingsView | undefined): void {
  useEffect(() => {
    if (!settings) return;
    const saved = settings.ui?.locale;
    if (hasPendingChoice() || !saved) {
      const locale = getLocale();
      if (saved !== locale) void patch("/settings", { ui: { locale } }).then(clearPendingChoice).catch(() => undefined);
      else clearPendingChoice();
    } else if (!adopted && saved !== getLocale() && !hasUnsaved()) {
      setLocale(saved, { choice: false });
    }
    adopted = true;
  }, [settings]);
}
