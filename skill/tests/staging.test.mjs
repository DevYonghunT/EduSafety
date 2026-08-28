import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, it, expect, afterEach } from 'vitest'
import { swapStaging, cleanStaging, skillDigest, REPORT_FILES, historyStamp } from '../edusafe/scripts/render.mjs'
import { validReport } from './helpers/valid-report.mjs'

const made = []
function makeReportDir() {
  const root = mkdtempSync(join(tmpdir(), 'edusafe-staging-'))
  made.push(root)
  const reportDir = join(root, 'edusafe-report')
  mkdirSync(reportDir, { recursive: true })
  return reportDir
}

function makeStaging(reportDir, tag = 'a1b2', body = {}) {
  const staging = join(reportDir, `.staging-${tag}`)
  mkdirSync(staging, { recursive: true })
  for (const name of REPORT_FILES) {
    writeFileSync(join(staging, name), body[name] !== undefined ? body[name] : `${name} 내용 ${tag}\n`)
  }
  return staging
}

const topFiles = (reportDir) => readdirSync(reportDir).filter((n) => REPORT_FILES.includes(n)).sort()
const historyDirs = (reportDir) => {
  const h = join(reportDir, 'history')
  return existsSync(h) ? readdirSync(h).sort() : []
}

afterEach(() => {
  while (made.length) rmSync(made.pop(), { recursive: true, force: true })
})

describe('staging 세트 교체 (REQ-8.4 ~ REQ-8.9)', () => {
  it('1. 정상 교체 후 최상위에 4파일이 있고 staging 이 사라진다', () => {
    const reportDir = makeReportDir()
    const staging = makeStaging(reportDir)
    swapStaging(reportDir, staging)
    expect(topFiles(reportDir)).toEqual([...REPORT_FILES].sort())
    expect(existsSync(staging)).toBe(false)
    expect(historyDirs(reportDir)).toEqual([]) // 직전 결과가 없었으므로 history 도 없다
  })

  it('1. 직전 결과가 있으면 history 에 1개 생긴다', () => {
    const reportDir = makeReportDir()
    swapStaging(reportDir, makeStaging(reportDir, 'one'))
    swapStaging(reportDir, makeStaging(reportDir, 'two'))
    expect(historyDirs(reportDir)).toHaveLength(1)
    const archived = join(reportDir, 'history', historyDirs(reportDir)[0])
    expect(readdirSync(archived).sort()).toEqual([...REPORT_FILES].sort())
  })

  it('2. 새 정본이 history 로 밀려나지 않는다', () => {
    const reportDir = makeReportDir()
    swapStaging(reportDir, makeStaging(reportDir, 'one'))
    swapStaging(reportDir, makeStaging(reportDir, 'two'))
    // 최상위는 두 번째 실행의 것이어야 한다
    expect(readFileSync(join(reportDir, 'edusafe-report.json'), 'utf8')).toContain('two')
    const archived = join(reportDir, 'history', historyDirs(reportDir)[0])
    expect(readFileSync(join(archived, 'edusafe-report.json'), 'utf8')).toContain('one')
  })

  it('3. staging 에 4파일이 다 없으면 최상위를 손대지 않는다', () => {
    const reportDir = makeReportDir()
    swapStaging(reportDir, makeStaging(reportDir, 'one'))
    const staging = makeStaging(reportDir, 'bad')
    rmSync(join(staging, 'edusafe-report.md'))
    expect(() => swapStaging(reportDir, staging)).toThrow(/edusafe-report.md/)
    expect(readFileSync(join(reportDir, 'edusafe-report.json'), 'utf8')).toContain('one')
    expect(existsSync(staging)).toBe(true)
    expect(historyDirs(reportDir)).toEqual([])
  })

  it('3. staging 의 파일이 비어 있으면 거부한다', () => {
    const reportDir = makeReportDir()
    const staging = makeStaging(reportDir, 'empty', { 'scan.json': '' })
    expect(() => swapStaging(reportDir, staging)).toThrow(/비어 있습니다/)
    expect(topFiles(reportDir)).toEqual([])
  })

  it('4. 이동 중 실패하면 되돌아가고 빈 history 디렉터리가 남지 않는다', () => {
    const reportDir = makeReportDir()
    swapStaging(reportDir, makeStaging(reportDir, 'one'))
    const before = REPORT_FILES.map((n) => readFileSync(join(reportDir, n), 'utf8'))

    const staging = makeStaging(reportDir, 'two')
    // 보관은 성공시키고, staging → 최상위 이동의 두 번째에서 실패시킨다
    let calls = 0
    const rename = (from, to) => {
      calls += 1
      if (calls === REPORT_FILES.length + 2) throw new Error('주입한 이동 실패')
      return renameSync(from, to)
    }
    expect(() => swapStaging(reportDir, staging, { rename })).toThrow(/주입한 이동 실패/)

    // 최상위는 직전 결과 그대로여야 한다
    expect(REPORT_FILES.map((n) => readFileSync(join(reportDir, n), 'utf8'))).toEqual(before)
    // 비어 버린 history 디렉터리를 남기지 않는다 (REQ-8.9)
    expect(historyDirs(reportDir)).toEqual([])
    // staging 은 남는다 (REQ-8.7)
    expect(existsSync(staging)).toBe(true)
  })

  it('5. history 가 5개를 넘으면 오래된 것부터 지워 5개를 유지한다', () => {
    const reportDir = makeReportDir()
    for (let i = 0; i < 7; i++) {
      // 스탬프가 겹치지 않도록 시각을 직접 넘긴다
      swapStaging(reportDir, makeStaging(reportDir, `run${i}`), { now: new Date(2026, 0, 1, 0, 0, i) })
    }
    const dirs = historyDirs(reportDir)
    expect(dirs).toHaveLength(5)
    // 가장 오래된 두 개(run0·run1 을 보관한 것)가 지워졌다
    const kept = dirs.map((d) => readFileSync(join(reportDir, 'history', d, 'edusafe-report.json'), 'utf8'))
    expect(kept.some((c) => c.includes('run0'))).toBe(false)
    expect(kept.some((c) => c.includes('run5'))).toBe(true)
    expect(readFileSync(join(reportDir, 'edusafe-report.json'), 'utf8')).toContain('run6')
  })

  it('6. cleanStaging 이 남은 .staging-* 을 정리한다 (REQ-5.6)', () => {
    const reportDir = makeReportDir()
    makeStaging(reportDir, 'left1')
    makeStaging(reportDir, 'left2')
    mkdirSync(join(reportDir, 'history'), { recursive: true })
    writeFileSync(join(reportDir, 'edusafe-report.json'), '지켜져야 함')

    const removed = cleanStaging(reportDir).sort()
    expect(removed).toEqual(['.staging-left1', '.staging-left2'])
    expect(readdirSync(reportDir).filter((n) => n.startsWith('.staging-'))).toEqual([])
    expect(existsSync(join(reportDir, 'history'))).toBe(true)
    expect(readFileSync(join(reportDir, 'edusafe-report.json'), 'utf8')).toBe('지켜져야 함')
  })

  it('historyStamp 가 정렬 가능한 형식이다', () => {
    const a = historyStamp(new Date(2026, 0, 2, 3, 4, 5))
    expect(a).toMatch(/^20260102-030405-[0-9a-f]{4}$/)
    const b = historyStamp(new Date(2026, 0, 2, 3, 4, 6))
    expect(a < b).toBe(true)
  })
})

describe('render.mjs CLI', () => {
  const runCli = (staging) => {
    try {
      execFileSync(process.execPath, ['edusafe/scripts/render.mjs', staging], { stdio: 'pipe' })
      return { code: 0, err: '' }
    } catch (e) {
      return { code: e.status, err: String(e.stderr) }
    }
  }

  it('계약을 통과한 보고서는 4파일을 최상위에 남긴다', () => {
    const reportDir = makeReportDir()
    const staging = join(reportDir, '.staging-cli')
    mkdirSync(staging, { recursive: true })
    writeFileSync(join(staging, 'edusafe-report.json'), JSON.stringify(validReport()))
    writeFileSync(join(staging, 'scan.json'), JSON.stringify({ hits: [] }))

    const { code, err } = runCli(staging)
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(topFiles(reportDir)).toEqual([...REPORT_FILES].sort())
    expect(existsSync(staging)).toBe(false)
    const html = readFileSync(join(reportDir, 'edusafe-report.html'), 'utf8')
    expect(html).toContain('에듀세이프 자가점검 보고서')
  })

  it('계약 검증에 실패하면 최상위를 손대지 않고 staging 을 남긴다 (REQ-8.7)', () => {
    const reportDir = makeReportDir()
    const staging = join(reportDir, '.staging-bad')
    mkdirSync(staging, { recursive: true })
    const broken = validReport()
    broken.items[0].verdict = '__invalid__'
    writeFileSync(join(staging, 'edusafe-report.json'), JSON.stringify(broken))
    writeFileSync(join(staging, 'scan.json'), JSON.stringify({ hits: [] }))

    const { code, err } = runCli(staging)
    expect(code).toBe(1)
    expect(err).toMatch(/계약을 통과하지 못했습니다/)
    expect(topFiles(reportDir)).toEqual([])
    expect(existsSync(staging)).toBe(true)
    expect(existsSync(join(staging, 'edusafe-report.html'))).toBe(false)
  })

  it('documentation_hits 가 scan.json 과 어긋나면 거부한다', () => {
    const reportDir = makeReportDir()
    const staging = join(reportDir, '.staging-doc')
    mkdirSync(staging, { recursive: true })
    const r = validReport()
    r.summary.documentation_hits = 5
    writeFileSync(join(staging, 'edusafe-report.json'), JSON.stringify(r))
    writeFileSync(join(staging, 'scan.json'), JSON.stringify({ hits: [{ rule: 'eval-usage', documentation: true }] }))

    const { code, err } = runCli(staging)
    expect(code).toBe(1)
    expect(err).toMatch(/documentation_hits/)
  })
})

describe('스킬 지문 (REQ-11.1 · REQ-13.2)', () => {
  it('sha256: 형식이고 같은 입력에 같은 값을 낸다', () => {
    const a = skillDigest('edusafe')
    const b = skillDigest('edusafe')
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(a).toBe(b)
  })

  it('파일이 하나만 바뀌어도 지문이 바뀐다', () => {
    const root = mkdtempSync(join(tmpdir(), 'edusafe-digest-'))
    made.push(root)
    mkdirSync(join(root, 'rules'), { recursive: true })
    writeFileSync(join(root, 'SKILL.md'), '절차서\n')
    writeFileSync(join(root, 'rules', 'a.json'), '{"a":1}\n')
    const before = skillDigest(root)
    writeFileSync(join(root, 'rules', 'a.json'), '{"a":2}\n')
    expect(skillDigest(root)).not.toBe(before)
  })

  it('줄바꿈만 CRLF 로 달라진 파일은 같은 지문을 낸다 (LF 정규화)', () => {
    const mk = (eol) => {
      const root = mkdtempSync(join(tmpdir(), 'edusafe-digest-'))
      made.push(root)
      mkdirSync(join(root, 'rules'), { recursive: true })
      writeFileSync(join(root, 'SKILL.md'), ['a', 'b', ''].join(eol))
      writeFileSync(join(root, 'rules', 'a.json'), ['{', '}', ''].join(eol))
      return skillDigest(root)
    }
    expect(mk('\r\n')).toBe(mk('\n'))
  })

  it('대상 폴더 밖의 파일은 지문에 들어가지 않는다', () => {
    const root = mkdtempSync(join(tmpdir(), 'edusafe-digest-'))
    made.push(root)
    mkdirSync(join(root, 'rules'), { recursive: true })
    writeFileSync(join(root, 'SKILL.md'), '절차서\n')
    writeFileSync(join(root, 'rules', 'a.json'), '{}\n')
    const before = skillDigest(root)
    writeFileSync(join(root, 'README.md'), '설치 안내\n')       // 대상 아님
    mkdirSync(join(root, 'tests'), { recursive: true })
    writeFileSync(join(root, 'tests', 't.mjs'), 'test\n')        // 대상 아님
    expect(skillDigest(root)).toBe(before)
  })
})
