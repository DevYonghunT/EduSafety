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

  it('지문은 기기 간 재현된다 — 한글 경로의 NFD/NFC 차이·로케일 정렬에 흔들리지 않는다', async () => {
    const nfd = [f('학생앱.js'.normalize('NFD'), 'x'), f('A.js', 'y'), f('Å.js', 'z'), f('a.js', 'w')]
    const nfc = [f('학생앱.js'.normalize('NFC'), 'x'), f('Å.js', 'z'), f('a.js', 'w'), f('A.js', 'y')]
    expect(await computeFingerprint(nfd)).toBe(await computeFingerprint(nfc))
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
    const { usable, skippedCount, scannableSkipped } = filterFolderFiles(files)
    expect(usable.map((u) => u.rel)).toEqual(['index.html'])
    expect(skippedCount).toBe(2)
    expect(scannableSkipped).toBe(0)
  })

  it('수집 상한에 걸리면 보안 설정·코드를 먼저 읽고, 밀린 검사 가능 파일 수를 보고한다', () => {
    const files = []
    for (let i = 0; i < 11; i++) {
      files.push({ name: `f${i}.js`, size: 10, webkitRelativePath: `앱/src/f${String(i).padStart(2, '0')}.js` })
    }
    files.push({ name: 'firestore.rules', size: 10, webkitRelativePath: '앱/zz/firestore.rules' })
    files.push({ name: 'README.md', size: 10, webkitRelativePath: '앱/README.md' })
    const { usable, scannableSkipped, skippedPaths } = filterFolderFiles(files, 10)
    expect(usable).toHaveLength(10)
    expect(usable[0].rel).toBe('zz/firestore.rules')
    expect(scannableSkipped).toBe(3)
    expect(skippedPaths).toContain('README.md')
  })

  it('파일 수가 적어도 총 용량 예산을 넘으면 후순위부터 밀린다', () => {
    const files = [
      { name: 'a.js', size: 500, webkitRelativePath: '앱/src/a.js' },
      { name: 'b.js', size: 500, webkitRelativePath: '앱/src/b.js' },
      { name: 'c.md', size: 500, webkitRelativePath: '앱/docs/c.md' },
    ]
    const { usable, scannableSkipped } = filterFolderFiles(files, 100, 1000)
    expect(usable.map((u) => u.rel)).toEqual(['src/a.js', 'src/b.js'])
    expect(scannableSkipped).toBe(1)
  })
})
