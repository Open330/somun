# 소문 (somun)

**소문낼 줄 모르는 개발자를 위한 PR 도우미.**
somun — PR for developers who'd rather build than announce.

작업 내역을 지켜보다가 글감이 익으면, 채널별(X, Threads, LinkedIn, Show HN, Show GN) 초안을 써서 내밀고, 사람이 고쳐서 올린 결과로 다음 초안을 더 잘 쓰는 편집자.

- 하는 것: 관찰 → 판단 → 채널별 초안 → 복사 → 피드백 → 개선
- 하지 않는 것: 자동 발행, 커밋 단위 포스트, 근거 없는 문장

원칙 하나. **사실은 시스템이, 목소리는 사람이.** 모든 초안은 자동 수집된 근거(릴리스, 스타, 다운로드, 한계) 위에서만 쓰이고, 저장 전에 슬롭 린트를 통과해야 한다.

## 구조

```
sources ─▶ signals ─▶ candidates ─▶ judgments ─▶ drafts ─▶ publications ─▶ metricSnapshots
                                        ▲             ▲           │
                                        └─ feedback ──┴─ examples ┘
```

| 디렉터리 | 내용 |
|---|---|
| `convex/schema.ts` | 데이터 모델 (소유자 스코프) |
| `convex/collect.ts` | GitHub·npm 수집기 (릴리스, 머지 PR, 새 레포, 스타·다운로드 임계, 트래픽 스냅샷) |
| `convex/signals.ts` | 신호 → 의미 단위 후보 묶기 (연속 릴리스 병합, 릴리스 앞 PR 부착) |
| `convex/llm.ts` | 판단(5항목 루브릭 + 이유)과 채널별 초안. Claude API 구조화 출력 |
| `convex/lib/channels.ts` | 채널 어댑터: 형식 제약, 작성 규칙, 이미지 안내, 작성 화면 링크 |
| `convex/lib/lint.ts` | 슬롭 린트: 금지어, 이모지 목록, 숫자·한계·링크 필수, 투표 요청 금지 |
| `convex/drafts.ts` | 복사/수정/버림. 수정 diff → 문체 예시 자동 승격, 버림 사유 → feedback |
| `convex/omp.ts` + `scripts/omp-sync.mjs` | oh-my-prompt 세션 요약을 후보 근거로 부착 |
| `convex/crons.ts` | 매일 09:00 KST 수집 → 판단 → 초안 |
| `src/` | Inbox · Candidate · Published · Settings (Vite + React) |
| `seeds/` | best-practice 시드 코퍼스 (Show HN 첫 댓글 38건 + 채널 규칙) |

## 실행 (로컬)

```bash
npm install
npx convex dev                       # 로컬 익명 Convex 백엔드. .env.local에 VITE_CONVEX_URL을 써 준다
npx convex env set SOMUN_ALLOW_ANONYMOUS true
npx convex env set GITHUB_TOKEN "$(gh auth token)"
npx convex env set ANTHROPIC_API_KEY sk-ant-...
npm run dev                          # http://localhost:5180

node scripts/seed.mjs                # 시드 예시 넣기 (1회)
node scripts/omp-sync.mjs --days 14  # omp 세션 요약 부착 (선택, 로컬 omp.db 읽기)
```

Settings에서 GitHub 소스(`Open330`, `jiunbae/oh-my-prompt` 등)를 추가하고 Inbox의 "지금 확인"을 누르면 후보가 뜬다.
판단과 초안은 `ANTHROPIC_API_KEY`가 있어야 돈다. 없으면 후보 수집까지만 된다.

```bash
npm run typecheck && npm test
```

## 검수 루프

- **복사**: 그대로 승인. 본문이 `approved` 예시로 저장된다.
- **수정 후 복사**: before/after가 `draftEdits`에, 수정본이 `edited` 예시로 저장된다. 채널당 사용자 예시가 5개 쌓이면 시드는 비활성화된다.
- **버리기**: 사유(사실 틀림 / 문체 / 채널 / 아직 / 글감 아님)가 `feedback`에 남고 다음 판단 프롬프트에 들어간다.
- **올렸어요**: URL 등록 시점부터 스타·방문자·다운로드 스냅샷을 발행 전 기준선과 비교한다.

## 클라우드 배포

daily와 같은 구조. 셀프호스트 convex-backend(`somun-api.jiun.dev`), jiun-api(`api.jiun.dev`)의 OAuth와 RS256 외부 JWT(aud `somun`), 정적 웹(`somun.jiun.dev`, `docker/Dockerfile.web`).

jiun-api 쪽 준비: `JWT_EXTERNAL_AUDIENCES`에 `somun` 추가, `JIUN_SERVICES`에 `{"id":"somun","redirectUris":["https://somun.jiun.dev/auth/callback"]}`, CORS 허용 원본에 `https://somun.jiun.dev`.

```bash
CONVEX_SELF_HOSTED_URL=https://somun-api.jiun.dev CONVEX_SELF_HOSTED_ADMIN_KEY=... npx convex deploy
docker build -f docker/Dockerfile.web --build-arg VITE_CONVEX_URL=https://somun-api.jiun.dev --build-arg VITE_AUTH_URL=https://api.jiun.dev -t somun-web .
```

Convex 서버 환경변수: `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, 선택 `SOMUN_MODEL`. 클라우드에서는 `SOMUN_ALLOW_ANONYMOUS`를 설정하지 않는다.

기획 문서: [docs/spec.md](docs/spec.md)

License: Apache-2.0
