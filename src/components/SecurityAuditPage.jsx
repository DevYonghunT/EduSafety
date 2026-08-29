import { useEffect, useRef, useState } from 'react'

const CONFIG_ENDPOINT = '/api/security-scan/config'
const SCAN_ENDPOINT = '/api/security-scan'

const SEVERITY_LABELS = {
  high: '높음',
  medium: '보통',
  low: '낮음',
  info: '정보',
}

const STATUS_LABELS = {
  pass: '통과',
  warning: '주의',
  fail: '실패',
}

const RISK_LABELS = {
  high: '높음',
  medium: '보통',
  low: '낮음',
  info: '정보',
  minimal: '최소',
}

const COUNT_LABELS = {
  total: '전체',
  passed: '통과',
  high: '높음',
  medium: '보통',
  low: '낮음',
  info: '정보',
  pass: '통과',
  warning: '주의',
  fail: '실패',
}

const RESULT_PLAIN = {
  fail: '보안 기준을 충족하지 못해 수정이 필요합니다.',
  warning: '자동 검사만으로 확정할 수 없거나 확인할 신호가 있어 사람이 한 번 더 살펴봐야 합니다.',
  pass: '이번 검사 범위에서는 기준을 충족했습니다.',
}

const CURRENT_RESULT_LABELS = {
  fail: '기준 미충족',
  warning: '확인 필요',
  pass: '이번 점검 기준 충족',
}

const AI_STATUS_CONTENT = Object.freeze({
  not_requested: {
    badge: 'AI 미요청',
    guidance: 'API 키를 입력하지 않아 AI 해석을 요청하지 않았습니다. 결정적 점검 근거와 실제 설정을 함께 검토하세요.',
  },
  used: {
    badge: 'AI 사용',
    guidance: 'AI 설명은 보조 정보입니다. 확인 근거와 실제 설정을 함께 검토해 최종 판단하세요.',
  },
  failed: {
    badge: 'AI 분석 실패',
    guidance: 'Anthropic 분석을 완료하지 못했습니다. API 키·모델·Anthropic 계정 상태를 확인하고 API 키를 다시 입력한 뒤 점검하세요. 규칙 기반 결과는 그대로 확인할 수 있습니다.',
  },
  busy: {
    badge: 'AI 분석 혼잡',
    guidance: '현재 AI 분석 요청이 많아 실행하지 못했습니다. 잠시 후 API 키를 다시 입력하고 같은 URL을 점검하세요. 규칙 기반 결과는 그대로 확인할 수 있습니다.',
  },
})

export const FINDING_GUIDANCE = Object.freeze({
  'tls-version': {
    title: '암호화 연결이 충분히 안전한가요?',
    explanation: '브라우저와 서버가 TLS 1.2 이상의 안전한 방식으로 통신하는지 확인합니다.',
    criterion: 'TLS 1.2 또는 TLS 1.3으로 연결되면 기준을 충족합니다.',
    shortRemediation: '서버에서 TLS 1.2 이상만 허용하세요.',
    passComment: '안전한 암호화 통신 기준을 충족했습니다.',
  },
  'http-status': {
    title: '입력한 페이지가 바로 열리나요?',
    explanation: '입력한 경로가 오류나 다른 주소로의 이동 없이 정상 응답하는지 확인합니다.',
    criterion: 'HTTP 200~299 응답이면 기준을 충족하고, 이동·오류 응답이면 확인이 필요합니다.',
    shortRemediation: '응답 오류나 이동이 있다면 실제 운영 주소와 서버 상태를 확인하세요.',
    passComment: '입력한 페이지가 정상적으로 응답했습니다.',
  },
  'strict-transport-security': {
    title: '브라우저가 항상 HTTPS를 사용하게 하나요?',
    explanation: '한 번 접속한 뒤에도 브라우저가 암호화 연결만 사용하도록 정해 두었는지 확인합니다.',
    criterion: 'HSTS가 있고 적용 시간(max-age)이 0보다 크면 기준을 충족합니다.',
    shortRemediation: '서버 응답에 HSTS와 충분한 유지 시간을 설정하세요.',
    passComment: '브라우저가 HTTPS 연결을 유지하도록 설정되어 있습니다.',
  },
  'content-security-policy': {
    title: '페이지에서 불러올 코드를 제한하나요?',
    explanation: '허용하지 않은 스크립트나 외부 콘텐츠가 실행되지 않도록 출처를 제한했는지 확인합니다.',
    criterion: '기본 콘텐츠와 스크립트 출처가 제한된 CSP가 있어야 기준을 충족합니다.',
    shortRemediation: '서비스에 맞는 콘텐츠 보안 정책을 적용하세요.',
    passComment: '콘텐츠 출처를 제한하는 정책이 확인됐습니다.',
  },
  'clickjacking-protection': {
    title: '다른 사이트가 이 화면을 몰래 끼워 넣지 못하게 했나요?',
    explanation: '공격자가 페이지를 투명하게 겹쳐 사용자의 클릭을 가로채지 못하도록 막았는지 확인합니다.',
    criterion: '안전한 frame-ancestors 정책이나 DENY·SAMEORIGIN 설정이 있으면 기준을 충족합니다.',
    shortRemediation: '허용할 프레임 출처를 제한하거나 화면 삽입을 차단하세요.',
    passComment: '다른 사이트의 무단 화면 삽입을 막는 설정이 확인됐습니다.',
  },
  'x-content-type-options': {
    title: '브라우저가 파일 종류를 임의로 추측하지 않게 했나요?',
    explanation: '브라우저가 응답 파일을 다른 종류로 잘못 해석해 실행하지 않도록 설정했는지 확인합니다.',
    criterion: 'X-Content-Type-Options가 nosniff로 설정되어 있으면 기준을 충족합니다.',
    shortRemediation: '서버 응답에 nosniff 설정을 추가하세요.',
    passComment: '브라우저의 파일 종류 추측을 막는 설정이 확인됐습니다.',
  },
  'referrer-policy': {
    title: '다른 사이트에 불필요한 주소 정보가 넘어가지 않나요?',
    explanation: '링크를 따라갈 때 현재 페이지 주소가 외부 사이트에 과하게 전달되지 않는지 확인합니다.',
    criterion: '외부로 전달되는 주소 정보를 줄이는 안전한 Referrer-Policy가 있어야 기준을 충족합니다.',
    shortRemediation: '외부에 전달할 주소 범위를 줄이는 정책을 설정하세요.',
    passComment: '외부로 전달되는 주소 정보를 제한하고 있습니다.',
  },
  'permissions-policy': {
    title: '사용하지 않는 브라우저 기능을 막았나요?',
    explanation: '카메라나 마이크처럼 필요하지 않은 기능을 페이지에서 사용할 수 없게 했는지 확인합니다.',
    criterion: '와일드카드(*) 없이 최소 한 개의 불필요한 기능을 빈 목록()으로 막으면 기준을 충족합니다.',
    shortRemediation: '사용하지 않는 브라우저 기능을 명시적으로 차단하세요.',
    passComment: '일부 브라우저 기능을 명시적으로 제한하고 있습니다.',
  },
  'cookie-flags': {
    title: '응답 쿠키에 필요한 보호 설정이 있나요?',
    explanation: '응답 쿠키의 보호 속성을 확인합니다. 자동 검사는 세션 쿠키인지 구분하지 못하므로 결과를 직접 한 번 더 살펴봐야 합니다.',
    criterion: '쿠키가 없거나 모든 쿠키에 Secure·HttpOnly·SameSite가 있으면 기준을 충족합니다. 누락은 세션 쿠키인지 수동 확인합니다.',
    shortRemediation: '세션 쿠키에 Secure, HttpOnly, SameSite 속성을 설정하세요.',
    passComment: '응답 쿠키에서 보호 속성 누락을 찾지 못했습니다.',
  },
  'browser-mixed-content': {
    title: 'HTTPS 페이지가 안전하지 않은 주소를 섞어 쓰나요?',
    explanation: '암호화된 페이지 안에서 보호되지 않은 HTTP 주소를 불러오거나 연결하는지 확인합니다.',
    criterion: '확인한 HTML의 src·href·action에 http:// 신호가 없으면 이번 범위에서 기준을 충족합니다.',
    shortRemediation: 'HTTP 주소를 HTTPS나 안전한 상대 경로로 바꾸세요.',
    passComment: '공개 화면에서 보호되지 않은 HTTP 주소를 찾지 못했습니다.',
  },
  'browser-javascript-url': {
    title: '링크 주소에 실행 코드가 들어 있나요?',
    explanation: '클릭하는 순간 코드가 실행되는 javascript: 주소가 공개 화면에 있는지 확인합니다.',
    criterion: '확인한 HTML 속성에 javascript: 신호가 없으면 이번 범위에서 기준을 충족합니다.',
    shortRemediation: 'javascript: 주소를 없애고 안전한 이벤트 처리 방식을 사용하세요.',
    passComment: '공개 화면에서 javascript: 주소를 찾지 못했습니다.',
  },
  'browser-inline-script-sinks': {
    title: '화면 안에서 위험한 코드 실행 기능을 쓰나요?',
    explanation: '페이지에 직접 들어 있는 스크립트가 문자열을 코드나 HTML로 실행하는 기능을 쓰는지 확인합니다.',
    criterion: '확인한 인라인 스크립트에 eval·new Function·document.write 신호가 없으면 이번 범위에서 기준을 충족합니다.',
    shortRemediation: '동적 코드 실행과 document.write 사용을 없애세요.',
    passComment: '인라인 스크립트에서 지정된 위험 기능을 찾지 못했습니다.',
  },
  'browser-external-script-integrity': {
    title: '외부 스크립트가 바뀌지 않았는지 확인할 수 있나요?',
    explanation: '다른 사이트에서 가져온 고정 스크립트에 변조 여부를 확인하는 값이 있는지 살펴봅니다.',
    criterion: '확인한 교차 출처 스크립트에 integrity 누락 신호가 없으면 이번 범위에서 기준을 충족합니다.',
    shortRemediation: '고정된 외부 스크립트에 무결성 확인 값을 추가하세요.',
    passComment: '외부 스크립트의 무결성 확인 값 누락을 찾지 못했습니다.',
  },
})

const UNKNOWN_FINDING_GUIDANCE = Object.freeze({
  title: '추가 보안 항목을 확인했어요',
  explanation: '새로 추가된 검사 항목입니다. 현재 결과를 확인한 뒤 기술 세부 정보를 펼쳐 내용을 살펴보세요.',
  criterion: '새 항목의 정확한 기준은 기술 세부 정보와 서버 권장 조치를 함께 확인하세요.',
  shortRemediation: '기술 세부 정보의 근거와 권장 조치를 확인하세요.',
  passComment: '이번 검사에서는 이 항목의 문제 신호를 찾지 못했습니다.',
})

export function getFindingGuidance(finding) {
  return typeof finding?.id === 'string' && Object.hasOwn(FINDING_GUIDANCE, finding.id)
    ? FINDING_GUIDANCE[finding.id]
    : UNKNOWN_FINDING_GUIDANCE
}

async function readJson(response, fallbackMessage) {
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error(response.ok ? '서버 응답 형식을 확인할 수 없습니다.' : fallbackMessage)
  }

  if (!response.ok) {
    throw new Error(payload?.error?.message || payload?.message || fallbackMessage)
  }
  return payload
}

export async function fetchSecurityScanConfig(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(CONFIG_ENDPOINT, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  })
  const payload = await readJson(response, '보안 점검 설정을 불러오지 못했습니다.')

  if (
    typeof payload?.enabled !== 'boolean'
    || typeof payload.dynamicTargetInput !== 'boolean'
    || typeof payload.aiEnabled !== 'boolean'
    || payload.mode !== 'passive'
    || payload.aiProvider !== 'anthropic'
    || payload.aiCredentialMode !== 'request'
    || typeof payload.defaultAiModel !== 'string'
    || payload.defaultAiModel.trim().length === 0
    || !Array.isArray(payload.aiModels)
    || payload.aiModels.length === 0
    || payload.aiModels.some((model) => (
      !model
      || typeof model !== 'object'
      || typeof model.id !== 'string'
      || model.id.trim().length === 0
      || typeof model.label !== 'string'
      || model.label.trim().length === 0
    ))
    || !payload.aiModels.some((model) => model.id === payload.defaultAiModel)
  ) {
    throw new Error('보안 점검 설정 응답이 올바르지 않습니다.')
  }

  return payload
}

export function validateTargetUrl(targetUrl) {
  let parsed
  try {
    parsed = new URL(targetUrl)
  } catch {
    return 'https://로 시작하는 올바른 URL을 입력해 주세요.'
  }
  if (parsed.protocol !== 'https:') return '안전한 저영향 점검을 위해 HTTPS URL만 입력할 수 있습니다.'
  if (!parsed.hostname) return '호스트 이름이 포함된 URL을 입력해 주세요.'
  if (parsed.username || parsed.password) return 'URL에 사용자 이름이나 비밀번호를 포함할 수 없습니다.'
  if (targetUrl.includes('?')) return '쿼리 문자열이 없는 URL을 입력해 주세요.'
  if (targetUrl.includes('#')) return '해시가 없는 URL을 입력해 주세요.'
  if (parsed.port) return 'HTTPS 기본 포트(443)만 사용할 수 있습니다.'

  const hostname = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname
  const ipv4Literal = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) || /^\d+$/.test(hostname)
  if (ipv4Literal || hostname.includes(':')) return 'IP 주소 대신 공개 도메인 이름을 입력해 주세요.'
  return ''
}

export async function requestSecurityScan(targetUrl, optionsOrFetch = {}, fetchImpl = globalThis.fetch) {
  const validationError = validateTargetUrl(targetUrl)
  if (validationError) throw new Error(validationError)

  const options = typeof optionsOrFetch === 'function' ? {} : optionsOrFetch
  const requestFetch = typeof optionsOrFetch === 'function' ? optionsOrFetch : fetchImpl
  const anthropicApiKey = typeof options?.anthropicApiKey === 'string'
    ? options.anthropicApiKey.trim()
    : ''
  const anthropicModel = typeof options?.anthropicModel === 'string'
    ? options.anthropicModel.trim()
    : ''
  const requestBody = { targetUrl, authorizationConfirmed: true }

  if (anthropicApiKey) {
    if (!anthropicModel) throw new Error('Anthropic 모델을 선택해 주세요.')
    requestBody.anthropicApiKey = anthropicApiKey
    requestBody.anthropicModel = anthropicModel
  }

  const response = await requestFetch(SCAN_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  })
  const payload = await readJson(response, 'AI 보안 점검을 완료하지 못했습니다.')
  const expectedTarget = new URL(targetUrl)
  let reportedTargetMatches = false
  if (typeof payload?.scan?.targetUrl === 'string') {
    try {
      const reportedTarget = new URL(payload.scan.targetUrl)
      reportedTargetMatches = reportedTarget.origin === expectedTarget.origin
        && reportedTarget.pathname === expectedTarget.pathname
    } catch {
      reportedTargetMatches = false
    }
  }

  if (
    !payload?.scan
    || payload.scan.targetOrigin !== expectedTarget.origin
    || !reportedTargetMatches
    || !Array.isArray(payload.scan.findings)
  ) {
    throw new Error('보안 점검 결과 응답이 올바르지 않습니다.')
  }
  return payload.scan
}

export function describeTls(tls) {
  if (typeof tls === 'boolean') return tls ? 'HTTPS 적용' : 'HTTPS 미적용'
  if (typeof tls === 'string' && tls.length > 0) return tls
  if (!tls || typeof tls !== 'object') return '확인 불가'

  const enabled = tls.enabled ?? tls.secure
  const valid = tls.certificateValid ?? tls.valid
  const protocol = tls.protocol || tls.version
  const certificateValidTo = tls.certificateValidTo
  const parts = []

  if (enabled === true) parts.push('HTTPS 적용')
  if (enabled === false) parts.push('HTTPS 미적용')
  if (enabled === undefined && typeof protocol === 'string' && protocol.length > 0) parts.push('HTTPS 적용')
  if (valid === true) parts.push('인증서 유효')
  if (valid === false) parts.push('인증서 확인 필요')
  if (typeof protocol === 'string' && protocol.length > 0) parts.push(protocol)
  if (typeof certificateValidTo === 'string' && certificateValidTo.length > 0) {
    const date = new Date(certificateValidTo)
    parts.push(Number.isNaN(date.getTime()) ? `인증서 만료 ${certificateValidTo}` : `인증서 만료 ${date.toLocaleDateString('ko-KR')}`)
  }

  return parts.join(' · ') || '확인 불가'
}

function formatCheckedAt(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '확인 불가' : date.toLocaleString('ko-KR')
}

function countEntries(counts) {
  if (!counts || typeof counts !== 'object') return []
  return Object.entries(counts).filter(([, value]) => Number.isFinite(value))
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '확인 불가'
  if (value < 1024) return `${value} B`
  return `${(value / 1024).toFixed(1)} KB`
}

function sourceCoverageMessage(sourceSummary) {
  if (sourceSummary?.analyzed !== true) return 'HTML 코드는 검사하지 못함'
  if (sourceSummary.truncated === true) return '첫 256 KB까지만 검사함'
  if (sourceSummary.truncated === false) return '받은 HTML 전체를 검사함'
  return '확인 범위를 알 수 없음'
}

function sourceCoverageNote(sourceSummary) {
  if (sourceSummary?.analyzed !== true) return 'HTML 응답이 아니거나 읽을 수 없어 공개 코드 검사를 실행하지 못했습니다.'
  if (sourceSummary.truncated === true) return '페이지 앞부분만 확인했으므로 “신호 없음”이 전체 페이지의 안전을 보장하지는 않습니다.'
  return '첫 HTML 응답과 브라우저에 공개된 마크업·헤더만 확인했습니다.'
}

function normalizeLevel(value, labels) {
  return Object.hasOwn(labels, value) ? value : 'info'
}

export function resolveAiStatus(ai) {
  if (ai && typeof ai === 'object' && Object.hasOwn(AI_STATUS_CONTENT, ai.status)) {
    return ai.status
  }
  return ai?.used === true ? 'used' : 'not_requested'
}

export function printSecurityScanReport(
  printImpl = globalThis.window?.print?.bind(globalThis.window),
  reportRoot = globalThis.document?.querySelector?.('.audit-results'),
  afterPrintTarget = globalThis.window,
) {
  if (typeof printImpl !== 'function') {
    throw new Error('이 브라우저에서는 인쇄 기능을 사용할 수 없습니다.')
  }
  const collapsedDetails = reportRoot
    ? [...reportRoot.querySelectorAll('details:not([open])')]
    : []
  let restored = false
  const restoreDetails = () => {
    if (restored) return
    restored = true
    collapsedDetails.forEach((details) => { details.open = false })
    afterPrintTarget?.removeEventListener?.('afterprint', restoreDetails)
  }

  collapsedDetails.forEach((details) => { details.open = true })
  reportRoot?.getBoundingClientRect?.()
  afterPrintTarget?.addEventListener?.('afterprint', restoreDetails, { once: true })
  try {
    printImpl()
  } catch (error) {
    restoreDetails()
    throw error
  }
  if (!afterPrintTarget?.addEventListener) restoreDetails()
}

export function SecurityScanResult({ scan }) {
  const findings = Array.isArray(scan.findings) ? scan.findings : []
  const ai = scan.ai && typeof scan.ai === 'object' ? scan.ai : { used: false }
  const counts = countEntries(scan.counts)
  const riskLevel = normalizeLevel(ai.riskLevel, RISK_LABELS)
  const aiStatus = resolveAiStatus(ai)
  const aiStatusContent = AI_STATUS_CONTENT[aiStatus]
  const [printError, setPrintError] = useState('')
  const reportRef = useRef(null)

  const printReport = () => {
    setPrintError('')
    try {
      printSecurityScanReport(undefined, reportRef.current)
    } catch (error) {
      setPrintError(error?.message || '인쇄 창을 열지 못했습니다. 브라우저 설정을 확인해 주세요.')
    }
  }

  return (
    <section ref={reportRef} className="audit-results" aria-labelledby="audit-results-title">
      <div className="audit-report-actions no-print">
        <button
          type="button"
          className="btn-primary"
          aria-describedby="audit-print-help"
          onClick={printReport}
        >
          🖨️ 마지막 검사 결과 인쇄 / PDF 저장
        </button>
        <p id="audit-print-help">브라우저 인쇄 창에서 ‘PDF로 저장’을 선택하세요.</p>
      </div>
      {printError && <div className="report-print-error no-print" role="alert">{printError}</div>}

      <header className="audit-print-head print-only">
        <p className="audit-print-eyebrow">EDU SAFETY · PASSIVE URL SECURITY REVIEW</p>
        <h1>에듀 세이프 URL 보안 점검 결과</h1>
        <dl className="audit-print-meta">
          <div><dt>점검 대상</dt><dd>{scan.targetUrl || scan.targetOrigin}</dd></div>
          <div><dt>점검 시각</dt><dd>{formatCheckedAt(scan.checkedAt)}</dd></div>
          <div><dt>AI 보조 분석</dt><dd>{aiStatusContent.badge}</dd></div>
        </dl>
        <p className="audit-print-scope">
          입력 경로의 첫 HTML 응답과 공개 마크업·헤더를 저영향 방식으로 정적 점검한 결과입니다.
        </p>
      </header>

      <div className="audit-result-head">
        <div>
          <p className="hint" role="status">점검 완료 · {formatCheckedAt(scan.checkedAt)}</p>
          <h2 id="audit-results-title" className="audit-target">{scan.targetUrl || scan.targetOrigin}</h2>
        </div>
        <span className={`audit-badge audit-risk-${riskLevel}`}>
          종합 위험 {RISK_LABELS[riskLevel]}
        </span>
      </div>

      <p className="audit-summary">{scan.summary || '점검 요약이 제공되지 않았습니다.'}</p>

      <section className="audit-verdict-guide" aria-labelledby="audit-verdict-guide-title">
        <h2 id="audit-verdict-guide-title">판정 기준</h2>
        <p className="audit-verdict-note">
          실패는 이번 자동 검사 규칙을 충족하지 못했다는 뜻이며, 해킹이나 실제 악용이 확인됐다는 뜻은 아닙니다.
        </p>
        <ul className="audit-verdict-list">
          <li className="audit-verdict-fail"><strong>실패</strong><p>{RESULT_PLAIN.fail}</p></li>
          <li className="audit-verdict-warning"><strong>주의</strong><p>{RESULT_PLAIN.warning}</p></li>
          <li className="audit-verdict-pass"><strong>통과</strong><p>{RESULT_PLAIN.pass}</p></li>
        </ul>
      </section>

      <dl className="audit-metrics" aria-label="점검 요약 수치">
        <div>
          <dt>HTTP 상태</dt>
          <dd>{Number.isFinite(scan.httpStatus) ? scan.httpStatus : '응답 없음'}</dd>
        </div>
        <div>
          <dt>TLS</dt>
          <dd>{describeTls(scan.tls)}</dd>
        </div>
        {counts.map(([key, value]) => (
          <div key={key}>
            <dt>{COUNT_LABELS[key] || key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      {scan.sourceSummary && typeof scan.sourceSummary === 'object' && (
        <section className="audit-source-summary" aria-labelledby="audit-source-title">
          <h3 id="audit-source-title">정적 검사 범위</h3>
          <dl className="audit-source-metrics">
            <div><dt>콘텐츠 유형</dt><dd>{scan.sourceSummary.contentType || '확인 불가'}</dd></div>
            <div><dt>코드 분석</dt><dd>{scan.sourceSummary.analyzed === true ? '완료' : '건너뜀'}</dd></div>
            <div><dt>검사 용량</dt><dd>{formatBytes(scan.sourceSummary.bytesInspected)}</dd></div>
            <div>
              <dt>응답 범위</dt>
              <dd>{sourceCoverageMessage(scan.sourceSummary)}</dd>
            </div>
            <div><dt>script 요소</dt><dd>{Number.isFinite(scan.sourceSummary.scriptCount) ? scan.sourceSummary.scriptCount : '확인 불가'}</dd></div>
            <div><dt>form 요소</dt><dd>{Number.isFinite(scan.sourceSummary.formCount) ? scan.sourceSummary.formCount : '확인 불가'}</dd></div>
          </dl>
          <p className="hint">{sourceCoverageNote(scan.sourceSummary)}</p>
        </section>
      )}

      {Array.isArray(scan.limitations) && scan.limitations.length > 0 && (
        <details className="audit-limitations">
          <summary>검사 범위와 한계</summary>
          <ul>
            {scan.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
          </ul>
        </details>
      )}

      <section className="audit-section" aria-labelledby="audit-findings-title">
        <h2 id="audit-findings-title">세부 점검 결과</h2>
        {findings.length === 0 ? (
          <div className="audit-empty">
            <strong>표시할 점검 항목이 없습니다.</strong>
            <p>최신 상태가 필요하면 위의 다시 점검 버튼을 사용해 주세요.</p>
          </div>
        ) : (
          <div className="audit-finding-list">
            {findings.map((finding) => {
              const severity = normalizeLevel(finding.severity, SEVERITY_LABELS)
              const status = Object.hasOwn(STATUS_LABELS, finding.status) ? finding.status : 'warning'
              const guidance = getFindingGuidance(finding)
              return (
                <article key={finding.id} className={`audit-finding audit-result-${status}`}>
                  <div className={`audit-current-result audit-current-${status}`}>
                    <strong>현재 결과: {CURRENT_RESULT_LABELS[status]}</strong>
                    <span>{RESULT_PLAIN[status]}</span>
                  </div>
                  <h3>{guidance.title}</h3>
                  <p className="audit-finding-explanation">{guidance.explanation}</p>
                  <div className="audit-simple-criterion">
                    <strong>쉽게 보는 판정 기준</strong>
                    <p>{guidance.criterion}</p>
                  </div>
                  <div className="audit-quick-fix">
                    <strong>{status === 'pass' ? '결과 요약' : '짧은 보완 의견'}</strong>
                    <p>{status === 'pass' ? guidance.passComment : guidance.shortRemediation}</p>
                  </div>
                  <details className="audit-finding-details">
                    <summary>{finding.title || guidance.title} 전문가용 상세 보기</summary>
                    <dl className="audit-technical-meta">
                      <div><dt>검사 항목</dt><dd>{finding.title || '이름 없음'}</dd></div>
                      <div><dt>항목 ID</dt><dd>{finding.id || 'unknown'}</dd></div>
                      <div><dt>기술 상태</dt><dd>{STATUS_LABELS[status]}</dd></div>
                      <div><dt>미충족 시 중요도</dt><dd>{SEVERITY_LABELS[severity]}</dd></div>
                    </dl>
                    <div className="audit-evidence">
                      <strong>기술 근거</strong>
                      <p>{finding.evidence || '확인 가능한 근거가 제공되지 않았습니다.'}</p>
                    </div>
                    <div className="audit-remediation">
                      <strong>{status === 'pass' ? '설정 유지 사항' : '상세 권장 조치'}</strong>
                      <p>{finding.remediation || '추가 조치가 필요하지 않습니다.'}</p>
                    </div>
                  </details>
                </article>
              )
            })}
          </div>
        )}
      </section>

      <section className="audit-ai" aria-labelledby="audit-ai-title">
        <div className="audit-ai-head">
          <h2 id="audit-ai-title">AI 분석 요약</h2>
          <span className={`audit-badge audit-ai-status-${aiStatus}`}>{aiStatusContent.badge}</span>
        </div>
        <p>{ai.overview || '결정적 규칙과 서버 응답을 바탕으로 점검 결과를 확인했습니다.'}</p>
        {Array.isArray(ai.priorityActions) && ai.priorityActions.length > 0 && (
          <div className="audit-priority-actions">
            <strong>우선 조치</strong>
            <ol>
              {ai.priorityActions.map((action, index) => <li key={`${index}-${action}`}>{action}</li>)}
            </ol>
          </div>
        )}
        <p className="hint">{aiStatusContent.guidance}</p>
      </section>
    </section>
  )
}

export function SecurityScanForm({
  enabled,
  aiEnabled = false,
  aiModels = [],
  targetUrl,
  anthropicApiKey = '',
  anthropicModel = '',
  authorizationConfirmed,
  scanning,
  hasScan,
  error,
  targetError = '',
  onTargetUrlChange,
  onAnthropicApiKeyChange,
  onAnthropicModelChange,
  onAuthorizationChange,
  onSubmit,
}) {
  const hasAnthropicApiKey = anthropicApiKey.trim().length > 0
  const aiSelectionReady = !aiEnabled || !hasAnthropicApiKey || anthropicModel.trim().length > 0
  const aiControlsDisabled = !enabled || !aiEnabled || scanning
  const canSubmit = enabled
    && targetUrl.trim().length > 0
    && authorizationConfirmed
    && aiSelectionReady
    && !scanning

  return (
    <form
      className="scan-box audit-form no-print"
      aria-label="URL 보안 점검 실행"
      aria-describedby="security-audit-scope"
      onSubmit={onSubmit}
    >
      <div id="security-audit-scope" className="hint">
        입력한 경로의 첫 HTML 응답과 브라우저 공개 마크업·헤더만 정적으로 확인합니다. JavaScript 실행, 로그인, 크롤링, 공격·익스플로잇은 수행하지 않습니다.
      </div>
      <label className="field" htmlFor="security-audit-target">검사할 URL
        <input
          id="security-audit-target"
          type="url"
          inputMode="url"
          autoComplete="url"
          spellCheck="false"
          placeholder="https://example.com"
          value={targetUrl}
          required
          disabled={!enabled || scanning}
          aria-invalid={targetError ? 'true' : undefined}
          aria-describedby={targetError
            ? 'security-audit-scope security-audit-target-error'
            : 'security-audit-scope'}
          onChange={(event) => onTargetUrlChange(event.target.value)}
        />
      </label>
      {targetError && (
        <div id="security-audit-target-error" className="error audit-field-error" role="alert">⚠️ {targetError}</div>
      )}
      <fieldset className="audit-ai-settings" disabled={aiControlsDisabled}>
        <legend>Anthropic AI 보조 분석 (선택)</legend>
        <p id="security-audit-ai-help" className="hint">
          {aiEnabled
            ? 'API 키를 입력하지 않으면 기존 규칙 검사만 실행합니다. 키는 브라우저에 저장하지 않고 이번 검사 요청에만 포함합니다.'
            : '현재 Anthropic AI 보조 분석을 사용할 수 없습니다. API 키 없이 기존 규칙 검사만 실행합니다.'}
        </p>
        <div className="audit-ai-settings-grid">
          <label className="field" htmlFor="security-audit-anthropic-key">ANTHROPIC_API_KEY
            <input
              id="security-audit-anthropic-key"
              name="anthropicApiKey"
              type="password"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck="false"
              value={anthropicApiKey}
              disabled={aiControlsDisabled}
              aria-describedby="security-audit-ai-help"
              onChange={(event) => onAnthropicApiKeyChange?.(event.target.value)}
            />
          </label>
          <label className="field" htmlFor="security-audit-anthropic-model">ANTHROPIC_MODEL
            <select
              id="security-audit-anthropic-model"
              name="anthropicModel"
              value={anthropicModel}
              required={hasAnthropicApiKey}
              disabled={aiControlsDisabled}
              aria-describedby="security-audit-ai-help"
              onChange={(event) => onAnthropicModelChange?.(event.target.value)}
            >
              {aiModels.map((model) => (
                <option key={model.id} value={model.id}>{model.label}</option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>
      <label className="audit-authorization">
        <input
          type="checkbox"
          checked={authorizationConfirmed}
          required
          disabled={!enabled || scanning}
          onChange={(event) => onAuthorizationChange(event.target.checked)}
        />
        <span>이 URL은 본인이 소유했거나 보안 점검에 대한 명시적 허가를 받은 대상입니다.</span>
      </label>
      <div className="btn-row">
        <button type="submit" className="btn-primary" disabled={!canSubmit}>
          {scanning ? '저영향 URL 점검 실행 중…' : hasScan ? '같은 URL 다시 점검' : '저영향 URL 점검 시작'}
        </button>
      </div>
      {error && <div className="error" role="alert">⚠️ {error}</div>}
      {scanning && (
        <div className="busy" role="status" aria-live="polite">
          입력한 URL의 첫 HTML 응답과 공개 마크업·헤더를 정적으로 확인하고 있습니다.
        </div>
      )}
    </form>
  )
}

export default function SecurityAuditPage() {
  const [configAttempt, setConfigAttempt] = useState(0)
  const [config, setConfig] = useState(null)
  const [targetUrl, setTargetUrl] = useState('')
  const [anthropicApiKey, setAnthropicApiKey] = useState('')
  const [anthropicModel, setAnthropicModel] = useState('')
  const [authorizationConfirmed, setAuthorizationConfirmed] = useState(false)
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [configError, setConfigError] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState('')
  const [targetError, setTargetError] = useState('')
  const [scan, setScan] = useState(null)

  useEffect(() => {
    let active = true
    setLoadingConfig(true)
    setConfigError('')

    void fetchSecurityScanConfig()
      .then((nextConfig) => {
        if (!active) return
        setConfig(nextConfig)
        setAnthropicModel(nextConfig.defaultAiModel)
      })
      .catch((error) => {
        if (!active) return
        setConfig(null)
        setConfigError(error.message)
      })
      .finally(() => {
        if (active) setLoadingConfig(false)
      })

    return () => { active = false }
  }, [configAttempt])

  const runScan = async (event) => {
    event.preventDefault()
    if (!config?.enabled || config.dynamicTargetInput !== true) {
      setScanError('현재 URL 점검 기능을 사용할 수 없습니다.')
      return
    }
    if (!authorizationConfirmed) {
      setScanError('본인 소유 또는 점검 허가를 받은 대상인지 확인해 주세요.')
      return
    }

    const submittedUrl = targetUrl.trim()
    const validationError = validateTargetUrl(submittedUrl)
    if (validationError) {
      setTargetError(validationError)
      setScanError('')
      return
    }

    const trimmedApiKey = anthropicApiKey.trim()
    const aiOptions = config.aiEnabled && trimmedApiKey
      ? { anthropicApiKey: trimmedApiKey, anthropicModel }
      : {}
    if (trimmedApiKey) setAnthropicApiKey('')
    setScanning(true)
    setTargetError('')
    setScanError('')
    setScan(null)
    try {
      setScan(await requestSecurityScan(submittedUrl, aiOptions))
    } catch (error) {
      setScanError(error.message)
    } finally {
      setScanning(false)
    }
  }

  const scanEnabled = !!config?.enabled && config.dynamicTargetInput === true

  return (
    <section className="panel security-audit" aria-labelledby="security-audit-title" aria-busy={loadingConfig || scanning}>
      <h1 id="security-audit-title">🔎 URL 검사</h1>
      <p className="intro">
        입력한 URL 경로의 첫 HTML 응답과 브라우저 공개 마크업·헤더를 저영향 방식으로 정적 검사합니다.
      </p>

      <div className="audit-boundary" role="note">
        <strong>점검 범위</strong>
        <p>
          본인이 소유했거나 명시적으로 점검 허가를 받은 HTTPS URL만 입력하세요.
          서버가 대상을 다시 검증하며 JavaScript 실행, 로그인, 사이트 크롤링, 공격·익스플로잇은 수행하지 않습니다.
        </p>
      </div>

      {loadingConfig ? (
        <div className="busy" role="status" aria-live="polite">보안 점검 구성을 불러오는 중…</div>
      ) : configError ? (
        <div className="audit-config-error">
          <div className="error" role="alert">⚠️ {configError}</div>
          <button type="button" className="btn-secondary" onClick={() => setConfigAttempt((attempt) => attempt + 1)}>
            설정 다시 불러오기
          </button>
        </div>
      ) : (
        <>
          <dl className="audit-config-grid" aria-label="점검 실행 조건">
            <div><dt>점검 방식</dt><dd>저영향 분석</dd></div>
            <div><dt>AI 보조 분석</dt><dd>{config.aiEnabled ? 'Anthropic 사용 가능' : '사용 안 함'}</dd></div>
            <div><dt>대상 입력</dt><dd>{config.dynamicTargetInput ? 'HTTPS URL 직접 입력' : '사용 안 함'}</dd></div>
          </dl>

          {!config.enabled && (
            <div className="gate-warn" role="status">현재 서버에서 보안 점검 기능을 비활성화했습니다.</div>
          )}
          {config.enabled && !config.dynamicTargetInput && (
            <div className="gate-warn" role="status">현재 서버에서 URL 직접 입력을 비활성화했습니다.</div>
          )}

          <SecurityScanForm
            enabled={scanEnabled}
            aiEnabled={config.aiEnabled}
            aiModels={config.aiModels}
            targetUrl={targetUrl}
            anthropicApiKey={anthropicApiKey}
            anthropicModel={anthropicModel}
            authorizationConfirmed={authorizationConfirmed}
            scanning={scanning}
            hasScan={!!scan}
            error={scanError}
            targetError={targetError}
            onTargetUrlChange={(value) => {
              setTargetUrl(value)
              setAuthorizationConfirmed(false)
              setTargetError('')
              setScanError('')
              setScan(null)
            }}
            onAnthropicApiKeyChange={(value) => {
              setAnthropicApiKey(value)
              setScanError('')
            }}
            onAnthropicModelChange={(value) => {
              setAnthropicModel(value)
              setScanError('')
            }}
            onAuthorizationChange={(checked) => {
              setAuthorizationConfirmed(checked)
              setScanError('')
            }}
            onSubmit={runScan}
          />
        </>
      )}

      {scan && <SecurityScanResult scan={scan} />}
    </section>
  )
}
