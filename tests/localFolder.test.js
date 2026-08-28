import { describe, it, expect } from 'vitest'
import { computeFingerprint, filterFolderFiles } from '../src/lib/localFolder.js'

const f = (path, text) => ({ path, name: path.split('/').pop(), text })

describe('폴더 업로드 — SHA-256 콘텐츠 지문 (여유)', () => {
  it('같은 내용이면 순서가 달라도 같은 지문, 한 글자 바뀌면 다른 지문', async () => {
    const a = [f('index.html', '<h1>앱</h1>'), f('app.js', 'let x = 1')]
    const b = [f('app.js', 'let x = 1'), f('index.html', '<h1>앱</h1>')]
    const c = [f('app.js', 'let x = 2'), f('index.html', '<h1>앱</h1>')]
    const [ha, hb, hc] = await Promise.all([computeFingerprint(a), computeFingerprint(b), computeFingerprint(c)])
    expect(ha).toBe(hb)
    expect(ha).not.toBe(hc)
    expect(ha).toMatch(/^[0-9a-f]{64}$/)
  })

  it('경로/내용 경계가 지문에 반영된다 (인젝션 모호성 없음)', async () => {
    const one = [f('a', 'b\nc')]
    const two = [f('a', 'b'), f('c', '')]
    expect(await computeFingerprint(one)).not.toBe(await computeFingerprint(two))
  })

  it('폴더 최상위 이름은 경로에서 제거하고 스캔 불가 파일은 건너뛴다', () => {
    const files = [
      { name: 'index.html', size: 10, webkitRelativePath: '내앱/index.html' },
      { name: 'logo.png', size: 10, webkitRelativePath: '내앱/img/logo.png' },
      { name: 'x.js', size: 10, webkitRelativePath: '내앱/node_modules/x.js' },
    ]
    const { usable, skippedCount } = filterFolderFiles(files)
    expect(usable.map((u) => u.rel)).toEqual(['index.html'])
    expect(skippedCount).toBe(2)
  })
})
