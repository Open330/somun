import { createHmac, timingSafeEqual } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";

/**
 * GitHub App 어댑터. 앱 JWT → 설치 토큰, webhook 서명 검증, 설치 저장소 목록.
 * 앱 생성 자체는 GitHub UI(매니페스트 플로우)에서 한 번 한다.
 */
/** clientId·clientSecret: 설치 중 사용자 인증(OAuth)으로 "설치한 사람이 맞는지" 확인할 때 쓴다. */
export type GitHubAppConfig = { appId: string; privateKeyPem: string; slug?: string; webhookSecret?: string; clientId?: string; clientSecret?: string };

export function appConfigFromEnv(env: NodeJS.ProcessEnv): GitHubAppConfig | null {
  const appId = env.GITHUB_APP_ID;
  const pem = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!appId || !pem) return null;
  return { appId, privateKeyPem: pem, slug: env.GITHUB_APP_SLUG, webhookSecret: env.GITHUB_WEBHOOK_SECRET, clientId: env.GITHUB_APP_CLIENT_ID || undefined, clientSecret: env.GITHUB_APP_CLIENT_SECRET || undefined };
}

/** 10분짜리 앱 JWT (RS256). */
export async function appJwt(cfg: GitHubAppConfig): Promise<string> {
  const key = await importPKCS8(cfg.privateKeyPem.includes("BEGIN PRIVATE KEY") ? cfg.privateKeyPem : await rsaToPkcs8(cfg.privateKeyPem), "RS256");
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({}).setProtectedHeader({ alg: "RS256" }).setIssuedAt(now - 30).setExpirationTime(now + 9 * 60).setIssuer(cfg.appId).sign(key);
}

/** GitHub가 주는 PKCS#1("BEGIN RSA PRIVATE KEY")을 PKCS#8로. Node crypto로 변환. */
async function rsaToPkcs8(pem: string): Promise<string> {
  const { createPrivateKey } = await import("node:crypto");
  return createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }).toString();
}

const cache = new Map<number, { token: string; expiresAt: number }>();

/** 설치 토큰(1시간). 만료 5분 전까지 캐시. */
export async function installationToken(cfg: GitHubAppConfig, installationId: number): Promise<string> {
  const hit = cache.get(installationId);
  if (hit && hit.expiresAt - Date.now() > 5 * 60_000) return hit.token;
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, { signal: AbortSignal.timeout(20_000),
    method: "POST",
    headers: { Authorization: `Bearer ${await appJwt(cfg)}`, Accept: "application/vnd.github+json", "User-Agent": "somun" },
  });
  if (!res.ok) throw new Error(`installation token ${installationId} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { token: string; expires_at: string };
  cache.set(installationId, { token: j.token, expiresAt: Date.parse(j.expires_at) });
  return j.token;
}

export type InstallationInfo = { id: number; account: string; accountType: string; repos: string[] };

export async function installationInfo(cfg: GitHubAppConfig, installationId: number): Promise<InstallationInfo> {
  const token = await installationToken(cfg, installationId);
  const h = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "somun" };
  const repos: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, { signal: AbortSignal.timeout(20_000), headers: h });
    if (!r.ok) break;
    const j = (await r.json()) as { repositories: { full_name: string }[] };
    repos.push(...j.repositories.map((x) => x.full_name));
    if (j.repositories.length < 100) break;
  }
  const meta = await fetch(`https://api.github.com/app/installations/${installationId}`, { signal: AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${await appJwt(cfg)}`, Accept: "application/vnd.github+json", "User-Agent": "somun" } });
  const m = meta.ok ? ((await meta.json()) as { account: { login: string; type: string } }) : null;
  return { id: installationId, account: m?.account.login ?? repos[0]?.split("/")[0] ?? "", accountType: m?.account.type ?? "", repos };
}

export type InstallationRepoMeta = { fullName: string; description?: string; pushedAt?: number; stars: number; language?: string; fork: boolean; archived: boolean; isPrivate: boolean };

/** 설치가 볼 수 있는 저장소의 메타데이터. 고르기 화면에서 필터(최근 갱신·스타·포크)에 쓴다. */
export async function installationRepos(cfg: GitHubAppConfig, installationId: number): Promise<InstallationRepoMeta[]> {
  const token = await installationToken(cfg, installationId);
  const h = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "somun" };
  const out: InstallationRepoMeta[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, { signal: AbortSignal.timeout(20_000), headers: h });
    if (!r.ok) break;
    const j = (await r.json()) as { repositories: { full_name: string; description: string | null; pushed_at: string | null; stargazers_count: number; language: string | null; fork: boolean; archived: boolean; private: boolean }[] };
    for (const x of j.repositories) out.push({ fullName: x.full_name, description: x.description ?? undefined, pushedAt: x.pushed_at ? Date.parse(x.pushed_at) : undefined, stars: x.stargazers_count, language: x.language ?? undefined, fork: x.fork, archived: x.archived, isPrivate: x.private });
    if (j.repositories.length < 100) break;
  }
  return out;
}

/** X-Hub-Signature-256 검증. */
export function verifyWebhook(secret: string, rawBody: string, signature: string | undefined): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 매니페스트 플로우용 앱 정의. 사용자가 GitHub에서 한 번 승인하면 앱이 만들어진다. */
export function appManifest(baseUrl: string) {
  return {
    name: "somun",
    url: baseUrl,
    description: "PR for developers who'd rather build than announce. Reads releases, PRs and commits to draft posts you review.",
    hook_attributes: { url: `${baseUrl}/api/webhooks/github` },
    redirect_url: `${baseUrl}/api/github/app/created`,
    // 설치 중 사용자 인증: GitHub가 설치 직후 code를 붙여 콜백으로 보낸다. 서버는 그 사용자가 설치에 접근할 수 있는지 확인한 뒤에만 연결한다.
    request_oauth_on_install: true,
    callback_urls: [`${baseUrl}/github/setup`],
    setup_url: `${baseUrl}/github/setup`,
    setup_on_update: true,
    public: false,
    default_permissions: { contents: "read", metadata: "read", pull_requests: "read", issues: "read" },
    // installation·installation_repositories 이벤트는 앱에 자동 전달되므로 매니페스트에 적지 않는다.
    default_events: ["push", "release", "pull_request", "star"],
  };
}

/**
 * 설치 콜백의 code로 사용자 토큰을 받아, 그 사용자가 이 설치에 접근할 수 있는지 확인한다.
 * installation_id는 URL로 오므로 그 자체로는 권한의 증거가 아니다(GitHub 문서: setup URL의 installation_id를 믿지 말 것).
 */
export async function userCanAccessInstallation(cfg: GitHubAppConfig, code: string, installationId: number): Promise<boolean> {
  if (!cfg.clientId || !cfg.clientSecret) return false;
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST", signal: AbortSignal.timeout(20_000),
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "somun" },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code }),
  });
  const token = tokenRes.ok ? ((await tokenRes.json()) as { access_token?: string }).access_token : undefined;
  if (!token) return false;
  const h = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "somun" };
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`https://api.github.com/user/installations?per_page=100&page=${page}`, { headers: h, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return false;
    const j = (await r.json()) as { installations: { id: number }[] };
    if (j.installations.some((i) => i.id === installationId)) return true;
    if (j.installations.length < 100) return false;
  }
  return false;
}
