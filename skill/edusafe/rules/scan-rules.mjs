// 결정적 패턴 규칙집 — spec §9·§9.1 카탈로그의 48개.
// item·subcheck = edusafe/rules/items.json 의 항목·하위 점검 id (판정이 붙을 자리)
// stacks = "all" 또는 ["html","vite-react","nextjs","firebase","supabase"] 중 일부
// severity 는 규칙의 심각도이지 항목 판정이 아니다 (spec REQ-9.7)

export const rules = [
  {
    id: "google-api-key", item: "R-secrets", subcheck: "key-pattern-match",
    severity: "critical", stacks: "all", scanMinified: true, maskSecret: true, secretValue: true,
    title: "Google API 키가 코드에 노출됨",
    pattern: /AIza[0-9A-Za-z\-_]{35}/g,
    excludeLine: /apiKey\s*[:=]/,
  },
  {
    id: "openai-key", item: "R-secrets", subcheck: "key-pattern-match",
    severity: "critical", stacks: "all", scanMinified: true, maskSecret: true, secretValue: true,
    title: "OpenAI API 키가 코드에 노출됨",
    pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{40,}/g,
  },
  {
    id: "anthropic-key", item: "R-secrets", subcheck: "key-pattern-match",
    severity: "critical", stacks: "all", scanMinified: true, maskSecret: true, secretValue: true,
    title: "Anthropic(Claude) API 키가 코드에 노출됨",
    pattern: /sk-ant-[A-Za-z0-9\-_]{20,}/g,
  },
  {
    id: "aws-key", item: "R-secrets", subcheck: "key-pattern-match",
    severity: "critical", stacks: "all", scanMinified: true, maskSecret: true, secretValue: true,
    title: "AWS 액세스 키가 코드에 노출됨",
    pattern: /AKIA[0-9A-Z]{16}/g,
  },
  {
    id: "github-token", item: "R-secrets", subcheck: "key-pattern-match",
    severity: "critical", stacks: "all", scanMinified: true, maskSecret: true, secretValue: true,
    title: "GitHub 토큰이 코드에 노출됨",
    pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g,
  },
  {
    id: "telegram-token", item: "R-secrets", subcheck: "key-pattern-match",
    severity: "critical", stacks: "all", scanMinified: true, maskSecret: true, secretValue: true,
    title: "텔레그램 봇 토큰이 코드에 노출됨",
    pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g,
  },
  {
    id: "private-key-block", item: "R-secrets", subcheck: "key-pattern-match",
    severity: "critical", stacks: "all", scanMinified: true, secretValue: true,
    title: "개인키(Private Key) 파일 내용이 포함됨",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
  {
    id: "supabase-service-role", item: "R-secrets", subcheck: "key-pattern-match",
    severity: "critical", stacks: "all", scanMinified: true, secretValue: true,
    title: "Supabase service_role 키로 의심되는 값 발견",
    pattern: /service[_-]?role[A-Za-z0-9_]*\s*[:=]\s*["']?eyJ[A-Za-z0-9_-]{5,}/gi,
  },
  {
    id: "hardcoded-password", item: "R-secrets", subcheck: "key-pattern-match",
    severity: "warning", stacks: "all", secretValue: true,
    title: "비밀번호가 코드에 직접 적혀 있음",
    pattern: /(?:password|passwd|pwd|비밀번호|암호|(?<![a-zA-Z0-9])pw(?![a-zA-Z0-9]))\s*(?:===?|[:=])\s*["'][^"']{3,}["']/gi,
  },
  {
    id: "vite-env-secret", item: "R-secrets", subcheck: "public-prefix-secret",
    severity: "warning", stacks: ["vite-react"], scanMinified: true, secretValue: true,
    title: "VITE_ 환경변수에 비밀키를 넣은 흔적",
    pattern: /VITE_[A-Z_]*(?:SECRET|TOKEN|PRIVATE|SERVICE)[A-Z_]*/g,
  },
  {
    id: "eval-usage", item: "S-injection", subcheck: "innerhtml-eval-variable-injection",
    severity: "warning", stacks: "all",
    title: "eval() 사용",
    pattern: /\beval\s*\(/g,
  },
  {
    id: "new-function", item: "S-injection", subcheck: "innerhtml-eval-variable-injection",
    severity: "warning", stacks: "all",
    title: "new Function() 사용",
    pattern: /new\s+Function\s*\(/g,
  },
  {
    id: "innerhtml-dynamic", item: "S-injection", subcheck: "innerhtml-eval-variable-injection",
    severity: "warning", stacks: "all",
    title: "innerHTML에 변수·입력값을 넣고 있음",
    pattern: /\.innerHTML\s*[+]?=\s*(?:[^;\n]*(?:\$\{|\+\s*[A-Za-z_$])|[A-Za-z_$][\w$.]*\s*;)/g,
    excludeLine: /(?:sanitize|purify|escape|clean\w*)\s*\(|DOMPurify/i,
  },
  {
    id: "document-write", item: "S-injection", subcheck: "innerhtml-eval-variable-injection",
    severity: "info", stacks: "all",
    title: "document.write() 사용",
    pattern: /document\.write\s*\(/g,
  },
  {
    id: "settimeout-string", item: "S-injection", subcheck: "innerhtml-eval-variable-injection",
    severity: "info", stacks: "all",
    title: "setTimeout/setInterval에 문자열 전달",
    pattern: /set(?:Timeout|Interval)\s*\(\s*["'`]/g,
  },
  {
    id: "javascript-url", item: "S-injection", subcheck: "innerhtml-eval-variable-injection",
    severity: "info", stacks: "all",
    title: "javascript: URL 사용",
    pattern: /(?:href|src)\s*=\s*["']javascript:/gi,
  },
  {
    id: "firestore-open-write", item: "R-db-locked", subcheck: "firestore-open-write",
    severity: "critical", stacks: ["firebase"],
    title: "Firebase 보안 규칙이 전체 공개(쓰기 허용)로 되어 있음",
    pattern: /allow\s+(?:read\s*,\s*)?write\s*:\s*if\s+true|"\.write"\s*:\s*true/g,
  },
  {
    id: "firestore-open-read", item: "S-access", subcheck: "auth-only-not-ownership",
    severity: "warning", stacks: ["firebase"],
    title: "Firebase 보안 규칙이 전체 공개(읽기 허용)로 되어 있음",
    pattern: /allow\s+(?:\w+\s*,\s*)*read(?:\s*,\s*\w+)*\s*:\s*if\s+true|"\.read"\s*:\s*true/g,
  },
  {
    id: "firebase-config", item: "S-data-region", subcheck: "project-region-setting",
    severity: "info", stacks: ["firebase"],
    title: "Firebase 웹 설정(apiKey 등)이 코드에 있음 — 이건 괜찮지만, 확인할 것이 있어요",
    pattern: /apiKey\s*:\s*["']AIza/g,
  },
  {
    id: "client-side-gate", item: "S-teacher-gate", subcheck: "client-password-constant",
    severity: "warning", stacks: "all",
    title: "브라우저에서 비밀번호를 확인하는 코드 (prompt 등)",
    pattern: /prompt\s*\([^)]*(?:비밀번호|암호|password|pin|코드)|(?:password|passwd|pwd|pw)\s*={2,3}\s*["'][^"']{1,64}["']/gi,
  },
  {
    id: "sql-concat", item: "S-injection", subcheck: "server-sql-string-concat",
    severity: "warning", stacks: "all",
    title: "SQL 문자열 직접 조립 (SQL 인젝션 위험)",
    pattern: /["'`]\s*(?:SELECT|INSERT|UPDATE|DELETE)\s[^"'`]*["'`]\s*\+/gi,
  },
  {
    id: "rrn-data", item: "R-rrn", subcheck: "rrn-pattern",
    severity: "critical", stacks: "all", scanMinified: true, maskSecret: true,
    title: "주민등록번호로 보이는 데이터 발견",
    pattern: /\b\d{6}\s*-\s*[1-4]\d{6}\b/g,
  },
  {
    id: "rrn-field", item: "R-rrn", subcheck: "rrn-field",
    severity: "critical", stacks: "all", secretValue: true,
    title: "주민등록번호 입력·수집 필드 발견",
    pattern: /주민\s*등록\s*번호|주민번호|(?:\b|_)(?:jumin|rrn|resident_?(?:registration_?)?number)(?:\b|_)/gi,
  },
  {
    id: "localstorage-personal", item: "S-shared-device", subcheck: "localstorage-pii-token",
    severity: "warning", stacks: "all",
    title: "localStorage에 개인정보를 저장하는 것으로 보임",
    pattern: /localStorage\.setItem\s*\(\s*["'][^"']*(?:name|이름|phone|전화|tel|email|이메일|birth|생년월일|student)/gi,
  },
  {
    id: "geolocation", item: "S-sensitive", subcheck: "location-camera-mic-data",
    severity: "info", stacks: "all",
    title: "위치정보 사용 (getCurrentPosition)",
    pattern: /getCurrentPosition|watchPosition/g,
  },
  {
    id: "camera-mic", item: "S-sensitive", subcheck: "location-camera-mic-data",
    severity: "info", stacks: "all",
    title: "카메라·마이크 사용 (getUserMedia)",
    pattern: /getUserMedia/g,
  },
  {
    id: "google-form-endpoint", item: "R-third-party", subcheck: "identifiable-data-to-external-service",
    severity: "info", stacks: "all",
    title: "Google 폼/시트로 데이터 전송",
    pattern: /docs\.google\.com\/forms|script\.google\.com\/macros|formResponse/g,
  },
  {
    id: "http-resource", item: "S-https", subcheck: "http-resource-endpoint",
    severity: "warning", stacks: "all",
    title: "암호화되지 않은 http:// 주소 사용",
    pattern: /(?:src|href|action|url|fetch)\s*[:=(]\s*["']http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/gi,
  },
  {
    id: "target-blank", item: "S-https", subcheck: "http-resource-endpoint",
    severity: "info", stacks: "all",
    title: "target=\"_blank\" 링크에 rel=\"noopener\" 누락",
    pattern: /target\s*=\s*["']_blank["'](?![^>]*rel\s*=)/gi,
  },
  {
    id: "cors-wildcard", item: "R-server-guard", subcheck: "cors-wildcard",
    severity: "warning", stacks: "all",
    title: "CORS 전체 허용 (Access-Control-Allow-Origin: *)",
    pattern: /Access-Control-Allow-Origin["']?\s*[:,]\s*["']\*/g,
  },
  {
    id: "console-sensitive", item: "S-log-pii", subcheck: "console-log-user-object",
    severity: "info", stacks: "all", secretValue: true,
    title: "민감한 값을 console.log로 출력",
    pattern: /console\.log\s*\([^)]*(?:password|token|secret|key|비밀번호|jumin|주민\s*등록\s*번호|주민번호|user(?![a-zA-Z0-9])|(?:user|student)\.?name|(?:학생|사용자)\s*이름)/gi,
  },
  {
    id: "alert-debug", item: "S-answer-exposure", subcheck: "leftover-debug-code",
    severity: "info", stacks: "all",
    title: "alert()로 내부 데이터 출력",
    pattern: /alert\s*\([^)]*(?:token|password|secret|JSON\.stringify)/gi,
  },
  {
    id: "plaintext-password-compare", item: "S-password-storage", subcheck: "plaintext-password-compare",
    severity: "critical", stacks: "all", secretValue: true,
    title: "비밀번호를 평문으로 비교",
    pattern: /(?:password|passwd|pw)\s*={2,3}\s*['"][^'"]{1,64}['"]/gi,
  },
  {
    id: "weak-hash", item: "S-password-storage", subcheck: "unsalted-hash",
    severity: "warning", stacks: "all",
    title: "솔트 없는 약한 해시 사용",
    pattern: /\b(?:md5|sha1)\s*\(/gi,
  },
  {
    id: "comment-secret", item: "R-secrets", subcheck: "secret-in-comment",
    severity: "warning", stacks: "all", secretValue: true,
    title: "주석 안에 비밀번호·키로 보이는 값",
    pattern: /(?:\/\/|\/\*|#)\s*.*(?:비밀번호|password|passwd|api[\s_-]?key|token)\s*[:=]\s*\S+/gi,
  },
  {
    id: "supabase-select-star", item: "S-api-overfetch", subcheck: "select-all-columns",
    severity: "info", stacks: ["supabase"],
    title: "전체 컬럼 조회 (후보 — AI 확인 필요)",
    pattern: /\.select\(\s*['"]\*['"]\s*\)/g,
  },
  {
    id: "rls-policy-true", item: "R-db-locked", subcheck: "supabase-write-policy-open",
    severity: "critical", stacks: ["supabase"],
    title: "RLS 정책이 항상 참",
    pattern: /(?:using|with\s+check)\s*\(\s*true\s*\)/gi,
  },
  {
    id: "nextpublic-secret", item: "R-secrets", subcheck: "public-prefix-secret",
    severity: "critical", stacks: ["nextjs"], secretValue: true,
    title: "NEXT_PUBLIC_ 환경변수에 시크릿으로 보이는 이름",
    pattern: /NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|SERVICE_ROLE|PRIVATE|TOKEN|PASSWORD)[A-Z0-9_]*/g,
  },
  {
    id: "storage-flag-role", item: "S-teacher-gate", subcheck: "local-storage-role-flag",
    severity: "warning", stacks: "all",
    title: "localStorage·sessionStorage에 권한 플래그 저장",
    pattern: /(?:localStorage|sessionStorage)\.setItem\(\s*['"](?:is)?(?:admin|teacher|role|staff)[^'"]*['"]/gi,
  },
  {
    id: "debug-leftover", item: "S-answer-exposure", subcheck: "leftover-debug-code",
    severity: "warning", stacks: "all",
    title: "제거되지 않고 남은 디버그·정답 표시 코드",
    pattern: /\b(?:devAnswer|showAnswer|DEBUG_MODE|__DEV__\s*=\s*true|skipAuth)\b/g,
  },
  {
    id: "admin-data-columns", item: "R-admin-data", subcheck: "name-studentid-contact-columns",
    severity: "critical", stacks: "all", maskSecret: true,
    title: "학생 명단 열(이름·학번·연락처)이 함께 있는 표 헤더 발견",
    pattern: /(?=.*(?:^|[,;\t"])\s*(?:이름|성명|name)\s*(?:[,;\t"]|$))(?=(?:.*(?:^|[,;\t"])\s*(?:학번|student[_-]?id|student\s*number)\s*(?:[,;\t"]|$))|(?:(?=.*(?:^|[,;\t"])\s*학년\s*(?:[,;\t"]|$))(?=.*(?:^|[,;\t"])\s*반\s*(?:[,;\t"]|$))(?=.*(?:^|[,;\t"])\s*번호\s*(?:[,;\t"]|$))))(?=.*(?:^|[,;\t"])\s*(?:연락처|전화(?:번호)?|휴대(?:폰|전화)?|phone|tel|mobile)\s*(?:[,;\t"]|$)).+/gi,
  },
  {
    id: "analytics-tracking-script", item: "S-tracking", subcheck: "ga-gtag-ad-pixel",
    severity: "info", stacks: "all",
    title: "분석·광고 추적 스크립트 사용 흔적 (GA·gtag·광고 픽셀)",
    pattern: /gtag\s*\(|googletagmanager\.com|\bG-[A-Z0-9]{6,10}\b|fbq\s*\(|\b_fbq\b|analytics\.track\s*\(/g,
  },
  {
    id: "dangerously-set-inner-html", item: "S-injection", subcheck: "dangerously-set-inner-html",
    severity: "warning", stacks: ["vite-react", "nextjs"],
    title: "dangerouslySetInnerHTML 사용",
    pattern: /dangerouslySetInnerHTML/g,
  },
  {
    id: "error-reporting-pii", item: "S-log-pii", subcheck: "error-reporting-payload",
    severity: "warning", stacks: "all",
    title: "에러 리포팅 도구에 개인정보가 담길 수 있음 (Sentry·LogRocket·Bugsnag 등)",
    pattern: /Sentry\.init\s*\(|Sentry\.captureException\s*\(|Sentry\.setUser\s*\(|LogRocket\.\w|bugsnag/gi,
  },
]

export const projectRules = [
  {
    id: 'supabase-rls-missing',
    item: 'R-db-locked', subcheck: 'supabase-rls-missing',
    severity: 'critical', stacks: ['supabase'],
    title: 'RLS를 켜지 않은 테이블이 있음',
    // create table 로 만든 테이블 중 enable row level security 가 없는 것만 보고한다.
    // (줄 단위로 create table 을 잡으면 RLS 를 켠 정상 프로젝트에서도 매번 오탐한다)
    check(files) {
      const created = new Map() // 테이블명 → {file, line}
      const enabled = new Set()
      for (const f of files) {
        if (!/\.sql$/i.test(f.path)) continue
        const lines = f.text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const create = /create\s+table\s+(?:if\s+not\s+exists\s+)?["']?([a-z0-9_]+(?:\.[a-z0-9_]+)?)["']?/i.exec(lines[i])
          if (create && !created.has(create[1])) created.set(create[1], { file: f.path, line: i + 1 })
          const rls = /alter\s+table\s+["']?([a-z0-9_]+(?:\.[a-z0-9_]+)?)["']?\s+enable\s+row\s+level\s+security/i.exec(lines[i])
          if (rls) enabled.add(rls[1])
        }
      }
      const bare = (name) => name.includes('.') ? name.split('.').pop() : name
      const enabledBare = new Set([...enabled].map(bare))
      return [...created.entries()]
        .filter(([name]) => !enabledBare.has(bare(name)))
        .map(([name, at]) => ({ file: at.file, line: at.line, snippet: `${name} 테이블에 enable row level security 가 없습니다` }))
    },
  },
  {
    id: 'no-rules-file',
    item: 'R-db-locked', subcheck: 'rules-file-missing-evidence',
    severity: 'info', stacks: ['firebase', 'supabase'],
    title: '보안 규칙 파일이 저장소에 없음',
    check(files) {
      const hasRules = files.some((f) => /(?:firestore|storage|database)\.rules$|supabase[\\/].*\.sql$/i.test(f.path))
      return hasRules ? [] : [{ file: '(프로젝트 전체)', line: 0, snippet: '규칙 파일을 찾지 못했습니다' }]
    },
  },
  {
    id: 'firebase-no-appcheck',
    item: 'S-abuse-limit', subcheck: 'db-direct-app-check',
    severity: 'warning', stacks: ['firebase'],
    title: 'Firebase를 쓰지만 App Check 초기화가 없음',
    check(files) {
      const usesFirebase = files.some((f) => /initializeApp\(/.test(f.text))
      const hasAppCheck = files.some((f) => /initializeAppCheck|ReCaptcha/.test(f.text))
      return usesFirebase && !hasAppCheck
        ? [{ file: '(프로젝트 전체)', line: 0, snippet: 'initializeAppCheck 호출을 찾지 못했습니다' }]
        : []
    },
  },
  {
    id: 'admin-data-file-present',
    item: 'R-admin-data', subcheck: 'name-studentid-contact-columns',
    severity: 'critical', stacks: 'all',
    title: '학생 명단·성적으로 보이는 데이터 파일 발견',
    // Task 3 리뷰 수정 2b: .xlsx·.xls 는 바이너리라 scan.mjs 가 내용을 읽지 않고 건너뛴다
    // (TEXT_EXT 밖이라 files 에 안 들어옴). 내용을 볼 수 없으니 파일명만으로 존재를 잡는다.
    // allPaths 는 scan.mjs 가 읽은 파일 + 건너뛴 파일 경로를 모두 합쳐 넘겨준다.
    //
    // Task 3 재리뷰 지적 1: nameHint 가 단어 경계·제외 필터 없이 부분 문자열만 봐서
    // student-guide.xlsx·roster-template.xlsx·scores.test.csv·docs/roster-onboarding-guide.xlsx
    // 처럼 학생 데이터가 전혀 없는 견본·양식·테스트 파일까지 critical 로 오탐했다(node로 실측).
    // 두 가지로 좁혔다:
    // (1) 영문 키워드(roster/students/score)에 admin-data-columns 와 같은 취지로 부정 전방/
    //     후방탐색 경계를 적용했다. 한글 키워드(명단/성적)는 그대로 부분 문자열 매치로 남겨뒀다 —
    //     JS `\b`는 한글을 word char 로 인식하지 않아, `\b`를 붙이면 오히려 "3반_명단.xlsx"처럼
    //     경계 문자(".")가 word char 가 아니라서 정탐까지 놓치게 된다(node로 확인).
    // (2) 파일명(경로 포함)에 template/guide/sample/example/demo/test/fixture/양식/예시/샘플 이
    //     있으면 nameHint 매치 여부와 무관하게 보고하지 않는다.
    check(files, allPaths) {
      const nameHint = /명단|성적|(?<![a-zA-Z0-9])(?:roster|students?|score)(?![a-zA-Z0-9])/i
      const extHint = /\.(xlsx|xls|csv)$/i
      const excludeHint = /template|guide|sample|example|demo|test|fixture|양식|예시|샘플/i
      return (allPaths || [])
        .filter((p) => {
          const base = p.split('/').pop()
          if (!extHint.test(base)) return false
          if (excludeHint.test(p)) return false
          return nameHint.test(base)
        })
        .map((p) => ({ file: p, line: 0, snippet: `파일명이 학생 명단·성적 데이터를 시사합니다: ${p}` }))
    },
  },
]
