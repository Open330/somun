# 프로젝트 점검 및 개선 — 2026-09-22

## 구조와 적용 원칙

`core`는 IO 없는 규칙과 프롬프트, `app`은 유스케이스, `infra`는 DB와 외부 서비스,
`server`는 HTTP, `web`은 React UI로 나뉜다. 현재 규모에서는 이 경계를 유지한다.
`app`은 Drizzle 스키마와 어댑터에 직접 의존하므로 엄격한 의존성 역전 구조는 아니다.
이번에는 저장소 전체를 추상화하거나 외부 큐를 도입하지 않고 실제 실패 경로를 보완했다.

## 적용한 개선과 근거

| 문제 | 적용한 변경 | 근거 |
| --- | --- | --- |
| 결과 적용 전에 작업을 완료로 표시; 중복 완료 요청이 결과 재생성 | `BEGIN IMMEDIATE` 트랜잭션 안에서 결과 검증·DB 반영·후속 작업 등록·완료 상태 저장. 이벤트는 커밋 뒤 발행 | [SQLite 트랜잭션](https://www.sqlite.org/lang_transaction.html) |
| 워커 중단 시 영구 점유 | 10분 임대, 점유마다 무작위 토큰 발급. 만료 작업은 폴링/claim 때 회수하고 최대 3회 시도. 예전 토큰의 완료 요청 거부 | [SQS visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)의 임대 원칙을 SQLite에 적용; SQS는 도입하지 않음 |
| 인증 없는 GitHub App 최초 등록 | 명시적인 운영자 ownerId와 인증 방식 확인 후 POST로 시작. 15분 만료 일회용 state를 DB에 해시로 저장하고 HttpOnly/SameSite 쿠키와 함께 검증. 외부 호출 전에 소모하고 기존 설정 덮어쓰기 금지 | [GitHub App manifest state](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) |
| 이전 HTTP 응답이 새 화면을 덮음 | 경로 변경·재조회·언마운트 시 AbortController 취소, 취소된 요청의 결과 무시 | [React Effect cleanup](https://react.dev/learn/synchronizing-with-effects#fetching-data) |
| SSE 연결과 인증 수명 분리 | 마지막 구독 해제 시 연결·재시도 정리. 인증 상태 변경 시 교체. 연결 오류 시 토큰을 다시 가져와 지수 백오프로 연결 | 같은 Effect 정리 원칙. 불필요한 전역 연결을 유지하지 않음 |
| 연결 화면의 조건부 Hook | 로딩 중 early return 앞에서 모든 Hook 호출 | [Rules of Hooks](https://react.dev/reference/rules/rules-of-hooks) |
| 사용량 outbox가 재시도 한도 도달 행에 막힘 | SQL에서 attempts 조건을 먼저 적용하고 오래된 전송 가능 행부터 선택. 한도 도달 행은 진단용으로 보존 | LIMIT 이전에 전송 대상을 선정하도록 실제 조회 순서 교정 |
| 린트 불능·검증 누락 | TypeScript ESLint 권장 규칙 + React Hook 호출 순서 검사, CI에서 실행. 테스트 파일도 타입 검사 | [typescript-eslint 설정](https://typescript-eslint.io/getting-started/) |
| Node ABI 불일치 | `.nvmrc` 22.22.1, CI에서 같은 파일 사용. Docker와 Node 22 계열 통일 | 기존 SQLite 바이너리 ABI 오류 재현에 따른 수정 |
| ORM 보안 공지 | Drizzle ORM을 0.45.3으로 업데이트 | [식별자 이스케이프 보안 공지](https://github.com/drizzle-team/drizzle-orm/security/advisories/GHSA-gpj5-g38j-94v9). 정적 스키마만 사용하는 코드는 해당 공격 조건에 해당하지 않음 |

앞선 수정도 포함한다: `db:migrate` CLI 복구, API JSON 404, 잘못된 JSON의 400,
예기치 않은 오류 상세 비노출, README 명령 교정.

## 운영 및 호환성

- **워커와 서버를 함께 업데이트하고 워커를 재시작한다.** `/jobs/:id/claim`의 응답에
  `claimToken`이 추가되고 `/complete`에는 이 토큰이 필수다. 성공·실패가 확정된 작업에 대한
  재요청은 결과를 다시 적용하지 않고 `{ applied: false }`를 반환한다.
- 10분은 기존 CLI 제한 5분에 전송 여유를 더한 프로젝트 기본값이다. 최대 3회는 최초 시도를
  포함한다. 자동 회수는 중단/만료된 작업만 대상으로 하며, 잘못된 결과와 명시적 워커 실패는
  `failed`로 남긴다. 긴 실행을 지원하려면 임대 연장 정책이 추가로 필요하다.
- SQL `0007_job-leases`는 토큰·시도 횟수를 추가한다. 이전 버전의 점유 작업은 재할당 가능하게
  `pending`으로 바꾼다. 기존 완료 결과나 후보 데이터는 삭제하지 않는다.
- 로컬 작업의 후속 단계는 같은 트랜잭션에서 로컬 큐에 저장한다. 진행 중 설정의 LLM
  프로바이더를 바꿔도 이미 실행 중인 로컬 체인은 로컬 큐로 이어진다.
- `SOMUN_ADMIN_OWNER_ID`가 비어 있으면 웹에서 최초 등록을 시작할 수 없다. 공유 토큰의
  기본 ownerId는 `local`, JWT는 `/api/me`의 ownerId다. 익명 인증은 운영자로 취급하지 않는다.
- 리버스 프록시 환경에서는 `SOMUN_PUBLIC_URL`에 공개 HTTPS URL을 설정해야 한다.
  등록 도중 upstream 오류가 발생하면 일회용 state 재사용 대신 등록을 다시 시작한다.
  동시에 새 등록 흐름을 시작하면 이전 흐름은 무효화된다. 이미 설정된 앱은 계속 사용 가능하다.
- 0004~0006에 없던 후속 스키마 스냅샷까지 반영해 `0007_snapshot.json`을 갱신했다.
  현재 스키마로 다음 마이그레이션을 생성할 때 차이가 없는지 검사했다.

## 검증

Node 22.22.1에서 `npm ci`로 재설치한 뒤 `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`가 모두 통과했다. 총 15개 파일의 테스트 57개가 통과했다.
테스트는 실제 인메모리 SQLite 및 jsdom을 사용하고 외부 API는 mock 처리한다.

- 작업 중복·소유자 격리·잘못된 결과·만료·이전 워커 응답·시도 상한.
- 중간 DB 오류에 대한 전체 롤백과 이벤트 비발행, 다음 작업의 영속적 등록.
- GitHub 등록의 권한·쿠키/state 일치·만료·재사용·외부 오류 후 재사용 차단.
- React 요청 역순 응답, 취소·언마운트, SSE 공유·해제·재인증·오래된 이벤트 무시.
- 사용량 큐에 한도 도달 행 100개가 있어도 전송 가능한 행을 보내는지 검증.
- 이전 7개 마이그레이션이 적용된 임시 DB에서 8번째 업그레이드 후 기존 데이터 보존,
  두 번 열어도 중복 적용 없음, 무결성·외래키 검사, 최신 스냅샷과 실제 컬럼 일치.

실제 GitHub 앱 등록, LLM 실행, 운영 DB 변경, 컨테이너 배포는 수행하지 않았다.

## 남은 항목

- `npm audit`에는 중간 등급 7개가 남는다(Anthropic SDK, Vitest 및 Drizzle Kit의 하위 의존성 포함).
  강제 업데이트는 주요 버전 교체나 Drizzle Kit 다운그레이드를 제안하므로 적용하지 않았다.
  각 취약점의 사용 경로와 호환성을 따로 확인해야 한다.
- **GitHub 설치 소유권 검증은 별도 문제다.** `recordInstallation`은 전달받은 installation ID를
  현재 ownerId에 매핑하고 기존 owner를 갱신한다. 최초 앱 등록의 관리자 권한 보완으로는
  이 경로가 해결되지 않는다. GitHub 사용자 토큰으로 설치 접근 권한을 검증하는 연동이 필요하다.
- 사용량 전송의 동시 flush 조율, 재시도 상한 도달 기록의 운영자 조회/수동 재전송은 별도 개선이다.
- 실제 브라우저에서 GitHub 등록 왕복과 장시간 JWT 갱신 흐름은 배포 환경 검증이 남는다.
