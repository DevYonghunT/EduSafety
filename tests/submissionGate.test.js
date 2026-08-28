import { describe, it, expect } from 'vitest'
import { checkGate } from '../src/lib/submissionGate.js'

const f = (path, text) => ({ path, name: path.split('/').pop(), text })
const meta = { commitSha: 'abc123def4567890' }

describe('제출 완결성 사전 게이트 (T7)', () => {
  it('진입점·SHA 고정이 있으면 통과', () => {
    const { checks, pass } = checkGate([f('index.html', '<h1>앱</h1>')], meta)
    expect(pass).toBe(true)
    expect(checks).toHaveLength(3)
  })

  it('Firebase를 쓰는데 규칙 파일이 없으면 반려 권고', () => {
    const { checks, pass } = checkGate([f('index.html', 'firebase.initializeApp(cfg)')], meta)
    expect(pass).toBe(false)
    expect(checks.find((c) => c.id === 'db-config').pass).toBe(false)
  })

  it('Firebase + 규칙 파일 동봉이면 통과', () => {
    const { pass } = checkGate([
      f('index.html', 'firebase.initializeApp(cfg)'),
      f('firestore.rules', 'allow write: if request.auth != null;'),
    ], meta)
    expect(pass).toBe(true)
  })

  it('SHA 고정이 없으면 실패', () => {
    const { pass } = checkGate([f('index.html', 'x')], {})
    expect(pass).toBe(false)
  })
})
