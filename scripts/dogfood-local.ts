/** Fixed ten-case dogfood through the real local worker, without production resources. */
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import pino from "pino";
import { z } from "zod";
import { enqueueJob } from "../src/app/pipeline.js";
import type { AppContext } from "../src/app/context.js";
import { DEFAULT_SETTINGS } from "../src/app/settings.js";
import { openDb, schema } from "../src/infra/db/index.js";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import type { Evidence } from "../src/shared/types.js";

const { values } = parseArgs({ options: { cases: { type: "string" }, out: { type: "string" }, settings: { type: "string" } } });
if (!values.cases || !values.out) throw new Error("Usage: npm run dogfood:local -- --cases private-cases.json --out new-private-directory [--settings noncredential-settings.json]");
const cases = z.array(z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i), candidateId: z.number().int().positive(), repo: z.string(), introduction: z.boolean(),
  editorInstruction: z.string(),
  candidate: z.object({ title: z.string(), type: z.string(), evidence: z.object({ repo: z.string(), repoUrl: z.string() }).passthrough() }),
  profile: z.unknown().optional(),
  prompt: z.object({ system: z.string(), user: z.string(), schema: z.record(z.string(), z.unknown()), schemaName: z.string() }),
})).length(10).refine((rows) => new Set(rows.map((r) => r.id)).size === 10, "Expected ten distinct case IDs").parse(JSON.parse(readFileSync(resolve(values.cases), "utf8")));
const settings = values.settings ? z.object({ voice: z.unknown().optional(), bannedPhrases: z.unknown().optional(), customChannels: z.unknown().optional(), channelLangs: z.unknown().optional(), ui: z.unknown().optional() }).strict().parse(JSON.parse(readFileSync(resolve(values.settings), "utf8"))) : {};
const realCodex = execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(values.out);
mkdirSync(dirname(out), { recursive: true });
mkdirSync(out, { mode: 0o700 }); // Never overwrite a previous run.
const write = (name: string, data: unknown) => writeFileSync(join(out, name), JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
const bin = mkdtempSync(join(tmpdir(), "somun-dogfood-bin-"));
// Keep production worker arguments and prompt unchanged; constrain the CLI workspace.
writeFileSync(join(bin, "codex"), '#!/bin/sh\nexec "$SOMUN_DOGFOOD_REAL_CODEX" "$@" --sandbox read-only --ephemeral\n', { mode: 0o700 });
write("plan.json", { cases: cases.map((c) => c.id), executor: "existing agent-worker --cli codex --once", database: ":memory:", bind: "127.0.0.1", productionWrites: 0, gatewayCalls: 0, promptChanges: false, normalRepair: "existing policy, at most once", cliConstraints: ["empty worker directory", "read-only sandbox", "ephemeral session"], startedAt: new Date().toISOString() });
write("inputs.json", cases);
try {
  for (const c of cases) {
    const db = openDb(":memory:");
    const requests: { path: string; body: unknown }[] = [], usage: unknown[] = [];
    const ctx: AppContext = { db, log: pino({ level: "silent" }), env: {}, bus: new EventEmitter(), usage: { record: (event: unknown) => { usage.push(event); } } as AppContext["usage"] };
    const loopbackAuth = randomUUID();
    const app = createApp(ctx, loadConfig({ SOMUN_TOKEN: loopbackAuth }));
    const server = serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (/\/jobs\/\d+\/(?:check|complete)$/.test(path)) requests.push({ path, body: await request.clone().json() });
      return app.fetch(request);
    } });
    try {
      if (!server.listening) await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing loopback port");
      db.insert(schema.settings).values({ ownerId: "local", data: { ...DEFAULT_SETTINGS, ...settings, llm: { provider: "local-agent", model: "" } }, updatedAt: Date.now() }).run();
      db.insert(schema.candidates).values({ id: c.candidateId, ownerId: "local", repo: c.repo, title: c.candidate.title, type: c.candidate.type, key: `dogfood:${c.id}`, evidence: c.candidate.evidence as Evidence, status: "judged", createdAt: Date.now(), updatedAt: Date.now() }).run();
      if (c.profile) {
        const stored = z.record(z.string(), z.unknown()).parse(c.profile);
        const profile = z.record(z.string(), z.unknown()).parse(stored.profile ?? stored);
        db.insert(schema.repoProfiles).values({ ownerId: "local", repo: c.repo, readmeHash: "frozen", profile, model: "frozen", createdAt: Date.now(), updatedAt: Date.now() }).run();
      }
      enqueueJob(ctx, "local", "draft", c.candidateId, "threads", "ko", { ...c.prompt, editorInstruction: c.editorInstruction, draftPurpose: c.introduction ? "introduction" : "update" });
      const child = spawn(process.execPath, ["--import", "tsx", join(repoRoot, "scripts/agent-worker.ts"), "--cli", "codex", "--once"], { cwd: repoRoot, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SOMUN_DOGFOOD_REAL_CODEX: realCodex, SOMUN_URL: `http://127.0.0.1:${address.port}`, SOMUN_TOKEN: loopbackAuth }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (data) => { stdout += data; });
      child.stderr.on("data", (data) => { stderr += data; });
      const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      const job = db.select().from(schema.llmJobs).get();
      const draft = db.select().from(schema.drafts).get();
      // Claim tokens are loopback-only but need not be retained in artifacts.
      const traces = requests.map(({ path, body }) => { const { claimToken: _token, ...rest } = body as Record<string, unknown>; void _token; return { path, body: rest }; });
      write(`${c.id}.json`, { caseId: c.id, status: job?.status, error: job?.error, exitCode, final: draft ? { title: draft.title ?? "", body: draft.body } : null, model: draft?.model, lint: draft?.lint, traces, usage, stdout, stderr, productionWrites: 0, gatewayCalls: 0 });
      console.log(JSON.stringify({ caseId: c.id, status: job?.status, exitCode, model: draft?.model, calls: usage.length, productionWrites: 0 }));
      if (exitCode !== 0 || job?.status !== "done") process.exitCode = 1;
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      db.$client.close();
    }
  }
} finally { rmSync(bin, { recursive: true, force: true }); }
