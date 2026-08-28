import { describe, it, expect } from 'vitest'
import { parseGithubUrl } from '../src/lib/github.js'

describe('GitHub 주소 파싱 (T5)', () => {
  it('전체 주소·브랜치·축약형을 파싱한다', () => {
    expect(parseGithubUrl('https://github.com/user/repo')).toEqual({ owner: 'user', repo: 'repo', branch: null })
    expect(parseGithubUrl('https://github.com/user/repo/tree/dev')).toEqual({ owner: 'user', repo: 'repo', branch: 'dev' })
    expect(parseGithubUrl('user/repo.git')).toEqual({ owner: 'user', repo: 'repo', branch: null })
  })

  it('이상한 입력은 null', () => {
    expect(parseGithubUrl('')).toBeNull()
    expect(parseGithubUrl('https://example.com/x')).toBeNull()
  })
})
