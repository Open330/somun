<div align="center">

<br />

<img src="docs/brand/lockup.png" alt="소문" width="420" />

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
   │  4. 초안         │    사실은 다이제스트에서만, 문체는 프리셋·내 지침·복사한 글에서,
   └────────┬────────┘    숫자는 원자료와 맞춰 보고, 슬롭 린트를 통과한 뒤에 보여준다
            ▼
   ┌─────────────────┐    복사 · 수정 후 복사 · 버리기(사유) · "올렸어요, URL은 이것"
   │  5. 사용자       │
   └────────┬────────┘
            ▼
   ┌─────────────────┐    복사한 글 → 문체 예시 · 수정·버림 → 지침 제안 · 버림 → 판단 보정
   │  6. 학습         │    URL → 발행 전 7일 추세를 뺀 스타 증가, 채널 추천에 반영
   └─────────────────┘
```

**사실은 시스템이, 목소리는 사람이.** 초안은 원자료(릴리스 노트, PR 제목, 커밋, README, 저장소 통계)에 있는 숫자만 씁니다. 숫자가 없으면 그 주장을 빼고, 지어내지 않습니다. 다이제스트도 검사합니다. 원자료에 없는 숫자가 든 요약 줄은 판단과 초안에 넘기지 않고 글감 화면에 따로 보여줍니다. 그래도 초안에 원자료에서 찾지 못한 숫자("3배", "twice" 같은 배수 포함)가 있으면 표시하고, 복사할 때 한 번 더 확인합니다.

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
올린 뒤 URL을 붙여 넣으면(나중에 고치거나 지울 수 있습니다), 발행 후 7일 스타 증가에서 발행 전 7일 추세만큼을 뺀 값, 방문자, 반응(X·HN은 자동, 나머지는 직접 입력)이 쌓입니다. 채널별 결과는 판단이 채널을 추천할 때 참고합니다.

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

모든 초안은 **슬롭 린트**를 거칩니다. 금지 표현, 이모지 목록, 원자료에 없는 숫자, 지어낸 한계, 틀린 저장소 이름, 링크 없음, 감탄부호, 투표 요청, 길이.

**학습이 되고 있나?** 문체 화면에서 복사한 초안을 그대로 쓴 비율과 고친 양을 주별·문체 설정 버전별로 보여줍니다. 지침과 예시가 효과가 있다면 고친 양이 줄어야 합니다. `npm run experiment -- export-holdout`는 복사한 초안으로 개인 보류 평가 세트를 만듭니다(`experiments/holdout/`, git 제외). 기준 답은 내가 복사한 최종본입니다.

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
npm run agent-worker -- --cli claude    # 또는 --cli codex
```

<br />

## 실행

프로세스 하나, SQLite 파일 하나. 외부 서비스 없음.

```bash
nvm install && nvm use          # .nvmrc: CI/Docker와 같은 Node 22 계열
npm ci
cp .env.example .env            # GITHUB_TOKEN, GEMINI_API_KEYS 채우기. 로컬은 SOMUN_ALLOW_ANONYMOUS=true
npm run dev                     # API :8790, 웹 :5180

npm run seed                    # best-practice 문체 예시 (1회)
npm run push -- --sources omp --days 14   # 선택: oh-my-prompt 세션 요약 부착
```

Settings에서 GitHub 소스(`Open330`, `you/repo`)를 추가하고 Inbox의 **지금 확인**을 누르세요.

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

<br />

GitHub App을 웹에서 처음 등록하려면 `SOMUN_ADMIN_OWNER_ID`에 운영자의 `/api/me` 응답 `ownerId`를 지정합니다. 공유 토큰의 기본값은 `local`입니다. 익명 로그인으로는 등록할 수 없습니다. 리버스 프록시 뒤에서는 `SOMUN_PUBLIC_URL`에 실제 HTTPS 주소를 지정하세요. 기존에 등록된 앱 사용에는 이 설정이 필요하지 않습니다.

로컬 워커는 서버와 같은 버전으로 업데이트한 후 재시작하세요. 완료 요청에 점유 토큰이 필요합니다. 점유는 10분 뒤 만료되며, 중단된 작업은 다음 폴링 때 최대 3회까지 재할당됩니다. 결과 형식 오류나 명시적 워커 실패는 자동 재시도하지 않습니다. 서버 시작 시 SQL 마이그레이션이 적용되며, 수동 적용은 `npm run db:migrate`입니다.

## 배포

컨테이너 하나. API와 빌드된 웹을 같은 Node 프로세스가 서빙하고, 데이터베이스는 볼륨의 파일 하나입니다.

```bash
docker build -f docker/Dockerfile -t somun .
docker run -p 8790:8790 -v somun-data:/data \
  -e SOMUN_TOKEN=change-me -e GITHUB_TOKEN=… -e GEMINI_API_KEYS='{"free-1":"…"}' somun
```

인증은 세 가지 중 하나입니다. 공유 토큰 `SOMUN_TOKEN`(단일 사용자), 신뢰하는 발급자의 RS256 JWT(`AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_AUDIENCE`. `somun.jiun.dev`가 `api.jiun.dev`를 쓰는 방식), 로컬 개발 전용 `SOMUN_ALLOW_ANONYMOUS=true`.

JWT 모드에서는 여러 사람이 각자 로그인해 쓰고, 소스·글감·초안·문체·발행 기록이 계정마다 따로 있습니다. 서버 `GITHUB_TOKEN`으로 비공개 저장소를 읽는 것은 `SOMUN_ADMIN_OWNER_ID`와 공유 토큰 소유자만 가능합니다. 다른 계정은 이 토큰으로 공개 저장소만 읽거나, 자기 GitHub App 설치를 연결합니다.

<br />

## 구조

계층은 안쪽으로만 의존합니다. `core`는 IO를 모르고, `app`은 HTTP를 모르고, `server`는 얇습니다.

```
src/
  core/        순수 도메인 — IO 없음, 단위 테스트 대상
    channels   채널별 형식, 규칙, 이미지 안내, 작성 화면 링크
    prompts    프롬프트 셋(다이제스트 · 판단 · 초안)과 JSON 스키마
    lint       슬롭 린트
    cluster    신호 → 후보 규칙, 마일스톤 임계
    keypool    Gemini 429 분류, 태평양 자정 기준 날짜 키
  app/         유스케이스 — AppContext(db, log, env, 이벤트 버스)를 받는다
    collect    GitHub / npm → 신호, 근거, 지표 스냅샷
    signals    묶기, 연속 릴리스 병합, PR 부착
    pipeline   다이제스트 → 판단 → 초안. 프로바이더 호출 또는 로컬 에이전트 큐. 결과 반영
    review     복사 / 수정 / 버림 → 문체 예시와 피드백
    publications · candidates · sources · settings · keys · jobs · sessions · scheduler
  infra/       어댑터 — SQLite(Drizzle), GitHub REST, LLM 프로바이더, 로거
  server/      Hono — 인증 미들웨어(토큰 · JWT · 익명), /api 라우트, SSE, 정적 웹
  shared/      서버와 웹이 공유하는 타입
  web/         Vite + React — Inbox · Candidate · Published · Settings
scripts/       seed · push-sessions · agent-worker (HTTP API만 사용)
drizzle/       SQL 마이그레이션, 시작 시 적용
seeds/         실제로 통한 Show HN 첫 댓글 38건과 채널별 규칙
```

웹은 데이터베이스를 직접 만지지 않습니다. `/api/*`를 읽고 `/api/events`(SSE)로 바뀐 자원만 다시 가져옵니다.

<br />

<div align="center">
<sub><a href="https://github.com/Open330">Open330</a>이 만들었습니다. 첫 런칭 대상: <a href="https://github.com/Open330/muxa">muxa</a>.</sub>
</div>

### 초안 품질 실험

`npm run experiment`로 모델 호출 없이 고정 사례를 재검사합니다. 실제 모델 반복 실행, 프롬프트 A/B 비교, 모델명을 가린 사람 평가와 회귀 비교는 [실험 안내](experiments/README.md)를 참고하세요. 자동 규칙 통과와 게시 가능한 품질은 별도로 평가합니다.
