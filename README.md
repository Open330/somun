<div align="center">

<br />

<img src="docs/brand/lockup.png" alt="somun" width="420" />

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
   │  4. draft        │    facts only from the digest, voice from your preset, guide, and copied posts,
   └────────┬────────┘    numbers checked against the raw material, slop-linted before it reaches you
            ▼
   ┌─────────────────┐    copy · edit-then-copy · drop (with a reason) · "posted, here's the URL"
   │  5. you          │
   └────────┬────────┘
            ▼
   ┌─────────────────┐    copied posts → voice examples · edits, drops → guide suggestions · drops → judge calibration
   │  6. learn        │    URLs → star gain beyond the 7-day pre-post trend, fed back into channel picks
   └─────────────────┘
```

**Facts from the system, voice from you.** A draft may only use numbers that exist in the raw material (release notes, PR titles, commits, README, repo stats). If a number is missing, the claim is left out, not invented. The digest is checked too: a summary line whose number is not in the source never reaches the judge or the draft, and it stays visible on the candidate page. A draft number that still cannot be found in the source — including multipliers like "3x" or "twice" — is flagged, and copying asks you to confirm.

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
Paste the URL after you post (you can fix or remove it later). From then on: stars gained in 7 days minus what the pre-post 7-day trend would have added, visitors, and reactions (fetched for X and HN, typed in for the rest). Per-channel results feed back into which channels the judge suggests.

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

Every draft passes a **slop lint** before you see it: banned phrases, emoji bullets, numbers not found in the source, invented limitations, a wrong repo name, missing link, exclamation marks, vote requests, length.

**Is it learning?** The Voice page shows, for drafts you copied, how often you used them unchanged and how much you rewrote — by week and by voice-setting version. If the guide and examples work, the rewrite share goes down. `npm run experiment -- export-holdout` turns your copied drafts into a private held-out set (`experiments/holdout/`, git-ignored) with your final text as the baseline.

<br />

## Models & keys

| Provider | Default model | Key |
|---|---|---|
| **Gemini** (default) | `gemini-3.5-flash-lite` | server key pool, or your own |
| Anthropic | `claude-opus-5` | your own |
| OpenAI-compatible | `gpt-5` | your own, optional base URL (OpenRouter, Ollama, …) |
| **Local agent** | your Claude Code or Codex subscription | none — a worker on your machine picks up jobs |

The local agent mode queues every model call — digest, judgment, drafts, repository profiles, and voice lessons — as a job, so no source text goes to a server model. Run the worker where your CLI is logged in:

```bash
npm run agent-worker -- --cli claude    # or --cli codex
```

<br />

## Run it

One process, one SQLite file. No external services.

```bash
nvm install && nvm use          # .nvmrc: Node 22 (same major as CI/Docker)
npm ci
cp .env.example .env            # set GITHUB_TOKEN and GEMINI_API_KEYS; SOMUN_ALLOW_ANONYMOUS=true for local
npm run dev                     # API on :8790, web on :5180

npm run seed                    # best-practice voice examples (once)
npm run push -- --sources omp --days 14   # optional: attach oh-my-prompt session summaries
```

Add a GitHub source in Settings (`Open330`, `you/repo`), press **Check now** in the Inbox, and read what it found.

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

<br />

To register a GitHub App through the UI, set `SOMUN_ADMIN_OWNER_ID` to the administrator’s `ownerId` from `/api/me` (`local` by default for shared-token auth). Anonymous sessions cannot register apps. Behind a reverse proxy, set `SOMUN_PUBLIC_URL` to the public HTTPS URL. Existing app installations do not require these settings.

Update and restart local workers together with the server: completion now requires a claim token. Claims expire after 10 minutes; abandoned jobs are reclaimed on the next poll, up to 3 attempts. Invalid results and explicit worker failures are not automatically retried. SQL migrations run on server startup, or manually with `npm run db:migrate`.

## Deploy

A single container. The API and the built web are served by the same Node process; the database is a file on a volume.

```bash
docker build -f docker/Dockerfile -t somun .
docker run -p 8790:8790 -v somun-data:/data \
  -e SOMUN_TOKEN=change-me -e GITHUB_TOKEN=… -e GEMINI_API_KEYS='{"free-1":"…"}' somun
```

Auth is one of three modes, checked in order: a shared `SOMUN_TOKEN` bearer (single user), an RS256 JWT from an issuer you trust (`AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_AUDIENCE`; this is how `somun.jiun.dev` uses `api.jiun.dev`), or `SOMUN_ALLOW_ANONYMOUS=true` for local development only.

With JWT, several people can sign in; each gets a separate workspace (sources, candidates, drafts, voice, publications). The server `GITHUB_TOKEN` reads private repositories only for `SOMUN_ADMIN_OWNER_ID` and the shared-token owner; everyone else reads public repositories with it, or connects their own GitHub App installation.

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
    publications · candidates · sources · settings · keys · jobs · sessions · scheduler
  infra/       adapters — SQLite (Drizzle), GitHub REST, LLM providers, logger
  server/      Hono — auth middleware (token · JWT · anonymous), /api routes, SSE, static web
  shared/      types shared by server and web
  web/         Vite + React — Inbox · Candidate · Published · Settings
scripts/       seed · push-sessions · agent-worker (talk to the HTTP API only)
drizzle/       SQL migrations, applied on start
seeds/         38 real Show HN first comments that landed, plus per-channel rules
```

The web never touches the database: it reads `/api/*` and subscribes to `/api/events` (SSE) to refetch what changed.

<br />

<div align="center">
<sub>Built by <a href="https://github.com/Open330">Open330</a>. First launch it will run: <a href="https://github.com/Open330/muxa">muxa</a>.</sub>
</div>

### Draft quality experiments

Run `npm run experiment` to replay fixed cases without model calls. See the [experiment guide](experiments/README.md) for explicit live runs, repeated prompt comparisons, blinded human review, and paired regression checks. Automatic checks and publishability are reported separately.
