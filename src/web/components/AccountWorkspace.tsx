import { useEffect, useState, type ReactNode } from "react";
import type { AccountWorkspaces, WorkspaceView } from "@shared/workspaces";
import { api, ApiError } from "../lib/api";
import { rememberWorkspace } from "../lib/workspaces";
import { t } from "../i18n";

export function workspaceLabel(workspace: WorkspaceView): string {
  const id = workspace.ownerId.slice(workspace.ownerId.lastIndexOf("|") + 1);
  return `${workspace.primary ? t("기본 계정 공간") : t("연결된 계정 공간")} · ${id.slice(-8)}${workspace.hasData ? "" : ` · ${t("비어 있음")}`}`;
}

/** Bootstrap and pin the resolved workspace before any content, forms, or event subscriptions mount. */
export function AccountWorkspace({ children }: { children: (account: AccountWorkspaces) => ReactNode }) {
  const [account, setAccount] = useState<AccountWorkspaces | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(false);
    const load = async () => {
      let result: AccountWorkspaces;
      try {
        const requested = new URLSearchParams(window.location.search).get("workspace");
        result = await api<AccountWorkspaces>("/me", requested ? { headers: { "X-Somun-Workspace": requested } } : {});
      } catch (e) {
        // An alias can be revoked after this tab last selected it. Rediscover rather than trapping the user.
        if (!(e instanceof ApiError) || e.status !== 403) throw e;
        result = await api<AccountWorkspaces>("/me", { headers: { "X-Somun-Workspace": "" } });
      }
      if (cancelled) return;
      rememberWorkspace(result.accountId, result.ownerId);
      if (new URLSearchParams(window.location.search).has("workspace"))
        window.history.replaceState(window.history.state, "", window.location.pathname);
      setAccount(result);
    };
    void load().catch(() => {
      if (!cancelled) setError(true);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  if (error)
    return (
      <div className="booting" role="alert">
        <p>{t("작업 공간을 불러오지 못했습니다.")}</p>
        <button onClick={() => setAttempt((n) => n + 1)}>{t("다시 시도")}</button>
      </div>
    );
  if (!account)
    return (
      <div className="booting" role="status">
        {t("불러오는 중…")}
      </div>
    );
  return children(account);
}

export function WorkspacePicker({ account }: { account: AccountWorkspaces }) {
  if (account.workspaces.length < 2) return null;
  return (
    <section className="card stack workspace-picker" aria-label={t("작업 공간 전환")}>
      <label className="row wrap">
        <b>{t("작업 공간")}</b>
        <select
          aria-label={t("작업 공간 전환")}
          value={account.ownerId}
          onChange={(event) => {
            if (!account.workspaces.some((workspace) => workspace.ownerId === event.target.value)) return;
            // A new document discards all in-flight views, form state, caches and the old SSE connection.
            window.location.assign(`/?workspace=${encodeURIComponent(event.target.value)}`);
          }}
        >
          {account.workspaces.map((workspace) => (
            <option key={workspace.ownerId} value={workspace.ownerId}>
              {workspaceLabel(workspace)}
            </option>
          ))}
        </select>
      </label>
      <p className="small muted">{t("각 공간의 설정과 초안은 따로 보관됩니다. 전환하면 글감 화면으로 이동합니다.")}</p>
    </section>
  );
}
