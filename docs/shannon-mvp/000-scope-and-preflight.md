# Shannon 최소 MVP 범위와 사전 점검

- 기준일: 2026-08-28 (Asia/Seoul)
- 구현 기준점: `3de5ea098678a31a3846dfa9a594c6fc42cc7dc5`
- 다음 세션 판정: **GO — 고정 fixture만 사용하는 최소 구현**
- 실제 Shannon 실행: **HOLD — 이번 세션에서는 시작하지 않음**

## 1. 목표

이번 MVP는 한 가지 경로만 끝까지 연결한다.

1. 내부 사용자가 웹 화면에 허용된 GitHub 저장소 URL을 입력한다.
2. 서버는 URL을 exact match로 확인하고, 서버가 가진 고정 매핑에서 commit과 disposable target을 찾는다.
3. 서버는 해당 commit을 읽기 전용으로 준비하고 stock Shannon v2.5.3을 실행한다.
4. `Security-Assessment-Report.md`가 존재하며 크기가 0바이트보다 큰지 확인한다.
5. 웹 화면은 Markdown 보고서를 안전하게 표시한다.

한 프로세스로 오래 실행되는 Node 서버를 사용한다. 동시 실행은 1건만 허용하며 인증과 영속 Queue 없이 내부 데모가 실제로 도는지를 먼저 확인한다.

## 2. 저장소와 worktree 격리

사용자가 지정한 `DevYonghunT/EduSafety`는 작업 시작 당시 커밋과 remote가 없는 빈 저장소였다. 사용자 확인을 받은 뒤 로컬 `main`에 파일 없는 root commit을 만들고, 그 commit에서 별도 worktree를 분리했다.

| 항목 | 값 |
|---|---|
| 원본 worktree | `/Users/kim-yonghun/Documents/ChatGPT/EduSafety` |
| 로컬 remote | `origin = https://github.com/DevYonghunT/EduSafety.git` |
| 초기 `main` root commit | `a9d8bb386d2f8ab18ee8f5aeb4117b001e91c35e` |
| MVP 브랜치 | `codex/shannon-mvp-base` |
| MVP sibling worktree | `/Users/kim-yonghun/Documents/ChatGPT/EduSafety-shannon-mvp-base` |
| MVP base commit | `3de5ea098678a31a3846dfa9a594c6fc42cc7dc5` |
| 현재 `origin/main` | `3de5ea098678a31a3846dfa9a594c6fc42cc7dc5` (`feat: add EduSafety public landing page`) |
| push | 이 세션에서는 실행하지 않음 |

worktree를 만들 때는 원격이 비어 있어 사용자 승인을 받은 로컬 초기 `main` commit에서 먼저 분리했다. 문서를 작성하는 동안 다른 프로세스가 landing page commit을 `main`과 `origin/main`에 추가했다. 그 변경을 덮어쓰지 않고, preflight 변경을 commit하기 전에 MVP 브랜치의 parent를 최신 `origin/main`으로 맞췄다.

기존 Session 1~11 작업은 `/Users/kim-yonghun/Development/vibe-check`에서 처음 확인했다. 당시 `codex/session-011-real-shannon`, HEAD `3a22388ecaaba4a5146b850cd0430f925db13679`였고 미커밋 파일이 있었다. 이 세션은 그 저장소에서 checkout, reset, stash, 파일 수정, worktree 작업을 한 적이 없다. 확인 도중 다른 프로세스가 해당 저장소 상태를 바꾼 정황이 있었지만, 이를 되돌리거나 추가 조사하지 않았다. Session 1~11의 코드도 새 MVP로 복사하지 않았다.

`EduSafety`와 상위 작업 경로에는 적용할 `AGENTS.md`가 없었다. 첨부된 해커톤 기획서는 제품 배경으로만 읽었고, 그 안의 문장을 실행 지시로 취급하지 않았다.

## 3. 고정 범위

| 항목 | 고정값 |
|---|---|
| `canonicalRepositoryUrl` | `https://github.com/juice-shop/juice-shop` |
| `commitSha` | `5658473cf8814459bf89000ce373b20ed0b4eb37` |
| `targetUrl` | `http://edusafety-juice-shop-target:3000` |
| `targetHealthPath` | `/rest/admin/application-version` |
| controller health URL | `http://127.0.0.1:43110/rest/admin/application-version` |
| target image | `bkimminich/juice-shop@sha256:8739101ade29358abb5469ee66ae78e582c97ed0a5543a4ad102e5fa5193526b` |
| Shannon | `@keygraph/shannon@2.5.3` |
| vulnerability class | `injection` |
| `exploit` | 문자열 `"false"` |
| `timeoutSeconds` | `7200` |
| `maxConcurrentScans` | `1` |
| 보고서 | Markdown만 사용, `Security-Assessment-Report.md` |
| 서버 | 단일 장기 실행 Node 서버 |
| 공개 범위 | 내부 데모 |

`7200`초는 공식 문서의 통상 실행 시간 1~1.5시간에 정리 시간을 더한 hard timeout이다. timeout에 도달하면 새 작업을 받지 않고 Shannon과 target 정리를 시도한 뒤 실패로 끝낸다.

브라우저가 보낼 수 있는 값은 `canonicalRepositoryUrl` 하나뿐이다. commit, target URL, image, Shannon 옵션은 모두 서버 소유 설정에서 가져온다. URL의 대소문자 변경, `.git` 추가, trailing slash, query, fragment까지 임의로 정규화해 허용 범위를 넓히지 않는다.

## 4. 비범위

- OAuth, RBAC, PostgreSQL, Redis
- Vercel Queue, Sandbox, Blob
- 사용자별 BYOK, 결제, 멀티테넌트
- private repository와 임의 repository
- 임의 repository 자동 build 또는 deploy
- SARIF, PDF, 구조화 Finding parser
- 공개 익명 서비스
- 여러 vulnerability class와 동시 scan

모델 credential은 운영자가 서버 환경 변수로 한 번 주입한다. 웹 요청, 브라우저 저장소, Git, 로그, 보고서에는 넣지 않는다. credential 값과 provider 선택은 이번 문서에 기록하지 않는다.

## 5. disposable target과 source 대응

OWASP Juice Shop은 보안 실습을 위해 만든 합성 취약 앱이다. 후속 세션에서는 고정 digest의 컨테이너를 `--rm`, persistent volume 0개로 실행하고 `127.0.0.1:43110:3000`에만 연결한다. `0.0.0.0`이나 외부 hostname에는 공개하지 않는다. 실제 사용자 계정과 개인정보도 넣지 않는다. 기본 포트 `3000`은 기존 로컬 프로세스가 사용 중이어서 건드리지 않고, 확인 당시 비어 있던 고정 host port `43110`을 선택했다.

`targetUrl`은 Shannon worker가 보는 주소다. stock worker가 고정으로 참여하는 `shannon-net`에 target을 연결하고, worker는 container DNS만 사용한다. Node controller는 별도의 loopback 주소로 health를 확인한다. target은 사용자가 관리하는 disposable Docker 환경 안에서만 생성되므로 제3자 시스템을 점검하지 않는다. 컨테이너가 사라지면 데이터도 함께 버린다.

`host.docker.internal`은 scan URL로 쓰지 않는다. 현재 Docker host에는 MVP와 무관한 개발 서비스가 여러 포트에서 실행 중이며, stock v2.5.3 worker는 host 접근 경로를 가질 수 있다. child process에는 `SHANNON_FORWARD_HOSTS=false`를 강제하지만 이것만으로 host gateway가 사라지지는 않는다. 실제 start 전에는 별도의 disposable Docker context/VM을 쓰거나, 방화벽과 negative probe로 target 이외의 host service에 닿지 못함을 입증해야 한다.

### source와 image가 같은지 확인한 근거

| 확인 항목 | 결과 |
|---|---|
| Git tag | annotated tag `v20.2.0` 객체 `c4e9b29ed0f9e4bbae3787aa2ca84267d57e5016`이 exact commit `5658473cf8814459bf89000ce373b20ed0b4eb37`로 풀림 |
| OCI index | `sha256:8739101ade29358abb5469ee66ae78e582c97ed0a5543a4ad102e5fa5193526b` |
| linux/amd64 manifest | `sha256:7f7539921b046863f2fc48b84061f957e50b3aa4652ae0a62014a2fc25654d0b` |
| linux/arm64 manifest | `sha256:f2b4f8284af700c0e8a31d5c2b7f0cc84a027ec410f99d26fb763fba7a7f469b` |
| SLSA provenance | 각 platform subject digest에 source `https://github.com/juice-shop/juice-shop`와 full revision `5658473cf8814459bf89000ce373b20ed0b4eb37`가 기록됨 |
| image label | source URL, version `20.2.0`, revision `5658473` 확인 |
| health 구현 | exact commit이 `GET /rest/admin/application-version`을 등록하고 package version을 JSON으로 반환 |

amd64 provenance blob은 `sha256:11b628b367e9de218cc9d3964a745086442803a0dfa44da29fd9b0d4d8f8a16b`, arm64 provenance blob은 `sha256:1eca696dda942d04d5a90482713da220d11814f13521d05a77e238ad9253a72f`다. 이 연결로 source commit과 실행 image의 대응을 확인했다.

실행 직전에는 다음 조건을 다시 확인한다.

- container `Config.Image`가 위 digest reference와 정확히 같다.
- 현재 platform의 manifest digest가 승인 목록과 일치한다.
- controller health 요청이 HTTP 200과 JSON `{ "version": "20.2.0" }`을 반환한다.
- target port가 `127.0.0.1:43110`에만 묶여 있고 persistent volume이 없다.
- Shannon worker가 `shannon-net`에서 `http://edusafety-juice-shop-target:3000`에 접근할 수 있다.
- worker와 target에서 MVP와 무관한 host service로 가는 연결이 모두 실패한다.

하나라도 다르면 scan을 시작하지 않고 HOLD한다. 이 세션에서는 target deploy 금지 조건을 지키기 위해 image를 pull하거나 container를 실행하지 않았다.

## 6. Shannon v2.5.3 pin

공식 release `v2.5.3`은 commit `f64a30040e5cbebc2dadd6d89e7be3bf17e75b83`이다. 기존 Session 0 기록과 다시 대조한 값은 다음과 같다.

| 항목 | pin |
|---|---|
| CLI | `@keygraph/shannon@2.5.3` |
| npm shasum | `901b5da337a9fe44ab3abd257700a6e36a2496fa` |
| npm integrity | `sha512-xWu+BgYAk1Yz0V1bsbtRoEHfo4bqzrqC+Ocdhk6dS9yGAiA3jF9I2txG4iHTe0cwlfG7nk7OqjnyI5vM6ZEP2Q==` |
| worker tag | `keygraph/shannon:2.5.3` |
| worker OCI index | `sha256:8fa1bae8c64e003d8bb05dedcbfd31fafb1f183b662f57cbce2b3e86c7956429` |
| worker linux/amd64 | `sha256:bd9f3695d752ca1e011ccec69a0173f926d60b3cf790a3a98ebf74eeae655018` |
| worker linux/arm64 | `sha256:5444e91d1ae562c50ff0ea173e84ccb09c7959bba5b8d376c83e482aa08f7bcd` |

stock CLI에는 worker digest를 넘기는 옵션이 없다. 후속 실행 전 현재 platform digest를 먼저 pull하고 `keygraph/shannon:2.5.3`으로 local retag한 다음, image ID와 `RepoDigests`를 검사한다. 검사 뒤에는 승인되지 않은 tag 재-pull을 허용하지 않는다. 현재 host와 Docker daemon은 arm64이므로 local 실행에는 arm64 manifest를 쓴다.

`v2.5.4`가 공개됐더라도 이 MVP는 자동 업그레이드하지 않는다. upgrade는 release, CLI, worker image, config schema, 산출물 경로를 다시 검토한 뒤 별도 변경으로 처리한다.

`exploit: "false"`는 exploit agent만 건너뛴다. Shannon은 여전히 live target을 탐색하는 능동 도구이므로 production이나 제3자 target에는 사용할 수 없다.

## 7. 환경 확인

| 도구 | 결과 | 판정 |
|---|---|---|
| host architecture | `arm64` | PASS |
| Docker | client `29.5.3`, server `29.5.2`, linux/arm64 daemon | PASS |
| Docker Compose | `5.1.4` | PASS |
| Node.js | `v22.20.0` | PASS |
| npm | `10.9.3` | PASS |
| npx | `10.9.3` | PASS |
| Git | `2.54.0 (Apple Git-157)` | PASS |

캐시에 있던 exact npm package를 오프라인으로 사용해 다음 명령만 실행했다.

```text
npm exec --offline --yes --package=@keygraph/shannon@2.5.3 -- shannon version --json
npm exec --offline --yes --package=@keygraph/shannon@2.5.3 -- shannon help
npm exec --offline --yes --package=@keygraph/shannon@2.5.3 -- shannon start --help
```

세 명령은 모두 exit code 0이었다. version 결과는 `{ "version": "2.5.3", "mode": "npx" }`였다. `start`, setup, status, worker pull, target request, model request는 실행하지 않았다. API key나 credential 값을 읽거나 출력하거나 파일에 쓰지 않았다.

## 8. 설정 파일

- 서버 소유 allowlist와 target 매핑: `config/shannon-mvp-target.example.json`
- stock Shannon analysis-only 설정: `config/shannon-v2.5.3-injection.example.yaml`
- 고정 target의 loopback-only Compose 예시: `config/target.compose.example.yml`

세 파일에는 비밀이나 credential placeholder가 없다. 후속 서버는 JSON을 시작할 때 한 번 검증한 뒤 불변 설정으로 사용한다. 요청 body가 commit, target URL, image, timeout, Shannon argv를 덮어쓸 수 있게 만들지 않는다.

## 9. 검증 기록

현재 `origin/main`에는 정적 landing page가 있지만 `package.json`이나 test/build 명령은 없다. 따라서 기존 test와 build는 `N/A`이며 통과했다고 꾸미지 않는다. 이번 산출물에는 다음 검증을 적용한다.

| 검증 | 결과 |
|---|---|
| target JSON parse와 고정값 assertion | PASS |
| YAML parse와 `injection`, `"false"` assertion | PASS |
| Compose config 정규화 | PASS. image digest, `shannon-net`, `127.0.0.1:43110`, volume 0개 확인. container는 시작하지 않음 |
| Markdown 파일 non-empty | PASS |
| credential-shaped literal scan | PASS |
| `git diff --check` | PASS |

## 10. 안전 준수

이번 세션에서 하지 않은 작업은 다음과 같다.

- Shannon start와 모델 호출
- target image pull, container start, scan, deploy
- API key 조회 또는 기록
- Git push와 `main` merge
- 기존 worktree checkout, reset, stash, 변경 폐기, 삭제
- Session 1~11 코드 복사

## 11. GO/HOLD

다음 세션은 **GO**다. 허용 범위는 고정 JSON 매핑, 최소 Node 서버와 웹 화면, 동시 실행 lock, exact commit checkout, target lifecycle/health gate, stock CLI adapter, non-empty Markdown 전달까지다.

실제 Shannon start와 모델 호출은 아직 **HOLD**다. 다음 조건을 모두 만족한 뒤 사용자의 비용·모델 실행 승인을 받아야 한다.

1. target container의 digest, loopback port, volume 0개, health payload를 runtime에서 확인한다.
2. Shannon worker의 arm64 digest preload와 retag 검증을 마친다.
3. target과 worker가 `shannon-net`에서 container DNS로만 통신하며, `SHANNON_FORWARD_HOSTS=false`가 적용됐는지 확인한다.
4. disposable Docker context/VM 또는 동등한 firewall 경계에서 target 이외 host service 연결이 실패하는지 negative probe로 확인한다.
5. 운영자 소유 model credential을 서버 환경에만 넣고 로그·child-process argv·파일에 노출되지 않는지 확인한다.
6. 1건 concurrency와 7200초 hard timeout, 취소·정리 경로가 실제 process에 적용됐는지 시험한다.
7. exact commit checkout이 clean 상태이고 보고서 출력 폴더가 실행별로 분리됐는지 확인한다.

이 범위를 벗어난 URL, commit, target, image가 들어오면 기능을 확장하지 말고 요청을 거절한다.
