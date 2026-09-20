<div align="center">

<br />

# 소문 &nbsp;·&nbsp; somun

**소문낼 줄 모르는 개발자를 위한 PR 도우미.**

<sub>만드는 속도보다 알리는 속도가 느린 사람을 위해, 도구가 대신 소문을 냅니다.</sub>

<br />

[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/status-v0%20·%20building%20in%20public-f0b35a?style=flat-square)](docs/spec.md)
[![Model](https://img.shields.io/badge/기본%20모델-Gemini%203.5%20Flash--Lite-7dd3a5?style=flat-square)](#모델과-키)
[![BYOK](https://img.shields.io/badge/내%20키-Anthropic%20·%20OpenAI%20·%20Claude%20Code%20·%20Codex-8b919c?style=flat-square)](#모델과-키)

[English](README.md) · **한국어**

</div>

<br />

매일 만드는데, 아무도 모릅니다.

소문은 저장소를 지켜보다가 정말 알릴 만한 것이 생겼을 때만 채널별 초안을 건넵니다. X, Threads, LinkedIn, Show HN, GeekNews. 검수하고 복사해서 직접 올리는 건 사용자 몫입니다. 고친 문장은 다음 초안의 문체가 되고, 올린 글의 URL을 등록하면 그때부터 지표가 붙습니다.

대신 올리지 않습니다. 없는 숫자를 지어내지 않습니다. "소개합니다"라고 쓰지 않습니다.

<br />

## 어떻게 생각하는가

```
 GitHub · npm · 블로그 · 에이전트 세션
            │
            ▼
   ┌─────────────────┐    커밋 제목, PR 제목, 릴리스 노트, 무엇과 씨름했는지
   │  1. 관찰         │    ──────────────────────────────────────────────
   └────────┬────────┘
            ▼
   ┌─────────────────┐    바깥 독자가 관심 가질 것만 남긴다:
   │  2. 다이제스트    │    보이는 변화 · 실제 숫자 · 되돌린 결정 · 배운 것
   └────────┬────────┘    리팩터링, 잡일, CI, 의존성 갱신은 버린다
            ▼
   ┌─────────────────┐    다섯 항목 0~2점, 반박할 수 있는 이유와 함께:
   │  3. 판단         │    실행 가능 · 숫자 · 배움 · 새로움 · 청중
   └────────┬────────┘    6 이상 초안 · 4~5 보류 · 4 미만 묻기만
            ▼
   ┌─────────────────┐    채널마다 그 채널의 형식과 언어로 하나씩,
   │  4. 초안         │    사실은 다이제스트에서만, 문체는 사용자 예시에서만,
   └────────┬────────┘    슬롭 린트를 통과한 뒤에 보여준다
            ▼
   ┌─────────────────┐    복사 · 수정 후 복사 · 버리기(사유) · "올렸어요, URL은 이것"
   │  5. 사용자       │
   └────────┬────────┘
            ▼
   ┌─────────────────┐    수정 → 문체 예시 · 버림 → 판단 보정
   │  6. 학습         │    URL → 발행 전 7일 기준선 대비 스타·방문자·다운로드
   └─────────────────┘
```

**사실은 시스템이, 목소리는 사람이.** 초안은 근거에 있는 숫자만 씁니다. 없으면 지어내는 대신 `[숫자 확인]`이라고 씁니다.

<br />

## 화면

<table>
<tr>
<td width="50%" valign="top">

**Inbox**
점수순 후보 목록과 한 줄 이유. "글감 아님"도 정상 답이고, 사용자가 뒤집을 수 있습니다.

**Candidate**
왼쪽은 근거(버전, 스타, 다운로드, 데모 자산, 한계, 다이제스트). 오른쪽은 채널별 탭의 초안, 린트 결과, 복사 버튼.

</td>
<td width="50%" valign="top">

**Published**
올린 뒤 URL을 붙여 넣으면, 발행 전 기준선 대비 스타·방문자 추이와 직접 입력한 반응이 쌓입니다.

**Settings**
소스, 채널, 루브릭 가중치, 금지 표현, 문체 예시, 그리고 어떤 모델로 돌릴지.

</td>
</tr>
</table>

<br />

## 채널

| 채널 | 형식 | 언어 |
|---|---|---|
| X | 세 줄: 문제 · 무엇을 하나 · 숫자 하나 또는 한계 하나 + 링크 | en, ko |
| Threads | 한두 문장, 입장이나 질문으로 끝 | ko |
| LinkedIn | 접힘선 위 훅, 3~5문단, 해시태그 최대 3 | ko |
| Show HN | 제목 + 작성자 첫 댓글: 문제, 원리, 설계 결정, 한계, 열린 질문 하나 | en |
| Show GN | 무엇 / 왜 / 다른 점 / 결정 / 한계 / 원하는 피드백 | ko |
| 블로그 | 개요만: 제목 후보 3, 절 구조, 어느 숫자를 어디에 | ko |

모든 초안은 **슬롭 린트**를 거칩니다. 금지 표현, 이모지 목록, 숫자 없음, 한계 없음, 링크 없음, 감탄부호, 투표 요청.

<br />

## 모델과 키

| 프로바이더 | 기본 모델 | 키 |
|---|---|---|
| **Gemini** (기본) | `gemini-3.5-flash-lite` | 서버 키 풀 또는 내 키 |
| Anthropic | `claude-opus-5` | 내 키 |
| OpenAI 호환 | `gpt-5` | 내 키, base URL 선택 (OpenRouter, Ollama 등) |
| **로컬 에이전트** | 내 Claude Code 또는 Codex 구독 | 키 없음. 내 컴퓨터의 워커가 작업을 가져간다 |

로컬 에이전트 모드는 판단과 초안을 작업 큐에 넣습니다. CLI가 로그인된 컴퓨터에서 워커를 켭니다.

```bash
node scripts/agent-worker.mjs --cli claude    # 또는 --cli codex
```

<br />

## 실행

```bash
npm install
npx convex dev                                        # 로컬 Convex. .env.local에 VITE_CONVEX_URL을 써 준다
npx convex env set SOMUN_ALLOW_ANONYMOUS true         # 로컬 전용
npx convex env set GITHUB_TOKEN "$(gh auth token)"
npx convex env set GEMINI_API_KEYS '{"free-1":"..."}' # 라벨 붙은 JSON 맵. 유료 키는 순환에 넣지 않는다
npm run dev                                           # http://localhost:5180

node scripts/seed.mjs                                 # best-practice 문체 예시 (1회)
node scripts/omp-sync.mjs --days 14                   # 선택: oh-my-prompt 세션 요약 부착
```

Settings에서 GitHub 소스(`Open330`, `you/repo`)를 추가하고 Inbox의 **지금 확인**을 누르세요.

```bash
npm run typecheck && npm test
```

<br />

## 배포

다른 `*.jiun.dev` 앱과 같은 구조입니다. 셀프호스트 Convex(`somun-api.jiun.dev`), `api.jiun.dev`의 OAuth와 RS256 외부 JWT(audience `somun`), `docker/Dockerfile.web`의 정적 웹(`somun.jiun.dev`).

```bash
CONVEX_SELF_HOSTED_URL=https://somun-api.jiun.dev CONVEX_SELF_HOSTED_ADMIN_KEY=… npx convex deploy
docker build -f docker/Dockerfile.web --build-arg VITE_CONVEX_URL=https://somun-api.jiun.dev --build-arg VITE_AUTH_URL=https://api.jiun.dev -t somun-web .
```

jiun-api 쪽 준비: `JWT_EXTERNAL_AUDIENCES`에 `somun`, `JIUN_SERVICES`에 `{"id":"somun","redirectUris":["https://somun.jiun.dev/auth/callback"]}`, CORS 허용 원본에 `https://somun.jiun.dev`.
서버 환경변수: `GITHUB_TOKEN`, `GEMINI_API_KEYS`. 클라우드에서 `SOMUN_ALLOW_ANONYMOUS`는 설정하지 않습니다.

<br />

## 구조

```
convex/
  schema.ts          sources → signals → candidates → judgments → drafts → publications → metricSnapshots
  collect.ts         GitHub / npm 수집: 릴리스, 머지 PR, 마지막 릴리스 이후 커밋, 마일스톤, 트래픽
  signals.ts         신호 → 후보 묶기 (연속 릴리스 병합, 릴리스에 PR 부착)
  llm.ts · jobs.ts   다이제스트 → 판단 → 초안 실행기, 로컬 에이전트 작업 큐, 결과 반영
  lib/providers.ts   Gemini 키 풀 · Anthropic · OpenAI 호환
  lib/prompts.ts     프롬프트 셋과 JSON 스키마
  lib/channels.ts    채널별 형식, 규칙, 이미지 안내, 작성 화면 링크
  lib/lint.ts        슬롭 린트
  drafts.ts          복사 / 수정 / 버림 → 문체 예시와 피드백
  omp.ts             oh-my-prompt 세션 요약을 근거로
  crons.ts           매일 09:00 KST
src/                 Inbox · Candidate · Published · Settings
scripts/             seed.mjs · omp-sync.mjs · agent-worker.mjs
seeds/               실제로 통한 Show HN 첫 댓글 38건과 채널별 규칙
docs/spec.md         이 도구를 만든 기획
```

<br />

<div align="center">
<sub><a href="https://github.com/Open330">Open330</a>이 만들었습니다. 첫 런칭 대상: <a href="https://github.com/Open330/muxa">muxa</a>.</sub>
</div>
