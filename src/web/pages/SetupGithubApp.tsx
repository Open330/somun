import { useResource } from "../lib/api";

/** 운영자 전용 (내비에 없음). 이 서버의 GitHub App을 매니페스트로 한 번 만든다. */
export default function SetupGithubApp() {
  const { data: app } = useResource<{ configured: boolean; slug?: string; manifest?: Record<string, unknown>; createUrl: string }>("/github/app", []);
  if (!app) return null;
  if (app.configured) return <div className="card" style={{ maxWidth: 640 }}><h3>GitHub App 준비됨</h3><p className="small muted">slug <code>{app.slug}</code>. 사용자는 연결 화면에서 "GitHub 권한 허용"으로 설치합니다.</p></div>;
  return (
    <div className="card stack" style={{ maxWidth: 640 }}>
      <h3>이 서버의 GitHub App 만들기</h3>
      <p className="small muted">한 번만 합니다. 제출하면 GitHub가 앱을 만들고 자격 증명(앱 ID, 키, webhook 비밀)을 이 서버에 돌려줍니다. 조직 소유로 만들려면 폼의 action을 <code>https://github.com/organizations/&lt;org&gt;/settings/apps/new</code>로 바꾸세요.</p>
      <form method="post" action={app.createUrl} id="gh-app-form">
        <input type="hidden" name="manifest" value={JSON.stringify(app.manifest ?? {})} />
        <div className="row"><input id="gh-app-org" placeholder="조직 이름 (개인 계정이면 비움)" onChange={(ev) => { const f = document.getElementById("gh-app-form") as HTMLFormElement; f.action = ev.target.value.trim() ? `https://github.com/organizations/${ev.target.value.trim()}/settings/apps/new` : app.createUrl; }} /><button className="primary" type="submit">GitHub에서 만들기</button></div>
      </form>
      <pre className="evidence">{JSON.stringify(app.manifest, null, 2)}</pre>
    </div>
  );
}
