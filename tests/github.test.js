import { describe, it, expect } from 'vitest'
import { parseGithubUrl } from '../src/lib/github.js'

describe('GitHub 주소 파싱 (T5)', () => {
  it('전체 주소·브랜치·축약형을 파싱한다', () => {
    expect(parseGithubUrl('https://github.com/user/repo')).toEqual({ owner: 'user', repo: 'repo', branch: null })
    expect(parseGithubUrl('https://github.com/user/repo/tree/dev')).toEqual({ owner: 'user', repo: 'repo', branch: 'dev' })
    expect(parseGithubUrl('user/repo.git')).toEqual({ owner: 'user', repo: 'repo', branch: null })
  })

  it('슬래시가 든 브랜치명은 자르지 않는다 (로드 시 브랜치 목록에 대조)', () => {
    expect(parseGithubUrl('https://github.com/user/repo/tree/feature/new-ui').branch).toBe('feature/new-ui')
    expect(parseGithubUrl('https://github.com/user/repo/tree/release/v1.2/').branch).toBe('release/v1.2')
  })

  it('이상한 입력은 null', () => {
    expect(parseGithubUrl('')).toBeNull()
    expect(parseGithubUrl('https://example.com/x')).toBeNull()
  })
})
