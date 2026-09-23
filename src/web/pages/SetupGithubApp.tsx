import { useState } from "react";
import { post, useResource } from "../lib/api";
import { t } from "../i18n";

/** 서버 운영자만 시작할 수 있는 일회용 매니페스트 등록 흐름. */
export default function SetupGithubApp() {
  const { data: app } = useResource<{ configured: boolean; slug?: string; canConfigure: boolean }>("/github/app", []);
  const [organization, setOrganization] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!app) return null;
  if (app.configured) return <div className="card" style={{ maxWidth: 640 }}><h3>{t("GitHub App 준비됨")}</h3><p className="small muted">slug <code>{app.slug}</code>. {t("사용자는 연결 화면에서 \"GitHub 권한 허용\"으로 설치합니다.")}</p></div>;
  if (!app.canConfigure) return <div className="card"><h3>{t("운영자 권한이 필요합니다")}</h3><p>{t("서버 운영자로 지정된 계정으로 로그인해 주세요.")}</p></div>;
  return (
    <div className="card stack" style={{ maxWidth: 640 }}>
      <h3>{t("이 서버의 GitHub App 만들기")}</h3>
      <p className="small muted">{t("GitHub에서 앱을 만들면 이 서버에 연결됩니다. 조직 소유로 만들려면 조직 이름을 입력하세요.")}</p>
      <form method="post" onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        setBusy(true); setError(null);
        try {
          const setup = await post<{ manifest: Record<string, unknown>; createUrl: string }>("/github/app/setup");
          const url = new URL(setup.createUrl);
          if (organization.trim()) url.pathname = `/organizations/${encodeURIComponent(organization.trim())}/settings/apps/new`;
          form.action = url.toString();
          (form.elements.namedItem("manifest") as HTMLInputElement).value = JSON.stringify(setup.manifest);
          form.submit();
        } catch (err) { setError((err as Error).message); setBusy(false); }
      }}>
        <input type="hidden" name="manifest" />
        <div className="row"><input placeholder={t("조직 이름 (개인 계정이면 비움)")} value={organization} onChange={(event) => setOrganization(event.target.value)} pattern="[A-Za-z0-9-]+" /><button className="primary" type="submit" disabled={busy}>{busy ? t("준비 중…") : t("GitHub에서 만들기")}</button></div>
      </form>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
