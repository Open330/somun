import { mkdtempSync, rmSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { claudePrompts, codexPrompts, jsonLines, walkJsonl } from "./session-files.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "somun-sessions-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const T = (s: string) => `2026-10-24T0${s}:00:00.000Z`;
const write = (name: string, rows: unknown[], tail = "") => {
  const p = join(dir, name);
  writeFileSync(p, rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + tail);
  return p;
};

it("reads Claude Code user prompts line by line, skipping tool results, injections, old and broken lines", async () => {
  const f = write("claude.jsonl", [
    { type: "user", sessionId: "s1", cwd: "/w/a", timestamp: T("1"), message: { content: "Fix the build" } },
    { type: "assistant", sessionId: "s1", timestamp: T("1"), message: { content: [{ type: "text", text: '"type":"user" quoted' }] } },
    { type: "user", sessionId: "s1", timestamp: T("2"), message: { content: [{ type: "tool_result", content: "x".repeat(10_000) }] } },
    { type: "user", sessionId: "s1", timestamp: T("2"), message: { content: "<system-reminder>…" } },
    { type: "user", sessionId: "s1", cwd: "/w/a", timestamp: T("3"), message: { content: [{ type: "text", text: "Now add tests" }] } },
    { type: "user", sessionId: "s1", timestamp: "2020-01-01T00:00:00Z", message: { content: "too old" } },
    '{"type":"user","sessionId":"s1"', // 쓰는 중이던 줄
  ]);
  const since = Date.parse("2026-10-01T00:00:00Z");
  expect(await claudePrompts(f, since)).toEqual([
    { sessionId: "s1", source: "claude-code", cwd: "/w/a", at: Date.parse(T("1")), text: "Fix the build" },
    { sessionId: "s1", source: "claude-code", cwd: "/w/a", at: Date.parse(T("3")), text: "Now add tests" },
  ]);
});

it("reads Codex prompts with the session meta that precedes them", async () => {
  const f = write("codex.jsonl", [
    { type: "event_msg", timestamp: T("1"), payload: { type: "user_message", message: "before meta" } },
    { type: "session_meta", timestamp: T("1"), payload: { id: "c1", cwd: "/w/b" } },
    { type: "response_item", timestamp: T("2"), payload: { type: "function_call_output", output: "y".repeat(10_000) } },
    { type: "event_msg", timestamp: T("2"), payload: { type: "user_message", message: "Refactor auth" } },
    { type: "response_item", timestamp: T("3"), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "and" }, { type: "input_image" }, { type: "input_text", text: "tests" }] } },
    { type: "response_item", timestamp: T("3"), payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: '"role":"user"' }] } },
  ], "\n");
  expect(await codexPrompts(f, 0)).toEqual([
    { sessionId: "c1", source: "codex", cwd: "/w/b", at: Date.parse(T("2")), text: "Refactor auth" },
    { sessionId: "c1", source: "codex", cwd: "/w/b", at: Date.parse(T("3")), text: "and tests" },
  ]);
});

it("streams lines without loading the file as one string, handling CRLF and blank lines", async () => {
  const f = write("crlf.jsonl", ['{"a":1}\r', "", '{"a":2}\r', "[1,2]", "not json"]);
  const seen: unknown[] = [];
  for await (const d of jsonLines(f)) seen.push(d);
  expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
  const filtered: unknown[] = [];
  for await (const d of jsonLines(f, (l) => l.includes("2"))) filtered.push(d);
  expect(filtered).toEqual([{ a: 2 }]);
});

it("walks nested folders for recently modified .jsonl files only", () => {
  mkdirSync(join(dir, "a", "b"), { recursive: true });
  const fresh = write(join("a", "b", "fresh.jsonl"), [{}]);
  const old = write(join("a", "old.jsonl"), [{}]);
  write(join("a", "note.txt"), [{}]);
  const since = Date.now() - 86400e3;
  utimesSync(old, new Date(since - 1000), new Date(since - 1000));
  expect(walkJsonl(dir, since)).toEqual([fresh]);
  expect(walkJsonl(join(dir, "missing"), since)).toEqual([]);
});
