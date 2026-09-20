<div align="center">

<br />

# 소문 &nbsp;·&nbsp; somun

**PR for developers who'd rather build than announce.**

<sub>*somun* (소문) is Korean for "word of mouth". The tool spreads the word so you don't have to.</sub>

<br />

[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/status-v0%20·%20building%20in%20public-f0b35a?style=flat-square)](docs/spec.md)
[![Model](https://img.shields.io/badge/default%20model-Gemini%203.5%20Flash--Lite-7dd3a5?style=flat-square)](#models--keys)
[![BYOK](https://img.shields.io/badge/BYOK-Anthropic%20·%20OpenAI%20·%20Claude%20Code%20·%20Codex-8b919c?style=flat-square)](#models--keys)

**English** · [한국어](README.ko.md)

</div>

<br />

You ship every day. Nobody hears about it.

somun watches your repos, decides when something is actually worth telling, and hands you a draft for each channel — X, Threads, LinkedIn, Show HN, GeekNews — that you review, copy, and post yourself. Every edit you make teaches it your voice. Every post you register gets measured.

It never posts for you. It never writes from thin air. It never says "excited to announce".

<br />

## How it thinks

```
 GitHub · npm · blog · agent sessions
            │
            ▼
   ┌─────────────────┐    commits, PR titles, release notes, what you struggled with
   │  1. observe      │    ──────────────────────────────────────────────────────────
   └────────┬────────┘
            ▼
   ┌─────────────────┐    keeps only what an outside reader would care about:
   │  2. digest       │    user-visible changes · real numbers · reversals · lessons
   └────────┬────────┘    drops refactors, chores, CI, bumps
            ▼
   ┌─────────────────┐    five criteria, 0–2 each, with reasoning you can argue with:
   │  3. judge        │    runnable · numbers · lesson · novelty · audience
   └────────┬────────┘    ≥ 6 → draft   4–5 → defer   < 4 → just ask
            ▼
   ┌─────────────────┐    one draft per channel, in that channel's shape and language,
   │  4. draft        │    facts only from the digest, voice only from your examples,
   └────────┬────────┘    slop-linted before it reaches you
            ▼
   ┌─────────────────┐    copy · edit-then-copy · drop (with a reason) · "posted, here's the URL"
   │  5. you          │
   └────────┬────────┘
            ▼
   ┌─────────────────┐    edits → voice examples · drops → judge calibration
   │  6. learn        │    URLs → stars, visitors, downloads vs. the 7-day baseline
   └─────────────────┘
```

**Facts from the system, voice from you.** A draft may only use numbers that exist in the evidence. If a number is missing, it writes `[number needed]` instead of inventing one.

<br />

## What you get

<table>
<tr>
<td width="50%" valign="top">

**Inbox**
Candidates ranked by score, one line of reasoning each. "Not worth it" is a valid answer and you can overrule it.

**Candidate**
Evidence on the left (version, stars, downloads, demo asset, limitations, digest). Drafts on the right, one tab per channel, with lint results and a copy button.

</td>
<td width="50%" valign="top">

**Published**
Paste the URL after you post. From then on: star and visitor deltas against the pre-post baseline, plus whatever reactions you type in.

**Settings**
Sources, channels, rubric weights, banned phrases, voice examples, and which model runs the whole thing.

</td>
</tr>
</table>

<br />

## Channels

| Channel | Shape | Language |
|---|---|---|
| X | three lines: problem · what it does · one number or limit + link | en, ko |
| Threads | one or two sentences, ends with a take or a question | ko |
| LinkedIn | hook above the fold, 3–5 paragraphs, ≤ 3 hashtags | ko |
| Show HN | title + the author's first comment: problem, mechanism, design choices, limitations, one open question | en |
| Show GN (GeekNews) | what / why / how it differs / decisions / limits / feedback wanted | ko |
| Blog | outline only: 3 title candidates, sections, which numbers go where | ko |

Every draft passes a **slop lint** before you see it: banned phrases, emoji bullets, missing number, missing limitation, missing link, exclamation marks, vote requests.

<br />

## Models & keys

| Provider | Default model | Key |
|---|---|---|
| **Gemini** (default) | `gemini-3.5-flash-lite` | server key pool, or your own |
| Anthropic | `claude-opus-5` | your own |
| OpenAI-compatible | `gpt-5` | your own, optional base URL (OpenRouter, Ollama, …) |
| **Local agent** | your Claude Code or Codex subscription | none — a worker on your machine picks up jobs |

The local agent mode queues each judgment and draft as a job. Run the worker where your CLI is logged in:

```bash
node scripts/agent-worker.mjs --cli claude    # or --cli codex
```

<br />

## Run it

```bash
npm install
npx convex dev                                        # local Convex backend, writes VITE_CONVEX_URL to .env.local
npx convex env set SOMUN_ALLOW_ANONYMOUS true         # local only
npx convex env set GITHUB_TOKEN "$(gh auth token)"
npx convex env set GEMINI_API_KEYS '{"free-1":"..."}' # labeled JSON map; paid keys never rotate
npm run dev                                           # http://localhost:5180

node scripts/seed.mjs                                 # best-practice voice examples (once)
node scripts/omp-sync.mjs --days 14                   # optional: attach oh-my-prompt session summaries
```

Add a GitHub source in Settings (`Open330`, `you/repo`), press **Check now** in the Inbox, and read what it found.

```bash
npm run typecheck && npm test
```

<br />

## Deploy

Same shape as the other `*.jiun.dev` apps: self-hosted Convex (`somun-api.jiun.dev`), OAuth and RS256 external JWTs from `api.jiun.dev` (audience `somun`), static web (`somun.jiun.dev`) from `docker/Dockerfile.web`.

```bash
CONVEX_SELF_HOSTED_URL=https://somun-api.jiun.dev CONVEX_SELF_HOSTED_ADMIN_KEY=… npx convex deploy
docker build -f docker/Dockerfile.web --build-arg VITE_CONVEX_URL=https://somun-api.jiun.dev --build-arg VITE_AUTH_URL=https://api.jiun.dev -t somun-web .
```

Server env: `GITHUB_TOKEN`, `GEMINI_API_KEYS`. Never set `SOMUN_ALLOW_ANONYMOUS` in the cloud.

<br />

## Layout

```
convex/
  schema.ts          sources → signals → candidates → judgments → drafts → publications → metricSnapshots
  collect.ts         GitHub / npm collector: releases, merged PRs, commits since last release, milestones, traffic
  signals.ts         signal → candidate clustering (merges back-to-back releases, attaches PRs to a release)
  llm.ts · jobs.ts   digest → judge → draft runner; local-agent job queue; result application
  lib/providers.ts   Gemini key pool · Anthropic · OpenAI-compatible
  lib/prompts.ts     the three prompts and their JSON schemas
  lib/channels.ts    per-channel shape, rules, media hints, compose links
  lib/lint.ts        slop lint
  drafts.ts          copy / edit / drop → voice examples and feedback
  omp.ts             oh-my-prompt session summaries as evidence
  crons.ts           daily at 09:00 KST
src/                 Inbox · Candidate · Published · Settings
scripts/             seed.mjs · omp-sync.mjs · agent-worker.mjs
seeds/               38 real Show HN first comments that landed, plus per-channel rules
docs/spec.md         the plan this was built from
```

<br />

<div align="center">
<sub>Built by <a href="https://github.com/Open330">Open330</a>. First launch it will run: <a href="https://github.com/Open330/muxa">muxa</a>.</sub>
</div>
