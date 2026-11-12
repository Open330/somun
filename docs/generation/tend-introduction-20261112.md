# Tend 첫 소개 실제 생성과 사람 수정 — 2026-11-12

`Open330/tend`를 소스로 somun을 실제로 돌려 X 한국어·영어 첫 소개 초안을 만들었다. 이어 사람이 읽고 고친 곳을 기록했다. 마지막 절에는 사용자가 게시 여부와 계정을 정할 최종 초안과 2주 게시안을 둔다. **게시는 하지 않았다.** 어느 계정에 올릴지는 사용자가 정한다.

## 실행 환경

- 코드: PR #92(소개 판단) + #93(말투 검사) + 언어 수정 브랜치 `fix/draft-language-20261112`. 첫 회차는 언어 수정 전 코드로 돌렸다.
- 격리 서버: 스크래치 디렉터리의 새 SQLite(`DATA_DIR`), 포트 18791, 단일 토큰 인증. 크론은 1월 1일로 미뤄 자동 수집이 돌지 않게 했다. 게이트웨이·사용량 보고는 끄고 운영 DB는 열지 않았다.
- 모델: `gemini-3.5-flash-lite`(공유 무료 키 2개, `free-2`·`free-3`). GitHub은 `gh auth token`으로 공개 저장소를 읽었다.
- 설정: 기본값에서 채널만 X 한국어·영어로 바꿨다(문체 `plain`, 예시 사용 켬, 예시 없음).
- 흐름: `POST /sources`(Open330/tend) → `POST /collect`(신호 140건, 글감 1건 `Open330/tend v0.10.11`) → 프로필 생성 → `POST /candidates/1/rejudge` → `POST /candidates/1/redraft`(x/ko, x/en).

생성된 프로필(수정하지 않음):

```
what: CLI tool.
audience: Developers who run coding agents in tmux.
claims: Tracks agent state from Claude Code, Codex, and Gemini CLI sessions. / Provides a tmux status line summary and desktop notifications. / Jumps directly to the agent blocked longest via tend attend. / Maintains prompt history and agent state duration analytics.
stage: beta, naming: tend, unreleased: (비어 있음)
```

## 1회차 (언어 수정 전)

판단은 `draft`, 소개 기준 6.7점(runnable 2·numbers 0·lesson 1·novelty 0·audience 2)이었다. 같은 점수를 예전 규칙(5개 항목 합계)으로 계산하면 5.0점 `defer`다. **PR #92가 9/25의 "소개를 보류" 문제를 실제로 바꾼 것을 확인했다.** 다만 모델은 "릴리스 이력이 쌓인 기존 도구"라며 novelty를 0으로 줬다.

초안:

- X 한국어 v1: `tmux에서 Claude Code나 Codex 같은 코딩 에이전트의 대기 상태를 파악하고 가장 오래 막힌 에이전트로 바로 이동할 수 있는 tend입니다. tend watch와 tend attend를 사용합니다. https://open330.github.io/tend/`
- X 영어 v1: **한국어로 나왔다.** `tmux에서 Claude Code나 Codex 같은 코딩 에이전트를 실행할 때 상태를 한눈에 파악하고 …`

원인: 판단의 각도(angle)가 화면 언어(한국어)로 저장되고, X 채널의 독자·목적·문체 설명도 한국어다. 둘 다 영어 프롬프트에 언어 경계 없이 들어갔다. 영어 초안에 한국어 문장이 있어도 걸러내는 검사가 없었다.

이 회차에서 나온 수정:

- `9f138f2` fix(judge): 소개 판단의 novelty를 릴리스 이력으로 깎지 않게 함(#92에 추가).
- `3a8af6b` fix(drafts): 다른 언어의 각도는 생각만 따르게 하고, `wrong_language` lint를 추가했다. 편집 저장 때도 초안 언어로 검사한다(새 PR).

## 2회차 (수정 후)

판단은 `draft`, 소개 기준 10점(runnable 2·numbers 0·lesson 0·novelty 2·audience 2). 이유: "아직 X 채널에 소개된 적이 없어 신선도가 높으며…"

- X 한국어 v3 (289/280, `length` 경고): `tmux에서 실행 중인 Claude Code, Codex, Gemini CLI 세션이 입력을 기다릴 때 바로 해당 창으로 전환해 주는 터미널 운영 플랫폼 tend를 사용해 작업을 관리하세요. 3.x 버전의 tmux와 유닉스 계열 OS 환경에서 tend attend를 실행하여 가장 오래 멈춘 에이전트로 이동할 수 있습니다. https://open330.github.io/tend`
- X 영어 v2 (340/280, `length` 경고): `When managing multiple coding agent sessions in tmux, tend watches Claude Code, Codex, and Gemini CLI sessions, tells you when one stops for input, and jumps straight to its pane. You can use tend attend to focus the waiting agent or tend watch to inspect the live TUI. Requires tmux 3.x or herdr and a Unix-like OS. https://open330.github.io/tend/`

영어는 영어로 나왔다. 두 초안 모두 자동 보정 뒤에도 X 길이를 넘었고, 형식 경고는 길이와 원문 조건 확인 두 가지였다. 새 말투 규칙 다섯 가지에는 걸리지 않았다.

## 사람이 고친 곳

| 초안 | 고친 곳 | 이유 | 자동 검사가 잡았나 |
|---|---|---|---|
| 공통 | `tend` → `Tend` | 홈페이지 제목과 README 산문은 `Tend`로 쓴다. 프로필 생성이 CLI 이름을 공개 이름으로 골랐다 | 아니오. 프로필 `naming`을 사람이 고쳐야 한다 |
| 공통 | 길이를 280 안으로 줄임 | X 가중 길이 초과 | 예(`length`). 자동 보정이 한 번에 줄이지 못했다 |
| 공통 | 요구 사항(tmux 3.x·Unix 계열) 문장 삭제 | 첫 소개의 길이 예산에서 독자 상황과 동작이 먼저다. 조건은 링크 페이지에 있다 | 해당 없음(편집 판단) |
| 한국어 | `~를 사용해 작업을 관리하세요` 삭제 | 독자에게 행동을 권하는 말투이고 정보가 없다 | 아니오. `self_promotion` 목록에 "관리하세요" 같은 일반 명령형은 없다(오탐을 피하려고 일부러 뺐다) |
| 한국어 | `터미널 운영 플랫폼` 삭제 | README 첫 줄 "operations platform for your team of coding agents"에서 온 말이라 근거는 있다. 그러나 첫 소개의 한 문장 안에서는 분류어보다 하는 일이 먼저다 | 해당 없음(편집 판단) |
| 한국어 | `3.x 버전의 tmux` → 삭제 | 어순이 어색하고(tmux 3.x), 위와 같은 이유로 뺐다 | 아니오 |
| 한국어 v1 | `~할 수 있는 tend입니다. tend watch와 tend attend를 사용합니다.` | 문장 끝에 이름을 붙인 번역투이고, 명령 이름 나열은 동작을 설명하지 않는다 | 아니오 |
| 영어 | `When managing multiple coding agent sessions` → 독자 상황을 묻는 첫 문장 | 주어 없는 분사구가 Tend를 꾸미는 어색한 문장 | 아니오 |

자동 검사가 잡지 못한 것 가운데 반복될 만한 것은 공개 이름의 대소문자(프로필)와, 자동 보정이 길이를 한 번에 맞추지 못하는 점이다. 둘 다 후속 과제로 남긴다.

## 최종 초안 (사용자 승인 대상)

두 초안 모두 `lintDraft`(소개 목적, 홈페이지 우선 링크, README·홈페이지 원문 대조)를 통과했다. X 가중 길이는 한국어 267/280, 영어 278/280이다.

**X 한국어**

```
tmux에 Claude Code, Codex, Gemini CLI를 여러 개 띄워 두면 어느 창이 내 답을 기다리는지 놓치기 쉽습니다. Tend는 이미 쓰고 있는 세션을 그대로 지켜보다가 입력·선택·오류로 멈춘 창을 알려 주고, tend attend로 가장 오래 기다린 창에 바로 데려다줍니다.
https://open330.github.io/tend/
```

**X 영어**

```
Running several Claude Code, Codex or Gemini CLI sessions in tmux? Tend watches the ones you already have, tells you when one stops for input, a choice or an error, and `tend attend` jumps to the pane that has waited longest. No wrapper, no new terminal.
https://open330.github.io/tend/
```

첨부 이미지 후보: README의 `docs/demo.gif`(tend watch와 tend attend 화면).

근거: 홈페이지 첫 문단("Tend watches the Claude Code, Codex, and Gemini CLI sessions you already run in tmux, tells you the moment one stops for input, a choice, or an error, and takes you straight to its pane. No wrapper, no new terminal.")과 README의 `tend attend` 설명("focuses the pane blocked longest"). 작성자의 경험이나 수치는 쓰지 않았다.

## 2주 게시안 (2026-11-17 ~ 11-28)

X에 한국어·영어를 같은 날 올리는 안이다. 계정은 사용자가 정한다. 각 편은 앞 편에서 말한 것을 반복하지 않는다. 2·3편 초안은 길이(216~258/280)와 말투 검사를 통과했다. 소개 글용 홈페이지 링크 규칙에만 걸리는데, 후속 편이라 다른 링크를 쓰는 것이 의도다.

| # | 날짜 | 주제 | 근거 | 상태 |
|---|---|---|---|---|
| 1 | 11/17(화) | 소개: 기다리는 창을 알려 주고 데려다준다 | 홈페이지 첫 문단, README `tend attend` | 위 최종 초안 |
| 2 | 11/19(목) | 사용 장면: 설치 전에 브라우저에서 해 보기 | README "Try tend in your browser"와 Watch and collaboration 트랙 | 초안 있음 |
| 3 | 11/24(화) | 동작 원리: 감싸지 않고 훅과 화면으로 읽는다 | README "Keeps your setup" | 초안 있음 |
| 4 | 11/26(목) | 겪은 문제 | **근거 필요.** 작성자가 실제로 겪은 일(예: 에이전트가 답을 기다리는 줄 모르고 지나친 경험)을 직접 적어 주셔야 한다. 지어내지 않는다 | 작성자 입력 대기 |
| 5 | 11/28(금) | 시연: 에이전트 여러 개에서 `tend attend`로 옮겨 가는 30초 화면 | `docs/demo.gif`를 쓰거나 새로 녹화 | 녹화 필요 |

**2편 사용 장면**

```
Tend는 설치하기 전에 브라우저에서 먼저 써 볼 수 있습니다. 준비된 tmux 화면에서 답을 기다리는 에이전트에 응답하고, 리뷰를 요청하고, 메일함에서 답장을 읽어 봅니다. 실제 명령은 실행되지 않습니다.
https://open330.github.io/tend/learn/
```

```
You can try Tend in the browser before installing it. A prepared tmux session walks you through answering a waiting agent, requesting a review and reading the reply in the mailbox. It runs no real shell commands or agent API calls.
https://open330.github.io/tend/learn/
```

**3편 동작 원리**

```
Tend는 에이전트를 감싸서 실행하지 않습니다. Claude Code, Codex, Gemini CLI의 훅으로 상태를 읽고, 훅이 없는 에이전트는 화면으로 판단해 지금 열린 tmux 창에 연결합니다. 에이전트는 쓰던 방식대로 띄우면 됩니다.
https://github.com/Open330/tend
```

```
Tend doesn't wrap your agents. It reads state from Claude Code, Codex and Gemini CLI hooks, falls back to screen detection for agents without hooks, and maps it onto the tmux panes you already have. Launch agents the way you do today.
https://github.com/Open330/tend
```

## 사용자 확인 필요

1. **게시 계정**: 개인 계정(@baejiun)인지 브랜드 계정(open330)인지 정해 주세요. 정하기 전에는 어디에도 올리지 않습니다.
2. **공개하지 않은 기능**: README에는 Tend for Mac, Fleet hosts, `tend swap`의 `aas` 연동, Dashboard도 있습니다. 운영에서 감추거나 아직 알리지 않을 기능이 있으면 알려 주세요. 프로필의 "공개하지 않은 기능"에 넣고, 이 게시안에서도 뺍니다(지금 초안에는 이 기능들을 쓰지 않았습니다).
3. **4편 겪은 문제**: 실제로 겪은 일을 한두 문장으로 주시면 그 문장만 근거로 씁니다.
4. **5편 시연**: 기존 `docs/demo.gif`로 갈지, 새로 녹화할지 정해 주세요.
