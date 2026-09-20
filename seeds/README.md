# 시드 코퍼스 (best practice 기반, 2026-09-20 수집)

사용자 과거 글 대신, 검증된 고성과 게시물과 그 원칙에서 추린 시드. 채널 어댑터의 few-shot 초기값.
사용자가 "수정 후 복사"를 누를 때마다 이 시드는 사용자 예시로 점진 교체된다.

## Show HN — 실제 첫 댓글 (hn_seeds*.json, 300점+ 16건, 150점+ 데브툴 22건)

패턴이 명확하다. 잘 된 첫 댓글은 네 가지 중 하나 이상을 한다.
1. 작동 원리 2~3줄 + 라이브 데모 링크 (fugleramme, 2364p)
2. 범위 선언: "이건 X를 대체하려는 게 아니라 Y 순간을 위한 것" (Witr, 526p)
3. 질문 받겠다는 짧은 선언 + 어디 있을지 (Forge, 687p: "Happy to answer questions about the eval methodology... I'll be around.")
4. 발행 중 진행 상황을 그대로 (Whispering, 591p: "지금 릴리스 중, 이 PR 머지되면...")

공통: 형용사 없음, 첫 문장이 메커니즘 또는 범위, 링크는 실행 가능한 것, 감탄부호 거의 없음.

## X (영어) — 검증된 실제 텍스트

- Mitchell Hashimoto (Ghostty): "Ghostty 👻 devlog video: I'm working on search! Here's 15 minutes of me explaining why it has taken so long, what is hard about it, the architecture we're going for, and the big progress I've made recently. Progress PR if you'd rather read stuff: <link>"
  → 진행 중인 것, 왜 오래 걸리는지, 영상+PR 두 진입로.
- Peter Steinberger (OpenClaw): "PRs on OpenClaw are growing at an *impossible* rate. Worked all day yesterday and got like 600 commits in. It was 2700; now it's over 3100. I need AI that scans every PR and Issue and de-dupes."
  → 숫자 세 개, 현재형, 해결 안 된 문제로 끝남.

형식 규칙 (opentweet 2026 가이드 + HN 플레이북 종합):
- 1행 문제 / 2행 무엇을 만들었나 / 3행 숫자 또는 한계 + 링크
- 금지: excited to announce, revolutionize, game-changer, 🚀, 기능 나열
- 이미지: 터미널 GIF 또는 실제 출력 스크린샷 (홈 경로·내부 브랜치명 가리기)

## X (한국어)
영어와 같은 3행 구조. 존댓말 평서형("만들었습니다"), 감탄사 없음. GeekNews Show GN 문체와 호환되게.

## LinkedIn (한국어)
- 첫 줄: 결과 또는 문제 한 문장 (예: "에이전트가 멈춘 걸 30분 뒤에 알았습니다"). 접힘선 위에 훅.
- 본문 3~5문단: 문제 → 만든 것 → 숫자/전후 → 배운 것 → 링크
- 해시태그 최대 3개, 이모지 목록 금지, 스크린샷 1장
- 근거: 2026 가이드들 공통 — 결과/문제로 시작, 실제 데이터 스크린샷, 이야기형이 추상 주장보다 성과

## Threads
- 1~2문장, 대화체, 입장을 취하거나 질문으로 끝냄 ("Here is what I think about X" 형이 정보형보다 성과)
- 첫 30~60분 답글 속도가 노출 결정 → 올린 직후 답글 대기
- 예: "에이전트 다섯 개 돌리면 패널 오버레이가 맞나, 아니면 '나를 기다리는 것 큐'만 보고 패널은 아예 안 보는 게 맞나. 후자로 기울고 있음."

## Show GN
hada.io 가이드 그대로: 무엇을 / 왜 / 대안과 다른 점 / 기술 결정 / 한계 / 원하는 피드백. 마케팅 어휘 금지, 지인 투표 요청 금지, 버전마다 재등록 금지.
