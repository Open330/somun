import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { githubAppConfig, saveGithubApp } from "../../app/connectors.js";
import type { AppContext } from "../../app/context.js";
import { schema } from "../../infra/db/index.js";
import { appManifest } from "../../infra/github/app.js";
import type { AuthVars } from "../auth.js";
import type { Config } from "../config.js";

const KEY = "github_app_setup";
const COOKIE = "somun_github_app_state";
const COOKIE_PATH = "/api/github/app";
const TTL = 15 * 60_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function canConfigureGithubApp(c: Context<{ Variables: AuthVars }>, config: Config): boolean {
  return Boolean(config.SOMUN_ADMIN_OWNER_ID && c.get("authMethod") !== "anonymous" && c.get("ownerId") === config.SOMUN_ADMIN_OWNER_ID);
}

export function startGithubAppSetup(ctx: AppContext, config: Config) {
  return (c: Context<{ Variables: AuthVars }>) => {
    if (!canConfigureGithubApp(c, config)) return c.json({ error: "admin required" }, 403);
    if (githubAppConfig(ctx)) return c.json({ error: "GitHub App already configured" }, 409);
    const state = randomBytes(32).toString("hex");
    const now = Date.now();
    const value = JSON.stringify({ hash: hash(state), ownerId: c.get("ownerId"), expiresAt: now + TTL });
    ctx.db.insert(schema.appState).values({ key: KEY, value, updatedAt: now }).onConflictDoUpdate({ target: schema.appState.key, set: { value, updatedAt: now } }).run();
    const base = config.SOMUN_PUBLIC_URL ?? new URL(c.req.url).origin;
    setCookie(c, COOKIE, state, { httpOnly: true, sameSite: "Lax", secure: new URL(base).protocol === "https:", path: COOKIE_PATH, maxAge: TTL / 1000 });
    c.header("Cache-Control", "no-store");
    return c.json({ manifest: appManifest(base.replace(/\/$/, "")), createUrl: `https://github.com/settings/apps/new?state=${state}` });
  };
}

/** Public redirect: the administrator's one-time state and browser cookie authorize this callback. */
export function githubAppCreated(ctx: AppContext) {
  return async (c: Context) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const state = c.req.query("state");
    const cookie = getCookie(c, COOKIE);
    const code = c.req.query("code");
    if (!state || !cookie || state !== cookie || !code) return c.json({ error: "invalid setup callback" }, 400);
    const authorized = ctx.db.$client.transaction(() => {
      const row = ctx.db.select().from(schema.appState).where(eq(schema.appState.key, KEY)).get();
      if (!row) return false;
      const pending = JSON.parse(row.value) as { hash: string; expiresAt: number };
      if (pending.hash !== hash(state) || pending.expiresAt <= Date.now()) return false;
      ctx.db.delete(schema.appState).where(eq(schema.appState.key, KEY)).run();
      return true;
    }).immediate();
    if (!authorized) return c.json({ error: "invalid or expired setup state" }, 400);
    deleteCookie(c, COOKIE, { path: COOKIE_PATH });
    if (githubAppConfig(ctx)) return c.json({ error: "GitHub App already configured" }, 409);
    const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST", headers: { Accept: "application/vnd.github+json", "User-Agent": "somun" }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return c.json({ error: "GitHub App conversion failed; restart setup" }, 502);
    const parsed = z.object({ id: z.number().int().positive(), slug: z.string().min(1), pem: z.string().min(1), webhook_secret: z.string().optional(), client_id: z.string().optional(), client_secret: z.string().optional() }).safeParse(await response.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid GitHub App response; restart setup" }, 502);
    if (!saveGithubApp(ctx, parsed.data)) return c.json({ error: "GitHub App already configured" }, 409);
    ctx.log.info({ slug: parsed.data.slug, id: parsed.data.id }, "github app created");
    return c.redirect("/connectors?app=created");
  };
}
