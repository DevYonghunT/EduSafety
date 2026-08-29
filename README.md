# 에듀 세이프 (EduSafe) — 해커톤 빌드

> **이 프로젝트는 도전형 해커톤을 위한 것임**

**교사 제작 앱 심사·검수 시스템** — 교사가 바이브 코딩으로 만든 앱을 교육청 심사자가 검토하는
심사자 전용 도구입니다. AI가 코드 근거를 모아 판정 초안을 만들고, 최종 판정은 사람이 합니다.

최종 보고서 화면과 출력본에는 현재 판정과 고정 commit·콘텐츠 지문을 요약한 **심사 상태마크**가 포함됩니다.
별도 인증 API를 PostgreSQL과 함께 운영하면 특정 GitHub exact commit을 다시 분석해
**EAS Offchain v2 기반 가스리스 서명 인증마크**도 발급할 수 있습니다.

팀 「우매함의 봉우리」 · 트랙 2(심사 앱) 코어 재구축

## 규정 준수 고지

- 개발(코딩·코드 생성 프롬프트 입력)은 대회 규정에 따라 **첫 커밋 시각부터** 시작했다.
- 사전 준비물은 규정이 허용하는 **기획 문서 3종**(`docs/`)뿐이다.
- 동일 아이디어의 기존 프로토타입이 별도 공개 저장소에 존재하며, 발표 시 고지한다.
- 커밋 이력이 곧 개발 과정의 증빙이다 (작업 단위 커밋, T번호 표기, AI 협업 투명 표기).

## 기획 문서

- [기획서](docs/해커톤-기획서.md) — 제품 전체 (무엇을)
- [Design Plan](docs/해커톤-design-plan.md) — 설계 결정 (왜)
- [Implementation Plan](docs/해커톤-implementation-plan.md) — 작업 분해·타임라인 (어떻게)

## 구성

- Vite 6, React 18 심사 화면
- Node.js 22, TypeScript, Express 인증 API
- PostgreSQL 17과 SQL migration
- ethers v6의 provider 없는 `Wallet.signTypedData`
- Vitest 단위·통합 테스트

주요 경로는 다음과 같습니다.

- `/` — 앱 심사 및 최종 보고서
- `/`의 `URL 검사` 메뉴 — 로그인 없이 입력한 HTTPS URL의 공개 HTML·보안 헤더 저영향 정적 점검
- `/verify/:uid` — 공개 검증
- `/admin/certification` — 심사 항목, 정책, 발급 내역 관리
- `/demo` — `DEMO_PASS` 정적 showcase

서명 과정에는 RPC, 네트워크 트랜잭션, 테스트 ETH, Faucet, 가스비가 필요하지 않습니다. 저장소의
install·build·test·lifecycle 코드를 실행하지 않으며, GitHub REST API로 commit과 tree·blob을 읽어
고정된 서버 evaluator만 적용합니다.

## 로컬 실행

Node.js 22 이상과 PostgreSQL 17을 준비합니다.

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run dev          # Vite 심사 화면: http://localhost:5174
npm run dev:server   # 인증 API: http://localhost:3000 (별도 터미널)
```

개발 환경의 브라우저 기준 origin은 `http://localhost:5174`입니다. Vite가 `/api`, `/admin`, `/verify`를
3000번 서버로 전달하므로 `.env.example`의 `BADGE_PUBLIC_BASE_URL`과 `BADGE_ALLOWED_ORIGINS`도 5174로
맞춰져 있습니다.

관리자 비밀번호 hash는 비밀번호를 파일이나 명령 인수에 넣지 않고 다음처럼 생성할 수 있습니다.

```bash
read -s EDUSAFETY_ADMIN_PASSWORD_INPUT
export EDUSAFETY_ADMIN_PASSWORD_INPUT
npm run admin:hash-password
unset EDUSAFETY_ADMIN_PASSWORD_INPUT
```

출력된 값은 `ADMIN_PASSWORD_SCRYPT`에 설정합니다. `ADMIN_SESSION_SECRET`에는 최소 43자의 무작위 값을 사용합니다.

## 환경변수

| 변수 | 용도 |
|---|---|
| `DATABASE_URL` | PostgreSQL 연결 문자열. 보고서 전용 운영은 `standalone://url-scan` |
| `EAS_CHAIN_ID` | 고정값 `84532` |
| `EAS_SCHEMA_UID` | `string statement` schema UID |
| `EAS_ATTESTER_ADDRESS` | 발급 지갑에서 파생한 주소 |
| `EAS_ATTESTER_PRIVATE_KEY` | 서버 전용 발급 키 |
| `EAS_TRUSTED_ATTESTER_ADDRESSES` | 쉼표로 구분한 신뢰 주소 목록 |
| `BADGE_ALLOWED_ORIGINS` | 명시적인 cross-origin 허용 목록 |
| `BADGE_PUBLIC_BASE_URL` | 검증·SVG 절대 URL의 기준 주소 |
| `BADGE_EXPIRATION_DAYS` | 만료 일수. `0`은 만료 없음 |
| `ADMIN_ID` | 감사 로그에 남길 내부 관리자 ID |
| `ADMIN_USERNAME` | 관리자 로그인 ID |
| `ADMIN_PASSWORD_SCRYPT` | scrypt 비밀번호 hash |
| `ADMIN_SESSION_SECRET` | 관리자 세션 HMAC 비밀값 |
| `GITHUB_TOKEN` | 선택 사항인 서버 전용 GitHub token |
| `SECURITY_SCAN_DYNAMIC_TARGETS_ENABLED` | 고정 허용목록 밖의 공개 HTTPS URL 검사 허용. 기본값 `false` |
| `SECURITY_SCAN_ALLOWED_ORIGINS` | 점검을 허용한 exact HTTPS origin 목록(쉼표 구분) |
| `SECURITY_SCAN_TIMEOUT_MS` | 대상 DNS·GET 요청 제한 시간(1,000~15,000ms) |
| `NODE_ENV`, `PORT` | 서버 실행 환경과 포트 |

`URL 검사`는 관리자 로그인 없이 동일 origin 웹 화면에서 바로 실행할 수 있습니다. 본인이 소유했거나 점검을 허가받은 대상인지 확인해야 하며, 서버는 클라이언트 IP별 요청 횟수와 전체 동시 실행 수를 제한합니다. 허용목록 밖의 공개 HTTPS URL도
입력하려면 `SECURITY_SCAN_DYNAMIC_TARGETS_ENABLED=true`로 설정합니다. `false`이면
`SECURITY_SCAN_ALLOWED_ORIGINS`에 등록한 origin만 입력할 수 있습니다. 입력한 HTTPS 경로에 `GET` 요청을 한 번만
보내 TLS·보안 헤더와 첫 HTML 응답을 최대 256 KiB까지 정적으로 확인합니다. 리디렉션을 따라가지 않고,
JavaScript 실행·로그인·사이트 크롤링·외부 스크립트 다운로드·익스플로잇은 수행하지 않습니다.
Anthropic 보조 분석은 검사 화면에서 요청마다 `ANTHROPIC_API_KEY`를 입력하고 `ANTHROPIC_MODEL`을 선택할 때만
실행합니다. 키는 저장하거나 API 응답에 포함하지 않습니다. 허용 모델은 `claude-sonnet-5`,
`claude-haiku-4-5-20251001`, `claude-opus-5`이며, 모델을 생략하면 `claude-sonnet-5`를 사용합니다.
HTML 원문, URL, 응답 헤더 값은 Anthropic에 보내지 않고 서버가 확정한 finding ID·심각도·고정 개선안만
전달합니다. 키를 입력하지 않거나 Anthropic 호출이 실패해도 규칙 기반 결과는 그대로 제공합니다. 기존
`SECURITY_SCAN_ALLOWED_ORIGINS`는 URL 직접 입력을 끈 고정 대상 모드에서만 사용합니다.
검사가 끝나면 마지막 성공 결과의 `인쇄 / PDF 저장` 버튼으로 입력폼과 API 키 영역을 제외한 보고서를
출력할 수 있습니다. 브라우저 인쇄 창에서 `PDF로 저장`을 선택하며, 닫힌 기술 상세와 검사 한계도 출력에 포함됩니다.
Shannon의 능동 공격 검증 단계는 이 메뉴에 포함하지 않습니다.

서버 시작 시 개인키에서 파생한 주소와 `EAS_ATTESTER_ADDRESS`를 비교하고, 해당 주소가 신뢰 목록에 없으면 시작을 중단합니다. 서버 전용 값은 `public/` 산출물이나 API 응답에 포함되지 않습니다.

## 정책과 판정

심사 항목은 migration과 서버 코드에 함께 등록된 고정 allowlist입니다. 정책을 만들면 현재 사용 가능한 전체 항목이 자동으로 포함되며, 관리자는 항목을 추가하거나 제외할 수 없습니다. evaluator 코드, 명령, 정규식, 실행 설정도 입력할 수 없습니다.

정책 상태는 `DRAFT`, `ACTIVE`, `ARCHIVED`입니다. 한 시점의 `ACTIVE` 정책은 PostgreSQL partial UNIQUE index로 하나만 허용됩니다. 발행된 정책과 그 고정 항목 snapshot은 DB trigger로 변경을 막습니다. 서버 고정 기준이 바뀌면 ruleset과 새 정책 버전을 함께 발행해야 합니다.

서버에 고정된 전체 심사 항목은 모두 `PASS`여야 합니다. `FAIL`, `ERROR`, `NOT_RUN`, `NOT_APPLICABLE`, `UNKNOWN` 또는 결과 누락이 있으면 발급하지 않습니다. Critical finding, secret 감지, partial 분석, 불완전한 coverage, exact commit 확인 실패, evaluator 오류, 필수 파일 수집 실패도 항상 차단합니다.

## 발급과 공개 검증

`POST /api/badges/issue`는 다음 두 필드만 받습니다.

```json
{
  "repositoryUrl": "https://github.com/owner/repository",
  "commitSha": "0123456789abcdef0123456789abcdef01234567"
}
```

추가 필드가 있으면 요청 전체를 거절합니다. 서버는 요청 시작 시 `ACTIVE` 정책 snapshot을 고정한 뒤 GitHub numeric repository ID, canonical URL과 exact commit을 확인합니다.

④ 보고서를 생성하면 긴 판정표가 끝나는 지점의 `심사 확인` 바로 위에 문서형 심사 기록마크가 표시됩니다. 마크에는 현재 판정, 조치 건수, 대상 저장소와 고정 commit 또는 폴더 콘텐츠 지문, EAS Offchain v2 연계 규격과 실제 서명 상태가 함께 표시됩니다. 현재처럼 EAS proof가 없는 출력본은 `EAS UID·서명 없음`으로 명시되고, 인쇄본의 모든 페이지 상단에는 작은 `EDUSAFETY REPORT · UNSIGNED` 마크와 commit 또는 콘텐츠 지문이 반복됩니다. 현재 보고서의 저장소·commit과 일치하는 검증된 EAS proof가 전달된 경우에만 상단 참조값이 상태가 포함된 EAS UID로 바뀝니다. 페이지별 UID는 같은 증명을 가리키는 참조값이며 각 페이지를 별도로 서명한 값은 아닙니다. EAS Offchain v2는 가스리스 전자서명 형식이며 온체인 거래나 정부·공공기관 인증을 의미하지 않습니다.

동일 subject의 기존 인증은 repository ID와 정책 hash로 먼저 조회해 불필요한 재분석과 재서명을 피합니다. 공개 발급 요청은 IP별 분당 6회, 프로세스 전체 동시 분석 4건으로 제한하며 대기열을 무한히 만들지 않습니다. 관리자 로그인은 IP·정규화된 계정별 시도 횟수와 동시 scrypt 검증 수를 함께 제한합니다. 이 내장 제한은 프로세스 단위의 기본 방어이므로 여러 인스턴스를 운영할 때는 신뢰 가능한 reverse proxy나 API gateway의 공유 제한도 함께 구성해야 합니다.

통과 결과는 canonical JSON으로 만들고 ABI `string`으로 인코딩합니다. EIP-712 `Attest` 메시지는 EAS Offchain v2 필드 순서를 고정하며, 암호학적으로 안전한 32바이트 salt를 매번 생성합니다. UID는 EAS v2 규칙으로 별도 계산합니다.

공개 검증은 DB의 정규화된 행과 snapshot만으로 다음을 다시 확인합니다.

- report, policy, criteria hash
- canonical statement와 ABI data
- EIP-712 domain, types, message와 signature
- EAS Offchain v2 UID
- 복구된 발급자 주소와 신뢰 목록
- 발급·만료·취소 snapshot
- 현재 기본 브랜치 HEAD와 exact commit의 일치 여부

상태 우선순위는 `INVALID`, `REVOKED`, `EXPIRED`, `UNVERIFIED`, `STALE`, `VALID`입니다. 확실히 존재하지 않는 UID는 404로 처리하고, DB 또는 GitHub를 일시적으로 확인하지 못하면 `UNVERIFIED`로 구분합니다.

## DB migration과 동시성

Migration은 [001_eas_offchain_v2_certification.sql](./migrations/001_eas_offchain_v2_certification.sql)에 있습니다. 주요 테이블은 다음과 같습니다.

- `certification_criteria`, `certification_safety_controls`
- `certification_policies`, `certification_policy_criteria`, `certification_policy_safety_controls`
- `certification_analyses`, `certification_analysis_criteria`, `certification_analysis_safety_blockers`
- `certification_badges`, `certification_badge_revocations`
- `certification_audit_logs`

동일한 `repository_id + commit_sha + policy_hash + ruleset_version` 조합은 `certification_badges_issuance_uq` UNIQUE 제약으로 한 번만 저장됩니다. 분석·proof·발급 이력과 취소·감사 행은 trigger로 변경이나 삭제를 차단합니다.

## API

공개 API:

- `POST /api/badges/issue`
- `GET /api/badges/:uid`
- `GET /api/badges/:uid.svg?variant=showcase`
- `GET /api/security-scan/config`
- `POST /api/security-scan`

`POST /api/security-scan`은 기본 필드인 `targetUrl`, `authorizationConfirmed` 외에 요청별 선택 필드
`anthropicApiKey`, `anthropicModel`을 받습니다. 모델만 보내는 요청과 허용 목록 밖 모델은 거부합니다.
키만 보내면 기본 모델을 사용하며, 둘 다 생략하면 결정론적 검사만 실행합니다.

관리자 API는 서버에서 관리자 세션을 검증합니다. 변경 요청은 세션에 결합된 CSRF token도 확인합니다.

`BADGE_ALLOWED_ORIGINS`는 공개 badge API에만 적용됩니다. 관리자 API는 same-origin 요청만 허용하며 cross-origin credential 응답을 만들지 않습니다.

- `GET /api/admin/certification/criteria`
- `GET /api/admin/certification/policies`
- `GET /api/admin/certification/policies/active`
- `POST /api/admin/certification/policies`
- `PUT /api/admin/certification/policies/:id`
- `POST /api/admin/certification/policies/:id/publish`
- `GET /api/admin/certification/badges`
- `POST /api/admin/certification/badges/:uid/revoke`

## 품질 확인

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run test:vercel # Vercel production output 생성 후 adapter/정적 route 검증
```

실제 PostgreSQL 통합 테스트는 빈 테스트 DB를 지정해 실행합니다.

```bash
TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/edusafety_test npm run test:db
```

이 테스트는 migration, ACTIVE 정책 1개, 20개 동시 발급의 단일 행·UID, 취소 원자성, 과거 proof 검증과 불변 trigger를 확인합니다.

## 한계

- 블록체인에 기록되지 않습니다.
- 인증 데이터의 가용성과 취소 상태는 운영 DB에 의존합니다.
- 발급자 개인키와 신뢰 가능한 주소 목록을 안전하게 관리해야 합니다.
- GitHub 저장소가 비공개로 전환되거나 삭제되면 `STALE` 여부를 확인하지 못할 수 있습니다.
- 인증은 특정 exact commit과 서버에 고정된 전체 심사 항목의 정적 분석 결과만 나타냅니다.
- 이후 commit, 실제 배포 환경, 런타임 동작, 운영 보안 전체를 보증하지 않습니다.

Vercel에서는 Vite 결과물 `client-dist`를 정적 화면으로 제공합니다. 동적 `/api`와 인증이 필요한 관리자
화면만 `api/server.ts`의 Express 어댑터로 전달하고, 로그인·공개 검증·데모 HTML은 정적으로 제공합니다.
로컬 listener와 serverless handler는 같은 singleton bootstrap을 사용해 프로세스마다 PostgreSQL pool과
애플리케이션을 한 번만 초기화합니다.
