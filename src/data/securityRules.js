// 결정적 규칙 스캔 — 핵심 15종 (기획서 7장: 비밀키·XSS·열린 DB 우선).
// severity: critical(심각) | warning(경고) | info(확인 필요)
// maskSecret: 발견 스니펫에서 비밀값을 가린다 (신뢰성 원칙 7과 같은 정신)
export const SEVERITIES = {
  critical: { label: '심각', color: 'var(--danger)' },
  warning: { label: '경고', color: 'var(--warn)' },
  info: { label: '확인 필요', color: 'var(--muted)' },
}

const rules = [
  // ── 비밀키 노출 (L0 기본선) ──
  { id: 'google-api-key', severity: 'critical', maskSecret: true, ruleFor: 'R-secrets',
    title: 'Google API 키가 코드에 노출됨',
    pattern: /AIza[0-9A-Za-z\-_]{35}/g,
    fix: '키를 재발급하고 HTTP 리퍼러 제한을 걸거나 프록시 서버를 두세요.' },
  { id: 'openai-key', severity: 'critical', maskSecret: true, ruleFor: 'R-secrets',
    title: 'OpenAI API 키가 코드에 노출됨',
    pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{40,}/g,
    fix: '지금 바로 키를 폐기하고, 서버(프록시)를 거쳐 호출하세요.' },
  { id: 'anthropic-key', severity: 'critical', maskSecret: true, ruleFor: 'R-secrets',
    title: 'Anthropic(Claude) API 키가 코드에 노출됨',
    pattern: /sk-ant-[A-Za-z0-9\-_]{20,}/g,
    fix: '키를 폐기·재발급하고, 사용자가 자기 키를 입력하는 방식이나 프록시로 바꾸세요.' },
  { id: 'aws-key', severity: 'critical', maskSecret: true, ruleFor: 'R-secrets',
    title: 'AWS 액세스 키가 코드에 노출됨',
    pattern: /AKIA[0-9A-Z]{16}/g,
    fix: '즉시 IAM에서 키를 비활성화·삭제하세요. 클라이언트에 AWS 키를 넣지 마세요.' },
  { id: 'github-token', severity: 'critical', maskSecret: true, ruleFor: 'R-secrets',
    title: 'GitHub 토큰이 코드에 노출됨',
    pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g,
    fix: 'GitHub 설정에서 토큰을 즉시 폐기하세요.' },
  { id: 'private-key-block', severity: 'critical', maskSecret: true, ruleFor: 'R-secrets',
    title: '개인키(Private Key) 내용이 포함됨',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    fix: '키를 폐기·재발급하고 git 기록에서도 제거하세요.' },
  { id: 'supabase-service-role', severity: 'critical', maskSecret: true, ruleFor: 'R-secrets',
    title: 'Supabase service_role 키 사용 흔적',
    pattern: /service_role/g,
    fix: '프론트엔드에서는 anon 키만 쓰고, service_role은 서버 환경변수로만 보관하세요.' },
  { id: 'hardcoded-password', severity: 'warning', maskSecret: true, ruleFor: 'R-secrets',
    title: '하드코딩된 비밀번호로 보이는 값',
    pattern: /(?:password|passwd|비밀번호)\s*[:=]\s*['"][^'"]{4,}['"]/gi,
    fix: '비밀번호를 코드에 넣지 말고, 필요하면 해시 비교나 서버 인증으로 바꾸세요.' },

  // ── 열린 DB (L0 기본선) ──
  { id: 'db-open-write', severity: 'critical', ruleFor: 'R-db-locked',
    title: 'DB 쓰기 규칙이 전체 공개(allow write: if true)',
    pattern: /allow\s+(?:write|create|update|delete)\s*:\s*if\s+true/g,
    fix: '인증·소유권 조건(auth != null, 본인 문서 제한)을 규칙에 넣으세요.' },
  { id: 'db-open-read', severity: 'warning', ruleFor: 'R-db-locked',
    title: 'DB 읽기 규칙이 전체 공개(allow read: if true)',
    pattern: /allow\s+(?:read|get|list)\s*:\s*if\s+true/g,
    fix: '개인정보가 있다면 읽기에도 인증·범위 제한을 두세요.' },

  // ── 위험한 코드 실행 (XSS류) ──
  { id: 'eval-usage', severity: 'warning', ruleFor: 'S-xss',
    title: 'eval() 사용',
    pattern: /\beval\s*\(/g,
    fix: 'eval을 제거하고 JSON.parse 등 안전한 대안을 쓰세요.' },
  { id: 'new-function', severity: 'warning', ruleFor: 'S-xss',
    title: 'new Function() 사용',
    pattern: /new\s+Function\s*\(/g,
    fix: '문자열로 코드를 만들지 말고 일반 함수로 바꾸세요.' },
  { id: 'innerhtml-dynamic', severity: 'warning', ruleFor: 'S-xss',
    title: 'innerHTML에 변수 삽입',
    pattern: /\.innerHTML\s*[+]?=\s*(?!['"`]\s*['"`])[^'"\n;]*(?:\$\{|\+|[A-Za-z_$][\w$]*\s*;?\s*$)/g,
    fix: 'textContent를 쓰거나, HTML이 꼭 필요하면 이스케이프 처리하세요.' },
  { id: 'document-write', severity: 'warning', ruleFor: 'S-xss',
    title: 'document.write에 동적 값',
    pattern: /document\.write\s*\(/g,
    fix: 'document.write 대신 DOM API를 쓰세요.' },

  // ── 전송 보안 ──
  { id: 'http-resource', severity: 'info', ruleFor: 'S-https',
    title: 'http:// 리소스·전송',
    pattern: /['"(]http:\/\/(?!localhost|127\.0\.0\.1)/g,
    fix: 'https:// 주소로 바꾸세요.' },
]

export default rules
