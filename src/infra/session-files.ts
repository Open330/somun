import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { RawPrompt } from "../core/sessions.js";

/**
 * 로컬 코딩 에이전트 세션 로그(.jsonl) 읽기. somun push가 쓴다.
 * 오래 이어진 세션의 로그는 1GB를 넘는다(Codex 1.5GB). 파일 하나를 문자열로 읽으면 Node 문자열 한도(약 512MB)에서
 * ERR_STRING_TOO_LONG으로 멈추므로 한 줄씩 읽는다. 대부분의 줄은 도구 출력이라, 쓸 줄만 싼 문자열 검사로 고른 뒤 JSON으로 읽는다.
 */

/** dir 아래에서 since 이후에 바뀐 .jsonl. */
export function walkJsonl(dir: string, since: number, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, since, out);
    else if (e.name.endsWith(".jsonl") && statSync(p).mtimeMs >= since) out.push(p);
  }
  return out;
}

/** 한 줄씩 JSON 객체. keep이 있으면 그 검사를 통과한 줄만 파싱한다. 깨진 줄은 건너뛴다. */
export async function* jsonLines(file: string, keep?: (line: string) => boolean): AsyncGenerator<Record<string, unknown>> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || (keep && !keep(line))) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) yield value as Record<string, unknown>;
    } catch {
      /* 쓰는 중이던 마지막 줄 등 */
    }
  }
}

/** Claude Code 세션 파일의 사용자 프롬프트. 도구 결과·시스템 주입(<로 시작)은 뺀다. */
export async function claudePrompts(file: string, since: number): Promise<RawPrompt[]> {
  const out: RawPrompt[] = [];
  for await (const d of jsonLines(file, (line) => line.includes('"type":"user"'))) {
    if (d.type !== "user" || !d.sessionId) continue;
    const c = (d.message as { content?: unknown } | undefined)?.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? ((c.find((x) => (x as { type?: string }).type === "text") as { text?: string } | undefined)?.text ?? "") : "";
    if (!text || text.startsWith("<")) continue;
    const at = Date.parse(String(d.timestamp ?? ""));
    if (!at || at < since) continue;
    out.push({ sessionId: String(d.sessionId), source: "claude-code", cwd: (d.cwd as string) ?? null, at, text });
  }
  return out;
}

/** Codex 세션 파일의 사용자 프롬프트. session_meta에서 cwd·세션 ID를 얻는다. */
export async function codexPrompts(file: string, since: number): Promise<RawPrompt[]> {
  const out: RawPrompt[] = [];
  let cwd: string | null = null, sessionId = "";
  const keep = (line: string) => line.includes('"session_meta"') || line.includes('"user_message"') || line.includes('"role":"user"');
  for await (const d of jsonLines(file, keep)) {
    const p = (d.payload ?? {}) as Record<string, unknown>;
    if (d.type === "session_meta") { cwd = (p.cwd as string) ?? null; sessionId = String(p.id ?? p.session_id ?? ""); continue; }
    let text = "";
    if (d.type === "event_msg" && p.type === "user_message") text = String(p.message ?? "");
    else if (d.type === "response_item" && p.type === "message" && p.role === "user") text = ((p.content as { type?: string; text?: string }[]) ?? []).filter((x) => x.type === "input_text").map((x) => x.text ?? "").join(" ");
    if (!text || !sessionId) continue;
    const at = Date.parse(String(d.timestamp ?? ""));
    if (!at || at < since) continue;
    out.push({ sessionId, source: "codex", cwd, at, text });
  }
  return out;
}
