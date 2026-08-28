export const CERTIFICATION_BADGE_API_URL = import.meta.env.VITE_CERTIFICATION_BADGE_API_URL || '/api/badges/issue'
const CERTIFICATION_STATUSES = new Set(['VALID', 'STALE', 'UNVERIFIED', 'EXPIRED', 'REVOKED', 'INVALID'])

export class CertificationBadgeApiError extends Error {
  constructor(code, message, status, details) {
    super(message)
    this.name = 'CertificationBadgeApiError'
    this.code = code
    this.status = status
    this.details = details
  }
}

export function settleCertificationRequest(current, { subjectKey, requestId }, next) {
  return current?.subjectKey === subjectKey && current?.requestId === requestId
    ? { ...next, subjectKey }
    : current
}

async function readResponseJson(response) {
  try {
    return await response.json()
  } catch {
    throw new CertificationBadgeApiError(
      'INVALID_CERTIFICATION_RESPONSE',
      '인증 서버 응답을 확인하지 못했습니다.',
      response.status,
    )
  }
}

function githubSubject(value) {
  try {
    const url = new URL(value)
    const segments = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || segments.length !== 2) return null
    return `${segments[0].toLowerCase()}/${segments[1].replace(/\.git$/i, '').toLowerCase()}`
  } catch {
    return null
  }
}

function assertIssuedResponse(body, status, expectedSubject) {
  const parseHttpUrl = (value) => {
    if (typeof value !== 'string') return null
    try {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol) ? url : null
    } catch {
      return null
    }
  }
  const verificationUrl = parseHttpUrl(body.verificationUrl)
  const svgUrl = parseHttpUrl(body.svgUrl)
  const uid = body.badge?.uid
  if (
    !body.badge
    || !/^0x[0-9a-f]{64}$/i.test(uid || '')
    || !/^[0-9a-f]{40}$/i.test(body.badge.commitSha || '')
    || !CERTIFICATION_STATUSES.has(body.badge.status)
    || typeof body.badge.policy?.name !== 'string' || body.badge.policy.name.trim() === ''
    || !Number.isInteger(body.badge.policy?.policyVersion) || body.badge.policy.policyVersion < 1
    || githubSubject(body.badge.repository?.canonicalRepositoryUrl) !== githubSubject(expectedSubject.repositoryUrl)
    || body.badge.commitSha.toLowerCase() !== expectedSubject.commitSha.toLowerCase()
    || verificationUrl?.pathname !== `/verify/${uid}`
    || verificationUrl.search !== ''
    || svgUrl?.pathname !== `/api/badges/${uid}.svg`
    || svgUrl.searchParams.get('variant') !== 'showcase'
    || [...svgUrl.searchParams.keys()].some((key) => key !== 'variant')
    || verificationUrl.origin !== svgUrl.origin
  ) {
    throw new CertificationBadgeApiError(
      'INVALID_CERTIFICATION_RESPONSE',
      '인증 서버의 발급 결과 형식이 올바르지 않습니다.',
      status,
    )
  }
}

export async function issueCertificationBadge({
  repositoryUrl,
  commitSha,
  fetchImpl = fetch,
  apiUrl = CERTIFICATION_BADGE_API_URL,
}) {
  const response = await fetchImpl(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repositoryUrl, commitSha }),
  })
  const body = await readResponseJson(response)

  if (!response.ok) {
    throw new CertificationBadgeApiError(
      body?.error?.code || 'CERTIFICATION_REQUEST_FAILED',
      body?.error?.message || '인증마크 발급 요청을 처리하지 못했습니다.',
      response.status,
      body?.error?.details,
    )
  }
  if (body?.outcome === 'ISSUED') {
    assertIssuedResponse(body, response.status, { repositoryUrl, commitSha })
    return body
  }
  if (body?.outcome === 'NOT_ISSUED') return body

  throw new CertificationBadgeApiError(
    'INVALID_CERTIFICATION_RESPONSE',
    '인증 서버가 알 수 없는 발급 결과를 반환했습니다.',
    response.status,
  )
}
