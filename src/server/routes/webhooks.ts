import type { Context } from "hono";
import { collectAll } from "../../app/collect.js";
import { githubAppConfig, ownerOfInstallation, recordInstallation, removeInstallation, saveGithubApp } from "../../app/connectors.js";
import type { AppContext } from "../../app/context.js";
import { verifyWebhook } from "../../infra/github/app.js";

/**
 * GitHub App webhook. 서명 검증 후:
 * - installation created/deleted, installation_repositories → 설치 기록 갱신
 * - push / release / pull_request / star → 해당 소유자의 수집을 백그라운드로
 * 폴링(크론)은 보조 수단으로 남는다.
 */
export function githubWebhook(ctx: AppContext) {
  return async (c: Context) => {
    const cfg = githubAppConfig(ctx);
    const raw = await c.req.text();
    if (!cfg?.webhookSecret || !verifyWebhook(cfg.webhookSecret, raw, c.req.header("x-hub-signature-256"))) return c.json({ error: "bad signature" }, 401);
    const event = c.req.header("x-github-event") ?? "";
    const p = JSON.parse(raw) as { action?: string; installation?: { id: number; account?: { login: string } }; repository?: { full_name: string } };
    const instId = p.installation?.id;
    ctx.log.info({ event, action: p.action, installation: instId, repo: p.repository?.full_name }, "github webhook");
    if (!instId) return c.json({ ok: true });
    const ownerId = ownerOfInstallation(ctx, instId);
    if (event === "installation" && p.action === "deleted") { removeInstallation(ctx, instId); return c.json({ ok: true }); }
    if ((event === "installation" || event === "installation_repositories") && ownerId) { await recordInstallation(ctx, ownerId, instId); return c.json({ ok: true }); }
    if (["push", "release", "pull_request", "star", "create"].includes(event) && ownerId) {
      // 응답은 바로, 수집은 뒤에서. 같은 소유자에 대해 짧은 시간에 몰리면 한 번만.
      scheduleCollect(ctx, ownerId);
    }
    return c.json({ ok: true, owner: Boolean(ownerId) });
  };
}

const pending = new Map<string, NodeJS.Timeout>();
function scheduleCollect(ctx: AppContext, ownerId: string) {
  const t = pending.get(ownerId);
  if (t) clearTimeout(t);
  pending.set(ownerId, setTimeout(() => { pending.delete(ownerId); void collectAll(ctx, ownerId).catch((e) => ctx.log.error({ err: (e as Error).message }, "webhook collect failed")); }, 20_000));
}

/**
 * 매니페스트 플로우 콜백 (인증 없음: GitHub가 브라우저를 여기로 보낸다).
 * 이미 앱이 있으면 거부한다. code는 1회용이라 재사용 위험이 없다.
 */
export function githubAppCreated(ctx: AppContext) {
  return async (c: Context) => {
    if (githubAppConfig(ctx)) return c.json({ error: "GitHub App already configured" }, 409);
    const code = c.req.query("code");
    if (!code) return c.json({ error: "code required" }, 400);
    const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, { method: "POST", headers: { Accept: "application/vnd.github+json", "User-Agent": "somun" } });
    if (!res.ok) return c.json({ error: `github ${res.status}` }, 502);
    const j = (await res.json()) as { id: number; slug: string; pem: string; webhook_secret?: string };
    saveGithubApp(ctx, { id: j.id, slug: j.slug, pem: j.pem, webhook_secret: j.webhook_secret });
    ctx.log.info({ slug: j.slug, id: j.id }, "github app created");
    return c.redirect("/connectors?app=created");
  };
}
