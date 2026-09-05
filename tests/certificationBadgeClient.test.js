import { describe, expect, it, vi } from 'vitest'
import {
  CertificationBadgeApiError,
  issueCertificationBadge,
  settleCertificationRequest,
} from '../src/lib/certificationBadge.js'

const COMMIT_SHA = '3ed41cb2c8329d5d47e276c3018a0c6c9f6a0878'
const UID = `0x${'a'.repeat(64)}`

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: vi.fn().mockResolvedValue(body) }
}

describe('인증마크 발급 클라이언트', () => {
  it('저장소 URL과 exact commit SHA만 서버에 보낸다', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      outcome: 'ISSUED',
      badge: {
        uid: UID,
        commitSha: COMMIT_SHA,
        status: 'VALID',
        repository: { canonicalRepositoryUrl: 'https://github.com/owner/repository' },
        policy: { name: '교사 앱 안전 기준', policyVersion: 1 },
      },
      verificationUrl: `https://edusafety.example/verify/${UID}`,
      svgUrl: `https://edusafety.example/api/badges/${UID}.svg?variant=showcase`,
    }, { status: 201 }))

    await issueCertificationBadge({
      repositoryUrl: 'https://github.com/owner/repository',
      commitSha: COMMIT_SHA,
      fetchImpl,
      apiUrl: '/api/badges/issue',
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/badges/issue')
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body)).toEqual({
      repositoryUrl: 'https://github.com/owner/repository',
      commitSha: COMMIT_SHA,
    })
    expect(Object.keys(JSON.parse(options.body))).toEqual(['repositoryUrl', 'commitSha'])
  })

  it('기대 저장소 주소가 GitHub 형식이 아니면 양쪽이 모두 해석 불가여도 발급 결과를 받아들이지 않는다', async () => {
    const request = issueCertificationBadge({
      repositoryUrl: 'https://github.com/owner%2Frepository',
      commitSha: COMMIT_SHA,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({
        outcome: 'ISSUED',
        badge: {
          uid: UID, commitSha: COMMIT_SHA, status: 'VALID',
          repository: { canonicalRepositoryUrl: 'https://evil.example/anything' },
          policy: { name: '교사 앱 안전 기준', policyVersion: 1 },
        },
        verificationUrl: `https://edusafety.example/verify/${UID}`,
        svgUrl: `https://edusafety.example/api/badges/${UID}.svg?variant=showcase`,
      }, { status: 201 })),
    })
    await expect(request).rejects.toMatchObject({ code: 'INVALID_CERTIFICATION_RESPONSE' })
  })

  it('미발급 결과를 오류로 바꾸지 않고 그대로 전달한다', async () => {
    const response = { outcome: 'NOT_ISSUED', criteria: [], safetyBlockers: [] }
    const result = await issueCertificationBadge({
      repositoryUrl: 'https://github.com/owner/repository',
      commitSha: COMMIT_SHA,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(response)),
    })

    expect(result).toEqual(response)
  })

  it('서버 오류의 안전한 code와 메시지를 보존한다', async () => {
    const request = issueCertificationBadge({
      repositoryUrl: 'https://github.com/owner/repository',
      commitSha: COMMIT_SHA,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({
        error: { code: 'NO_ACTIVE_POLICY', message: '활성 정책이 없습니다.' },
      }, { ok: false, status: 409 })),
    })

    await expect(request).rejects.toMatchObject({
      name: 'CertificationBadgeApiError',
      code: 'NO_ACTIVE_POLICY',
      message: '활성 정책이 없습니다.',
      status: 409,
    })
    await expect(request).rejects.toBeInstanceOf(CertificationBadgeApiError)
  })

  it('필수 발급 링크가 없는 성공 응답을 거절한다', async () => {
    await expect(issueCertificationBadge({
      repositoryUrl: 'https://github.com/owner/repository',
      commitSha: COMMIT_SHA,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({
        outcome: 'ISSUED',
        badge: { uid: `0x${'a'.repeat(64)}` },
      })),
    })).rejects.toMatchObject({ code: 'INVALID_CERTIFICATION_RESPONSE' })
  })

  it('UID와 연결되지 않은 검증 링크나 SVG 링크를 거절한다', async () => {
    await expect(issueCertificationBadge({
      repositoryUrl: 'https://github.com/owner/repository',
      commitSha: COMMIT_SHA,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({
        outcome: 'ISSUED',
        badge: {
          uid: UID,
          commitSha: COMMIT_SHA,
          status: 'VALID',
          repository: { canonicalRepositoryUrl: 'https://github.com/owner/repository' },
          policy: { name: '교사 앱 안전 기준', policyVersion: 1 },
        },
        verificationUrl: 'https://edusafety.example/verify/different-uid',
        svgUrl: `https://edusafety.example/api/badges/${UID}.svg?variant=showcase`,
      })),
    })).rejects.toMatchObject({ code: 'INVALID_CERTIFICATION_RESPONSE' })
  })

  it('요청과 다른 저장소 또는 commit의 발급 응답을 거절한다', async () => {
    await expect(issueCertificationBadge({
      repositoryUrl: 'https://github.com/owner/repository',
      commitSha: COMMIT_SHA,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({
        outcome: 'ISSUED',
        badge: {
          uid: `0x${'a'.repeat(64)}`,
          commitSha: 'f'.repeat(40),
          status: 'VALID',
          repository: { canonicalRepositoryUrl: 'https://github.com/other/repository' },
          policy: { name: '교사 앱 안전 기준', policyVersion: 1 },
        },
        verificationUrl: 'https://edusafety.example/verify/uid',
        svgUrl: 'https://edusafety.example/api/badges/uid.svg?variant=showcase',
      })),
    })).rejects.toMatchObject({ code: 'INVALID_CERTIFICATION_RESPONSE' })
  })

  it('새 심사가 시작된 뒤 도착한 이전 요청 결과를 폐기한다', () => {
    const staleRequest = { subjectKey: 'repo-a', requestId: 'request-1' }
    const current = { phase: 'idle', subjectKey: 'repo-b' }

    expect(settleCertificationRequest(current, staleRequest, { phase: 'issued' })).toBe(current)
    expect(settleCertificationRequest(
      { phase: 'loading', ...staleRequest },
      staleRequest,
      { phase: 'issued', response: { outcome: 'ISSUED' } },
    )).toEqual({ phase: 'issued', subjectKey: 'repo-a', response: { outcome: 'ISSUED' } })
  })
})
