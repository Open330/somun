# 소문 (somun) — 기획 v0 (2026-09-20)

## 이름

**소문 (somun)** — "소문내다"에서. 사용자가 아니라 도구가 소문을 낸다.
서비스 somun.jiun.dev · 저장소 Open330/somun · npm `somun` · CLI `somun`

> 소문 — 소문낼 줄 모르는 개발자를 위한 PR 도우미.
> somun — PR for developers who'd rather build than announce.

## 한 줄

작업 내역을 지켜보다가 글감이 익으면, 채널별 초안을 써서 내밀고, 사람이 고쳐서 올린 결과로 다음 초안을 더 잘 쓰는 편집자.

- 하는 것: 관찰 → 판단 → 채널별 초안 → 복사 → 피드백 수집 → 개선
- 하지 않는 것: 자동 발행(v0), 커밋 단위 포스트, 근거 없는 문장

## 파이프라인

```
Sources ──▶ Signals ──▶ Candidates ──▶ Judgment ──▶ Drafts(채널별) ──▶ Review ──▶ Publication ──▶ Metrics
   ▲                                      ▲              ▲                │                              │
   └──────────────── Feedback ────────────┴──────────────┴────────────────┴──────────────────────────────┘
```

### 1. Sources (관찰)
v0는 GitHub만. 이후 확장.

| 소스 | 신호 | v0 |
|---|---|---|
| GitHub (jiunbae, Open330) | 릴리스, 머지된 PR, 새 레포, README 변경, 스타/포크 변화 | O |
| npm / Homebrew | 다운로드 추이 | O (스냅샷만) |
| 블로그 레포 | 새 글 | O |
| oh-my-prompt (omp) | 세션에서 반복된 문제, 오래 걸린 작업 (실패담 후보). SQLite/FTS5 직접 읽기, tags로 역기록 | O |
| muxa stats | 에이전트 작업/대기 시간 (숫자 있는 글감) | 이후 |
| Linear | 완료된 이슈 묶음 | 이후 |

수집 주기: 하루 1회 (09:00 KST). 사용자가 "지금 확인"도 가능.

### 2. Candidates (묶기)
신호를 커밋 단위가 아니라 **의미 단위**로 묶는다. 묶는 규칙:
- 같은 레포의 릴리스 하나 + 그 사이 머지된 PR들 = 후보 1개
- 새 레포 + 첫 README = 후보 1개
- 스타·다운로드 임계 통과(예: 첫 100 다운로드, 스타 50) = 후보 1개 (마일스톤형)
- 블로그 글 1개 = 후보 1개 (재배포형)
- 같은 주제로 3일 이상 이어진 PR 묶음 = 후보 1개 (진행형, "왜 오래 걸리나" 글감)

### 3. Judgment (글감인가)
LLM 판정 + 규칙. 점수와 **이유를 반드시 남긴다** (사용자가 이유를 보고 반박하는 게 피드백의 원천).

루브릭 (각 0~2):
- 실행 가능한가: 링크 눌러 1분 안에 써볼 수 있는가
- 숫자가 있는가: 측정치, 전후 비교, 기간
- 배운 게 있는가: 실패, 되돌린 결정, 의외의 사실
- 새로운가: 최근 30일 발행물과 겹치지 않는가
- 청중이 있는가: 어느 채널의 누가 왜 관심 있을지 한 문장으로 말할 수 있는가

임계: 합 6 이상이면 "초안 작성", 4~5는 "보류(사유 표시)", 3 이하는 "묻기만".
사용자 오버라이드 가능. 오버라이드는 그대로 피드백 예시가 된다.

### 4. Drafts (채널별 초안)
원칙: **사실은 시스템이, 목소리는 사용자가.** 모든 초안은 Evidence 블록을 먼저 갖는다.

Evidence 블록 (자동, 링크 포함): 레포, 버전, 릴리스 노트 요약, 스타/다운로드, 커밋 수, 첫 릴리스일, 데모 GIF 경로, 알려진 한계(README에서 추출).

채널 어댑터:

| 채널 | 형식 | 제약 |
|---|---|---|
| X (en) | 3줄: 문제 / 무엇 / 숫자+링크 | 280자, 이미지 슬롯 지정 |
| X (ko) | 위와 동일, 한국어 | |
| Threads | 대화체, 1~2문장, 질문으로 끝 | 500자 |
| LinkedIn (ko) | 첫 줄 훅 + 3~5문단 + 링크 | 장문, 해시태그 최대 3 |
| Show HN | 제목 + 첫 댓글(문제/접근/한계 2~3개/질문 1개) | 제목 80자, 투표 요청 문구 금지 |
| Show GN | 제목 + 사실 기반 본문(무엇/다른 점/기술/한계/원하는 피드백) | 마케팅 어휘 금지 |
| 블로그 (ko) | 개요만 (제목 후보 3, 절 구조, 넣을 숫자) | 본문은 쓰지 않음 |

슬롭 린트 (초안 저장 전 자동 검사, 실패 항목 표시):
- 숫자 1개 이상, 한계 1개 이상
- 금지어: excited to announce, revolutionize, game-changer, 🚀 등 목록
- 이모지 글머리 목록 금지
- 실행 가능한 링크 1개 이상
- 사용자 승인 예시와의 문체 유사도 (few-shot에서 크게 벗어나면 경고)

### 5. Review (검수와 복사)
화면 하나에서 채널 탭을 넘기며 본다. 각 초안에 세 버튼: 복사 / 수정 후 복사 / 버리기.
- 수정 후 복사: 수정 전후 diff를 저장 → 다음 초안의 few-shot 예시로 승격 (자동)
- 버리기: 사유 선택 (사실 틀림 / 문체 / 채널 안 맞음 / 아직 이름) → Judgment와 어댑터에 반영
- 복사 후 "올렸어요" 누르면 발행 URL 입력란이 뜬다

### 6. Publication & Metrics
발행 URL이 등록되면 그 시각부터 추적:
- GitHub 스타, 트래픽(referrers, uniques), npm 다운로드: 하루 1회 스냅샷, 발행 전 7일 기준선과 비교
- 채널 반응(좋아요·댓글)은 v0에서 수동 입력 (API 비용·제한)
- 후보 단위 리트로 화면: 어느 채널이 실제로 움직였나

### 7. Feedback (루프)
세 종류 신호를 모아 세 곳에 되먹인다.

| 신호 | 어디로 | 방식 |
|---|---|---|
| 판단 오버라이드 (글감 아님/맞음) | Judgment | 루브릭 가중치 조정 + 예시 저장 |
| 수정 diff, 버림 사유 | 채널 어댑터 | few-shot 예시 교체(최근 승인 N개), 금지 표현 추가 |
| 발행 후 지표 | 채널 추천 순서 | 후보 유형별 채널 성과를 다음 판단의 "청중" 항목에 반영 |

학습은 하지 않는다. 예시 코퍼스와 가중치만 바꾼다. 모든 변화는 설정 화면에서 보이고 되돌릴 수 있다.

## 데이터 모델 (Convex)

- sources: {ownerId, kind, config, lastPolledAt}
- signals: {ownerId, sourceId, kind, repo, ref, payload, occurredAt}
- candidates: {ownerId, title, signalIds[], type(release|new-repo|milestone|blog|in-progress), evidence, status(new|judged|drafted|published|dropped)}
- judgments: {candidateId, scores{5}, total, reasoning, decision, overriddenBy?, overrideReason?}
- drafts: {candidateId, channel, version, body, lintResults[], mediaSlots[], status(proposed|edited|copied|dropped)}
- draftEdits: {draftId, before, after, promotedToExample:boolean}
- examples: {ownerId, channel, body, source(approved|edited|seed), active:boolean}
- publications: {candidateId, channel, url, publishedAt}
- metricSnapshots: {candidateId, at, stars, uniques, referrers, npmDownloads}
- feedback: {targetType, targetId, reason, note}

## 화면 (v0, 4개)

1. Inbox: 후보 목록. 점수, 이유 한 줄, 유형 배지. "초안 보기 / 아님 / 나중에"
2. Candidate: 좌측 Evidence, 우측 채널 탭별 초안 + 린트 결과 + 복사/수정/버림. 하단 "올렸어요 → URL"
3. Published: 발행물 목록과 지표 스파크라인, 리트로
4. Settings: 소스 연결, 채널 on/off, 예시 코퍼스 관리, 금지어, 루브릭 가중치

## 스택 (daily 재사용)

- 웹: Expo Router 웹 빌드 or Next.js 중 daily와 동일한 쪽. 모바일은 v0 제외
- 데이터·크론: 셀프호스트 Convex (스케줄드 함수로 09:00 수집)
- 인증: api.jiun.dev JWT, ownerId 스코프
- LLM: 판정·초안 모두 API 호출. 모델은 구현 시 claude-api 스킬로 확인해 선택
- 배포: 기존 k8s + ArgoCD, somun.jiun.dev ingress
- 저장소: Open330/somun (공개, Apache-2.0)

## v0 완료 조건

muxa 다음 릴리스가 나왔을 때, 다음 날 아침 Inbox에 후보가 떠 있고, X(en/ko)·LinkedIn·Show HN 초안을 복사해서 손으로 올린 뒤 URL을 등록하면, 일주일 뒤 스타 추이가 보인다. 그리고 두 번째 릴리스의 초안이 첫 번째에서 내가 고친 문체를 따라온다.

## 열린 질문

3. ~~oh-my-prompt 읽기 범위~~ → 전문 읽기 확정 (2026-09-20). 시드 → best practice 코퍼스로 확정. 한/영 문체 분리 확정.
