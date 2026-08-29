import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import App from '../src/App.jsx'
import SecurityAuditPage, {
  FINDING_GUIDANCE,
  SecurityScanForm,
  SecurityScanResult,
  describeTls,
  fetchSecurityScanConfig,
  getFindingGuidance,
  printSecurityScanReport,
  requestSecurityScan,
  resolveAiStatus,
  validateTargetUrl,
} from '../src/components/SecurityAuditPage.jsx'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const anthropicConfig = {
  enabled: true,
  dynamicTargetInput: true,
  aiEnabled: true,
  mode: 'passive',
  aiProvider: 'anthropic',
  aiCredentialMode: 'request',
  defaultAiModel: 'claude-sonnet-5',
  aiModels: [
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 · 균형형' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 · 빠른 분석' },
  ],
}

describe('AI 보안 점검 화면', () => {
  it('서버의 known finding 13개에 쉬운 설명을 모두 제공한다', () => {
    expect(Object.keys(FINDING_GUIDANCE).sort()).toEqual([
      'browser-external-script-integrity',
      'browser-inline-script-sinks',
      'browser-javascript-url',
      'browser-mixed-content',
      'clickjacking-protection',
      'content-security-policy',
      'cookie-flags',
      'http-status',
      'permissions-policy',
      'referrer-policy',
      'strict-transport-security',
      'tls-version',
      'x-content-type-options',
    ])
    for (const guidance of Object.values(FINDING_GUIDANCE)) {
      expect(guidance.title.length).toBeGreaterThan(0)
      expect(guidance.explanation.length).toBeGreaterThan(0)
      expect(guidance.criterion.length).toBeGreaterThan(0)
      expect(guidance.shortRemediation.length).toBeGreaterThan(0)
      expect(guidance.passComment.length).toBeGreaterThan(0)
    }
  })

  it('알 수 없는 finding id에는 안전한 기본 설명을 제공한다', () => {
    expect(getFindingGuidance({ id: 'future-security-check' })).toMatchObject({
      title: '추가 보안 항목을 확인했어요',
      shortRemediation: '기술 세부 정보의 근거와 권장 조치를 확인하세요.',
    })
    expect(getFindingGuidance({ id: '__proto__' }).title).toBe('추가 보안 항목을 확인했어요')
  })

  it('상단 주 메뉴에 보안 점검 진입점을 노출한다', () => {
    const html = renderToStaticMarkup(createElement(App))

    expect(html).toContain('aria-label="주 메뉴"')
    expect(html).toContain('🔎 URL 검사')
  })

  it('초기 화면에서 소유·허가 대상과 저영향 점검 경계를 먼저 알린다', () => {
    const html = renderToStaticMarkup(createElement(SecurityAuditPage))

    expect(html).toContain('URL 검사')
    expect(html).toContain('본인이 소유했거나 명시적으로 점검 허가를 받은 HTTPS URL만')
    expect(html).toContain('JavaScript 실행, 로그인, 사이트 크롤링')
    expect(html).toContain('공격·익스플로잇은 수행하지 않습니다')
    expect(html).toContain('role="status"')
    expect(html).toContain('보안 점검 구성을 불러오는 중')
    expect(html).not.toContain('마지막 검사 결과 인쇄 / PDF 저장')
  })

  it('공개 endpoint에서 passive 동적 URL 입력 설정을 불러온다', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(anthropicConfig))

    await expect(fetchSecurityScanConfig(fetchImpl)).resolves.toEqual(anthropicConfig)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith('/api/security-scan/config', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
  })

  it('동적 URL 입력이 꺼진 구성을 오류 없이 받아들인다', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      enabled: false,
      dynamicTargetInput: false,
      aiEnabled: false,
      mode: 'passive',
      aiProvider: 'anthropic',
      aiCredentialMode: 'request',
      defaultAiModel: 'claude-haiku-4-5-20251001',
      aiModels: [{ id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 · 빠른 분석' }],
    }))

    await expect(fetchSecurityScanConfig(fetchImpl)).resolves.toEqual({
      enabled: false,
      dynamicTargetInput: false,
      aiEnabled: false,
      mode: 'passive',
      aiProvider: 'anthropic',
      aiCredentialMode: 'request',
      defaultAiModel: 'claude-haiku-4-5-20251001',
      aiModels: [{ id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 · 빠른 분석' }],
    })
  })

  it('Anthropic 요청 자격 증명과 선택 모델 구성이 아니면 거절한다', async () => {
    for (const invalidConfig of [
      { ...anthropicConfig, aiProvider: 'openai' },
      { ...anthropicConfig, aiCredentialMode: 'environment' },
      { ...anthropicConfig, defaultAiModel: 'missing-model' },
      { ...anthropicConfig, aiModels: [] },
      { ...anthropicConfig, aiModels: [{ id: '', label: '이름 없음' }] },
    ]) {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(invalidConfig))
      await expect(fetchSecurityScanConfig(fetchImpl))
        .rejects.toThrow('보안 점검 설정 응답이 올바르지 않습니다.')
    }
  })

  it('입력 URL과 권한 확인 literal만 점검 API에 전송한다', async () => {
    const targetUrl = 'https://school.example/health'
    const scan = {
      targetOrigin: 'https://school.example',
      targetUrl: 'https://school.example/health',
      checkedAt: '2026-08-28T01:00:00.000Z',
      httpStatus: 200,
      tls: true,
      summary: '기본 보안 신호를 확인했습니다.',
      counts: { pass: 1, warning: 0, fail: 0 },
      findings: [],
      ai: { used: false, overview: '', riskLevel: 'low', priorityActions: [] },
    }
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ scan }))

    await expect(requestSecurityScan(targetUrl, fetchImpl)).resolves.toEqual(scan)
    expect(fetchImpl).toHaveBeenCalledWith('/api/security-scan', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ targetUrl, authorizationConfirmed: true }),
    })
  })

  it('입력한 Anthropic 키와 선택 모델을 현재 점검 요청에만 추가한다', async () => {
    const targetUrl = 'https://school.example/health'
    const scan = {
      targetOrigin: 'https://school.example',
      targetUrl,
      findings: [],
    }
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ scan }))

    await requestSecurityScan(targetUrl, {
      anthropicApiKey: '  sk-ant-user-key  ',
      anthropicModel: '  claude-sonnet-5  ',
    }, fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith('/api/security-scan', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetUrl,
        authorizationConfirmed: true,
        anthropicApiKey: 'sk-ant-user-key',
        anthropicModel: 'claude-sonnet-5',
      }),
    })
  })

  it('공백 API 키는 모델과 함께 생략하고 기존 규칙 검사 본문을 유지한다', async () => {
    const targetUrl = 'https://school.example/health'
    const scan = {
      targetOrigin: 'https://school.example',
      targetUrl,
      findings: [],
    }
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ scan }))

    await requestSecurityScan(targetUrl, {
      anthropicApiKey: '   ',
      anthropicModel: 'claude-sonnet-5',
    }, fetchImpl)

    const [, request] = fetchImpl.mock.calls[0]
    expect(JSON.parse(request.body)).toEqual({ targetUrl, authorizationConfirmed: true })
  })

  it('서버 오류 메시지를 실행 위치에 표시할 수 있도록 전달한다', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      error: { message: '허용되지 않은 대상입니다.' },
    }, 403))

    await expect(requestSecurityScan('https://blocked.example/path', fetchImpl))
      .rejects.toThrow('허용되지 않은 대상입니다.')
  })

  it('서버가 다른 pathname의 결과를 반환하면 거절한다', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      scan: {
        targetOrigin: 'https://school.example',
        targetUrl: 'https://school.example/different',
        findings: [],
      },
    }))

    await expect(requestSecurityScan('https://school.example/expected', fetchImpl))
      .rejects.toThrow('보안 점검 결과 응답이 올바르지 않습니다.')
  })

  it('서버 결과에 정규화된 targetUrl이 없으면 거절한다', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      scan: { targetOrigin: 'https://school.example', findings: [] },
    }))

    await expect(requestSecurityScan('https://school.example/expected', fetchImpl))
      .rejects.toThrow('보안 점검 결과 응답이 올바르지 않습니다.')
  })

  it('URL 입력과 필수 권한 확인 전에는 제출 버튼을 비활성화한다', () => {
    const html = renderToStaticMarkup(createElement(SecurityScanForm, {
      enabled: true,
      aiEnabled: true,
      aiModels: anthropicConfig.aiModels,
      targetUrl: 'https://school.example',
      anthropicApiKey: '',
      anthropicModel: anthropicConfig.defaultAiModel,
      authorizationConfirmed: false,
      scanning: false,
      hasScan: false,
      error: '',
      onTargetUrlChange: () => {},
      onAuthorizationChange: () => {},
      onSubmit: () => {},
    }))

    expect(html).toContain('type="url"')
    expect(html).toContain('placeholder="https://example.com"')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('명시적 허가를 받은 대상입니다')
    expect(html).toContain('class="scan-box audit-form no-print"')
    expect(html).toContain('<fieldset class="audit-ai-settings">')
    expect(html).toContain('ANTHROPIC_API_KEY')
    expect(html).toContain('type="password"')
    expect(html).toContain('autoComplete="off"')
    expect(html).toContain('ANTHROPIC_MODEL')
    expect(html).toContain('<select id="security-audit-anthropic-model"')
    expect(html).toContain('Claude Sonnet 5 · 균형형')
    expect(html).toContain('API 키를 입력하지 않으면 기존 규칙 검사만 실행합니다')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>저영향 URL 점검 시작<\/button>/)
  })

  it('동적 URL 입력이 꺼지면 입력·확인·실행을 모두 비활성화한다', () => {
    const html = renderToStaticMarkup(createElement(SecurityScanForm, {
      enabled: false,
      aiEnabled: true,
      aiModels: anthropicConfig.aiModels,
      targetUrl: 'https://school.example/health',
      anthropicApiKey: 'sk-ant-user-key',
      anthropicModel: anthropicConfig.defaultAiModel,
      authorizationConfirmed: true,
      scanning: false,
      hasScan: false,
      error: '',
      onTargetUrlChange: () => {},
      onAuthorizationChange: () => {},
      onSubmit: () => {},
    }))

    expect(html).toMatch(/<input[^>]*type="url"[^>]*disabled=""/)
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*disabled=""/)
    expect(html).toMatch(/<fieldset[^>]*disabled=""/)
    expect(html).toMatch(/<input[^>]*type="password"[^>]*disabled=""/)
    expect(html).toMatch(/<select[^>]*disabled=""/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>저영향 URL 점검 시작<\/button>/)
  })

  it('AI가 unavailable이어도 키 없이 기존 규칙 검사를 실행할 수 있다', () => {
    const html = renderToStaticMarkup(createElement(SecurityScanForm, {
      enabled: true,
      aiEnabled: false,
      aiModels: anthropicConfig.aiModels,
      targetUrl: 'https://school.example/health',
      anthropicApiKey: '',
      anthropicModel: anthropicConfig.defaultAiModel,
      authorizationConfirmed: true,
      scanning: false,
      hasScan: false,
      error: '',
      onTargetUrlChange: () => {},
      onAnthropicApiKeyChange: () => {},
      onAnthropicModelChange: () => {},
      onAuthorizationChange: () => {},
      onSubmit: () => {},
    }))

    expect(html).toMatch(/<fieldset[^>]*disabled=""/)
    expect(html).toContain('API 키 없이 기존 규칙 검사만 실행합니다')
    expect(html).toMatch(/<button[^>]*>저영향 URL 점검 시작<\/button>/)
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>저영향 URL 점검 시작<\/button>/)
  })

  it('점검 실행 중에는 Anthropic 키와 모델 입력도 비활성화한다', () => {
    const html = renderToStaticMarkup(createElement(SecurityScanForm, {
      enabled: true,
      aiEnabled: true,
      aiModels: anthropicConfig.aiModels,
      targetUrl: 'https://school.example/health',
      anthropicApiKey: 'sk-ant-user-key',
      anthropicModel: anthropicConfig.defaultAiModel,
      authorizationConfirmed: true,
      scanning: true,
      hasScan: false,
      error: '',
      onTargetUrlChange: () => {},
      onAnthropicApiKeyChange: () => {},
      onAnthropicModelChange: () => {},
      onAuthorizationChange: () => {},
      onSubmit: () => {},
    }))

    expect(html).toMatch(/<fieldset[^>]*disabled=""/)
    expect(html).toMatch(/<input[^>]*type="password"[^>]*disabled=""/)
    expect(html).toMatch(/<select[^>]*disabled=""/)
    expect(html).toContain('저영향 URL 점검 실행 중…')
  })

  it('URL 검증 오류를 입력과 연결해 표시한다', () => {
    const html = renderToStaticMarkup(createElement(SecurityScanForm, {
      enabled: true,
      aiEnabled: true,
      aiModels: anthropicConfig.aiModels,
      targetUrl: 'http://school.example',
      anthropicApiKey: '',
      anthropicModel: anthropicConfig.defaultAiModel,
      authorizationConfirmed: true,
      scanning: false,
      hasScan: false,
      error: '',
      targetError: 'HTTPS URL만 입력할 수 있습니다.',
      onTargetUrlChange: () => {},
      onAnthropicApiKeyChange: () => {},
      onAnthropicModelChange: () => {},
      onAuthorizationChange: () => {},
      onSubmit: () => {},
    }))

    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('aria-describedby="security-audit-scope security-audit-target-error"')
    expect(html).toContain('id="security-audit-target-error"')
    expect(html).toContain('role="alert"')
  })

  it('HTTPS URL만 클라이언트 점검 대상으로 인정한다', () => {
    expect(validateTargetUrl('https://school.example/path')).toBe('')
    expect(validateTargetUrl('https://school.example:443/path')).toBe('')
    expect(validateTargetUrl('http://school.example')).toContain('HTTPS URL만')
    expect(validateTargetUrl('school.example')).toContain('올바른 URL')
    expect(validateTargetUrl('https://user:secret@school.example/path')).toContain('사용자 이름이나 비밀번호')
    expect(validateTargetUrl('https://school.example/path?course=1')).toContain('쿼리 문자열')
    expect(validateTargetUrl('https://school.example/path?')).toContain('쿼리 문자열')
    expect(validateTargetUrl('https://school.example/path#details')).toContain('해시')
    expect(validateTargetUrl('https://school.example/path#')).toContain('해시')
    expect(validateTargetUrl('https://school.example:8443/path')).toContain('기본 포트')
    expect(validateTargetUrl('https://127.0.0.1/path')).toContain('IP 주소')
    expect(validateTargetUrl('https://[2001:db8::1]/path')).toContain('IP 주소')
  })

  it('근거·개선안·AI 우선 조치를 결과에 함께 렌더링한다', () => {
    const html = renderToStaticMarkup(createElement(SecurityScanResult, {
      scan: {
        targetOrigin: 'https://school.example',
        targetUrl: 'https://school.example/course/login',
        checkedAt: '2026-08-28T01:00:00.000Z',
        httpStatus: 200,
        tls: { enabled: true, certificateValid: true, protocol: 'TLS 1.3' },
        summary: '보안 헤더 한 건을 보완해야 합니다.',
        counts: { pass: 2, warning: 1, fail: 0 },
        sourceSummary: {
          contentType: 'text/html; charset=utf-8',
          analyzed: true,
          bytesInspected: 12_288,
          truncated: false,
          scriptCount: 3,
          formCount: 1,
        },
        limitations: ['외부 JavaScript 번들은 실행하거나 내려받지 않습니다.'],
        findings: [{
          id: 'content-security-policy',
          title: '콘텐츠 보안 정책',
          severity: 'medium',
          status: 'warning',
          evidence: 'Content-Security-Policy 응답 헤더가 없습니다.',
          remediation: '서비스 응답에 CSP 헤더를 추가하세요.',
        }],
        ai: {
          status: 'used',
          used: true,
          overview: '현재 가장 먼저 보완할 항목은 CSP입니다.',
          riskLevel: 'medium',
          priorityActions: ['CSP 헤더 적용'],
        },
      },
    }))

    expect(html).toContain('HTTPS 적용 · 인증서 유효 · TLS 1.3')
    expect(html).toContain('https://school.example/course/login')
    expect(html).toContain('판정 기준')
    expect(html).toContain('해킹이나 실제 악용이 확인됐다는 뜻은 아닙니다')
    expect(html).toContain('보안 기준을 충족하지 못해 수정이 필요합니다.')
    expect(html).toContain('자동 검사만으로 확정할 수 없거나 확인할 신호가 있어')
    expect(html).toContain('이번 검사 범위에서는 기준을 충족했습니다.')
    expect(html).toContain('페이지에서 불러올 코드를 제한하나요?')
    expect(html).toContain('현재 결과: 확인 필요')
    expect(html).toContain('쉽게 보는 판정 기준')
    expect(html).toContain('기본 콘텐츠와 스크립트 출처가 제한된 CSP')
    expect(html).toContain('짧은 보완 의견')
    expect(html).toContain('<details class="audit-finding-details">')
    expect(html).toContain('콘텐츠 보안 정책 전문가용 상세 보기')
    expect(html).toContain('content-security-policy')
    expect(html).toContain('기술 근거')
    expect(html).toContain('상세 권장 조치')
    expect(html).toContain('미충족 시 중요도')
    expect(html).toContain('Content-Security-Policy 응답 헤더가 없습니다.')
    expect(html).toContain('서비스 응답에 CSP 헤더를 추가하세요.')
    expect(html).toContain('CSP 헤더 적용')
    expect(html).toContain('AI 사용')
    expect(html).toContain('AI 설명은 보조 정보입니다')
    expect(html).toContain('정적 검사 범위')
    expect(html).toContain('text/html; charset=utf-8')
    expect(html).toContain('코드 분석</dt><dd>완료')
    expect(html).toContain('12.0 KB')
    expect(html).toContain('받은 HTML 전체를 검사함')
    expect(html).toContain('script 요소</dt><dd>3')
    expect(html).toContain('form 요소</dt><dd>1')
    expect(html).toContain('검사 범위와 한계')
    expect(html).toContain('외부 JavaScript 번들은 실행하거나 내려받지 않습니다.')
    expect(html).toContain('🖨️ 마지막 검사 결과 인쇄 / PDF 저장')
    expect(html).toContain('브라우저 인쇄 창에서 ‘PDF로 저장’을 선택하세요.')
    expect(html).toContain('class="audit-print-head print-only"')
    expect(html).toContain('에듀 세이프 URL 보안 점검 결과')
    expect(html).toContain('EDU SAFETY · PASSIVE URL SECURITY REVIEW')
    expect(html).not.toContain('ANTHROPIC_API_KEY')
    expect(html).not.toContain('aria-live="polite"')
  })

  it('인쇄 helper는 심사 보고서와 같은 브라우저 print 경로를 한 번 호출한다', () => {
    const printImpl = vi.fn()

    printSecurityScanReport(printImpl)

    expect(printImpl).toHaveBeenCalledTimes(1)
  })

  it('인쇄하는 동안 닫힌 기술 상세를 펼치고 afterprint 뒤 원래 상태로 복원한다', () => {
    const details = [{ open: false }, { open: false }]
    const reportRoot = {
      querySelectorAll: vi.fn().mockReturnValue(details),
      getBoundingClientRect: vi.fn(),
    }
    let afterPrint
    const afterPrintTarget = {
      addEventListener: vi.fn((_name, listener) => { afterPrint = listener }),
      removeEventListener: vi.fn(),
    }
    const printImpl = vi.fn(() => {
      expect(details.every(({ open }) => open)).toBe(true)
    })

    printSecurityScanReport(printImpl, reportRoot, afterPrintTarget)
    expect(details.every(({ open }) => open)).toBe(true)

    afterPrint()
    expect(details.every(({ open }) => !open)).toBe(true)
    expect(afterPrintTarget.removeEventListener).toHaveBeenCalledWith('afterprint', afterPrint)
  })

  it('브라우저 인쇄 기능이 없으면 명확한 오류를 반환한다', () => {
    expect(() => printSecurityScanReport(null)).toThrow('이 브라우저에서는 인쇄 기능을 사용할 수 없습니다.')
  })

  it('통과 항목은 유지 안내로, 일부 HTML 검사는 범위 제한으로 표시한다', () => {
    const html = renderToStaticMarkup(createElement(SecurityScanResult, {
      scan: {
        targetOrigin: 'https://school.example',
        targetUrl: 'https://school.example/',
        checkedAt: '2026-08-28T01:00:00.000Z',
        httpStatus: 200,
        tls: { protocol: 'TLSv1.3', certificateValidTo: null },
        summary: '이번 범위에서 보완 신호를 찾지 못했습니다.',
        counts: { passed: 1, high: 0, medium: 0, low: 0, info: 0 },
        sourceSummary: {
          contentType: 'text/html',
          analyzed: true,
          bytesInspected: 262_144,
          truncated: true,
          scriptCount: 1,
          formCount: 0,
        },
        findings: [{
          id: 'tls-version',
          title: 'TLS 프로토콜',
          severity: 'high',
          status: 'pass',
          evidence: '협상된 프로토콜: TLSv1.3',
          remediation: 'TLS 1.2 이상을 유지하세요.',
        }],
        ai: { used: false, overview: '', riskLevel: 'minimal', priorityActions: [] },
      },
    }))

    expect(html).toContain('현재 결과: 이번 점검 기준 충족')
    expect(html).toContain('결과 요약')
    expect(html).toContain('설정 유지 사항')
    expect(html).not.toContain('짧은 보완 의견')
    expect(html).toContain('첫 256 KB까지만 검사함')
    expect(html).toContain('“신호 없음”이 전체 페이지의 안전을 보장하지는 않습니다')
    expect(html).toContain('<details class="audit-finding-details">')
    expect(html).not.toContain('<details class="audit-finding-details" open=""')
  })

  it('AI를 사용하지 않아도 결정적 점검 요약과 우선 조치를 숨기지 않는다', () => {
    const html = renderToStaticMarkup(createElement(SecurityScanResult, {
      scan: {
        targetOrigin: 'https://school.example',
        checkedAt: '2026-08-28T01:00:00.000Z',
        httpStatus: 200,
        tls: { protocol: 'TLSv1.3', certificateValidTo: '2030-01-01T00:00:00.000Z' },
        summary: '개선 권고 1개가 확인되었습니다.',
        counts: { passed: 4, high: 0, medium: 1, low: 0, info: 0 },
        findings: [],
        ai: {
          used: false,
          overview: '결정적 검사에서 개선 항목 1개를 확인했습니다.',
          riskLevel: 'minimal',
          priorityActions: ['보안 헤더를 적용하세요.'],
        },
      },
    }))

    expect(html).toContain('종합 위험 최소')
    expect(html).toContain('결정적 검사에서 개선 항목 1개를 확인했습니다.')
    expect(html).toContain('보안 헤더를 적용하세요.')
    expect(html).toContain('API 키를 입력하지 않아 AI 해석을 요청하지 않았습니다')
    expect(html).toContain('HTTPS 적용 · TLSv1.3 · 인증서 만료')
  })

  it.each([
    ['not_requested', false, 'AI 미요청', 'AI 해석을 요청하지 않았습니다'],
    ['used', true, 'AI 사용', 'AI 설명은 보조 정보입니다'],
    ['failed', false, 'AI 분석 실패', 'API 키·모델·Anthropic 계정 상태'],
    ['busy', false, 'AI 분석 혼잡', '잠시 후 API 키를 다시 입력하고 같은 URL을 점검하세요'],
  ])('AI 상태 %s를 사용자용 안내로 구분한다', (status, used, badge, guidance) => {
    const html = renderToStaticMarkup(createElement(SecurityScanResult, {
      scan: {
        targetOrigin: 'https://school.example',
        targetUrl: 'https://school.example/',
        checkedAt: '2026-08-28T01:00:00.000Z',
        findings: [],
        ai: {
          status,
          used,
          overview: '',
          riskLevel: 'minimal',
          priorityActions: [],
        },
      },
    }))

    expect(html).toContain(badge)
    expect(html).toContain(guidance)
  })

  it('status가 없는 기존 AI 응답은 used boolean으로 판정한다', () => {
    expect(resolveAiStatus({ used: true })).toBe('used')
    expect(resolveAiStatus({ used: false })).toBe('not_requested')
    expect(resolveAiStatus({ status: 'unknown', used: true })).toBe('used')
  })

  it('TLS 값이 없거나 단순 boolean이어도 안전하게 설명한다', () => {
    expect(describeTls(true)).toBe('HTTPS 적용')
    expect(describeTls(false)).toBe('HTTPS 미적용')
    expect(describeTls(null)).toBe('확인 불가')
  })
})
