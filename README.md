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

One process, one SQLite file. No external services.

```bash
npm install
cp .env.example .env            # set GITHUB_TOKEN and GEMINI_API_KEYS; SOMUN_ALLOW_ANONYMOUS=true for local
npm run dev                     # API on :8790, web on :5180

npm run seed                    # best-practice voice examples (once)
npm run omp-sync -- --days 14   # optional: attach oh-my-prompt session summaries
```

Add a GitHub source in Settings (`Open330`, `you/repo`), press **Check now** in the Inbox, and read what it found.

```bash
npm run typecheck && npm test
```

<br />

## Deploy

A single container. The API and the built web are served by the same Node process; the database is a file on a volume.

```bash
docker build -f docker/Dockerfile -t somun .
docker run -p 8790:8790 -v somun-data:/data \
  -e SOMUN_TOKEN=change-me -e GITHUB_TOKEN=… -e GEMINI_API_KEYS='{"free-1":"…"}' somun
```

Auth is one of three modes, checked in order: a shared `SOMUN_TOKEN` bearer (single user), an RS256 JWT from an issuer you trust (`AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_AUDIENCE`; this is how `somun.jiun.dev` uses `api.jiun.dev`), or `SOMUN_ALLOW_ANONYMOUS=true` for local development only.

<br />

## Architecture

Layers point inward. `core` knows nothing about IO; `app` knows nothing about HTTP; `server` is thin.

```
src/
  core/        pure domain — no IO, fully unit-tested
    channels   per-channel shape, rules, media hints, compose links
    prompts    the three prompts (digest · judge · draft) and their JSON schemas
    lint       slop lint
    cluster    signal → candidate rules, milestone thresholds
    keypool    Gemini 429 classification, PT-midnight day keys
  app/         use cases — take an AppContext (db, log, env, event bus)
    collect    GitHub / npm → signals, evidence, metric snapshots
    signals    clustering, back-to-back release merging, PR attachment
    pipeline   digest → judge → draft; provider call or local-agent queue; result application
    review     copy / edit / drop → voice examples and feedback
    publications · candidates · sources · settings · keys · jobs · omp · scheduler
  infra/       adapters — SQLite (Drizzle), GitHub REST, LLM providers, logger
  server/      Hono — auth middleware (token · JWT · anonymous), /api routes, SSE, static web
  shared/      types shared by server and web
  web/         Vite + React — Inbox · Candidate · Published · Settings
scripts/       seed · omp-sync · agent-worker (talk to the HTTP API only)
drizzle/       SQL migrations, applied on start
seeds/         38 real Show HN first comments that landed, plus per-channel rules
```

The web never touches the database: it reads `/api/*` and subscribes to `/api/events` (SSE) to refetch what changed.

<br />

<div align="center">
<sub>Built by <a href="https://github.com/Open330">Open330</a>. First launch it will run: <a href="https://github.com/Open330/muxa">muxa</a>.</sub>
</div>
