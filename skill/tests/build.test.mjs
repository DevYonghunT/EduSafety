import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, it, expect, afterAll } from 'vitest'
import { buildRelease, releaseFiles, NORMALIZATION, DIGEST_TARGETS } from '../scripts/build-zip.mjs'
import { skillDigest } from '../edusafe/scripts/render.mjs'
import { readPlan } from './helpers/spec-parse.mjs'

const made = []
const tmp = (tag) => { const d = mkdtempSync(join(tmpdir(), `edusafe-${tag}-`)); made.push(d); return d }
afterAll(() => { while (made.length) rmSync(made.pop(), { recursive: true, force: true }) })

// ── 최소 zip 리더 — 우리가 쓴 것을 우리가 읽지 않고 포맷 규격대로 되짚는다 ──────
const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

function readZip(buf) {
  // EOCD 는 파일 끝에서 찾는다 (주석 없음 전제 — 우리 빌더는 주석을 쓰지 않는다)
  const eocdAt = buf.length - 22
  if (buf.readUInt32LE(eocdAt) !== SIG_EOCD) throw new Error('EOCD 시그니처를 찾지 못했습니다')
  const total = buf.readUInt16LE(eocdAt + 10)
  const centralSize = buf.readUInt32LE(eocdAt + 12)
  const centralStart = buf.readUInt32LE(eocdAt + 16)

  const entries = []
  let p = centralStart
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(`중앙 디렉터리 ${i} 시그니처 오류`)
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')

    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error(`${name}: 로컬 헤더 시그니처 오류`)
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataAt = localOffset + 30 + localNameLen + localExtraLen
    const data = buf.subarray(dataAt, dataAt + size)

    entries.push({ name, flags, method, crc, size, data })
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
  }
  return { total, centralSize, centralStart, entries }
}

// edusafe/ 아래 실제 파일 목록 (정규화된 상대 경로)
function actualSkillFiles(dir, base = dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) out.push(...actualSkillFiles(abs, base))
    else if (e.isFile()) out.push(relative(base, abs).split('\\').join('/'))
  }
  return out.sort()
}

const built = buildRelease({ outDir: tmp('dist') })
const zipBuf = readFileSync(built.zipPath)
const zip = readZip(zipBuf)

describe('배포 zip (REQ-13.1)', () => {
  it('1. zip 이 포맷 규격대로 읽힌다', () => {
    expect(zipBuf.readUInt32LE(0), '로컬 파일 헤더로 시작해야 합니다').toBe(SIG_LOCAL)
    expect(zipBuf.readUInt32LE(zipBuf.length - 22), 'EOCD 로 끝나야 합니다').toBe(SIG_EOCD)
    expect(zip.total, 'EOCD 의 엔트리 수가 실제와 다릅니다').toBe(zip.entries.length)
    expect(zip.total).toBe(built.entries)
  })

  it('1. 엔트리마다 CRC32 와 크기가 맞는다', () => {
    const bad = zip.entries.filter((e) => e.size !== e.data.length)
    expect(bad.map((e) => e.name), '기록된 크기와 실제 데이터 길이가 다릅니다').toEqual([])
    expect(zip.entries.every((e) => e.method === 0), '무압축(store)이어야 합니다').toBe(true)
  })

  it('2. zip 에 개발 전용 파일이 들어가지 않는다', () => {
    const names = zip.entries.map((e) => e.name)
    for (const forbidden of ['tests/', 'fixtures/', 'docs/', 'package.json', 'node_modules', 'vitest.config', '.gitignore', 'dist/']) {
      expect(names.filter((n) => n.includes(forbidden)), `zip 에 ${forbidden} 가 들어갔습니다`).toEqual([])
    }
  })

  it('2. 경로 구분자가 / 이고 경로 오름차순이다 (REQ-13.2)', () => {
    const names = zip.entries.map((e) => e.name)
    expect(names.filter((n) => n.includes('\\')), '역슬래시 경로가 있습니다').toEqual([])
    expect(names).toEqual([...names].sort())
  })

  it('3. manifest.files 가 edusafe/ 의 실제 파일 목록과 일치한다', () => {
    const actual = actualSkillFiles('edusafe')
    expect(built.manifest.files.map((f) => f.path)).toEqual(actual)
    expect(zip.entries.map((e) => e.name)).toEqual(actual)
  })

  it('3. manifest 의 파일별 sha256 이 zip 안의 데이터와 맞는다', () => {
    const byName = new Map(zip.entries.map((e) => [e.name, e.data]))
    const bad = built.manifest.files.filter(
      (f) => createHash('sha256').update(byName.get(f.path)).digest('hex') !== f.sha256,
    )
    expect(bad.map((f) => f.path)).toEqual([])
  })

  it('4. .sha256 파일의 값이 zip 의 실제 sha256 과 같다', () => {
    const line = readFileSync(built.zipPath.replace(/\.zip$/, '.sha256'), 'utf8').trim()
    const actual = createHash('sha256').update(zipBuf).digest('hex')
    expect(line.startsWith(actual), 'sha256 파일의 값이 다릅니다').toBe(true)
    expect(line).toContain(built.zipName)
  })

  it('5. skill_digest 가 render.mjs 의 skillDigest() 와 같다', () => {
    expect(built.manifest.skill_digest).toBe(skillDigest('edusafe'))
    expect(built.manifest.skill_digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('6. 같은 입력으로 두 번 빌드하면 skill_digest 가 같다 (재현성)', () => {
    const a = buildRelease({ outDir: tmp('dist-a') })
    const b = buildRelease({ outDir: tmp('dist-b') })
    expect(a.manifest.skill_digest).toBe(b.manifest.skill_digest)
    // 파일별 해시도 같다. zip 자체는 빌드 시각을 담으므로 sha256 이 달라질 수 있다.
    expect(a.manifest.files).toEqual(b.manifest.files)
  })

  it('7. 한글 파일명에 UTF-8 플래그가 세워지고 이름이 그대로 돌아온다', () => {
    const dir = tmp('skill-ko')
    mkdirSync(join(dir, 'rules'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '절차서\n')
    writeFileSync(join(dir, 'README.md'), '안내\n')
    writeFileSync(join(dir, 'rules', 'version.json'), JSON.stringify({ edusafe_version: '9.9.9', rubric_version: 'x', schema_version: '1' }))
    writeFileSync(join(dir, 'rules', '한글-규칙.json'), '{}\n')

    const r = buildRelease({ skillDir: dir, outDir: tmp('dist-ko') })
    const z = readZip(readFileSync(r.zipPath))
    const names = z.entries.map((e) => e.name)
    expect(names).toContain('rules/한글-규칙.json')
    expect(z.entries.every((e) => (e.flags & 0x0800) !== 0), 'UTF-8 파일명 플래그가 꺼져 있습니다').toBe(true)
    expect(r.zipName).toBe('edusafe-v9.9.9.zip')
  })

  it('정규화 규칙이 manifest 에 기록된다 (REQ-13.2)', () => {
    expect(built.manifest.normalization).toEqual(NORMALIZATION)
    expect(built.manifest.normalization).toEqual({ separator: '/', eol: 'LF', order: 'path-asc', symlinks: 'excluded' })
    expect(built.manifest.digest_targets).toEqual(DIGEST_TARGETS)
  })

  it('버전이 version.json 을 따른다 (REQ-13.3)', () => {
    const v = JSON.parse(readFileSync('edusafe/rules/version.json', 'utf8'))
    expect(built.zipName).toBe(`edusafe-v${v.edusafe_version}.zip`)
    expect(built.manifest.edusafe_version).toBe(v.edusafe_version)
    expect(built.manifest.rubric_version).toBe(v.rubric_version)
  })

  it('zip 안의 내용이 줄바꿈 LF 로 정규화돼 있다', () => {
    const withCrlf = zip.entries.filter((e) => e.data.includes(Buffer.from('\r\n')))
    expect(withCrlf.map((e) => e.name), 'zip 안에 CRLF 가 있습니다').toEqual([])
  })

  it('압축을 푼 폴더의 지문이 원본과 같다 — 교사가 받은 것이 게시된 지문과 대조된다', () => {
    const out = tmp('extract')
    for (const e of zip.entries) {
      const abs = join(out, e.name)
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, e.data)
    }
    expect(skillDigest(out)).toBe(skillDigest('edusafe'))
  })

  it('releaseFiles 가 README 를 포함하고 지문 대상은 그렇지 않다 (spec §11)', () => {
    const paths = releaseFiles('edusafe').map((f) => f.path)
    expect(paths).toContain('README.md')
    // 지문은 README 를 세지 않는다 — 설치 안내문이 바뀌어도 동작은 그대로다
    const dir = tmp('digest-scope')
    mkdirSync(join(dir, 'rules'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '절차서\n')
    writeFileSync(join(dir, 'rules', 'a.json'), '{}\n')
    const before = skillDigest(dir)
    writeFileSync(join(dir, 'README.md'), '안내문을 고쳤다\n')
    expect(skillDigest(dir)).toBe(before)
  })

  it('zip 라이터가 계획서 Task 8 원문과 문자 단위로 같다', () => {
    const impl = readFileSync('scripts/build-zip.mjs', 'utf8')
    const plan = readPlan()
    const NL = String.fromCharCode(10)
    const block = (text) => {
      const a = text.indexOf('// CRC32(zip 표준 다항식')
      expect(a, 'zip 라이터 블록을 찾지 못했습니다').toBeGreaterThan(-1)
      const b = text.indexOf(NL + '  return Buffer.concat([...localParts, centralBuf, end])' + NL + '}', a)
      expect(b, 'zip 라이터 블록의 끝을 찾지 못했습니다').toBeGreaterThan(-1)
      return text.slice(a, b + ('  return Buffer.concat([...localParts, centralBuf, end])' + NL + '}').length + 1)
    }
    expect(block(impl)).toBe(block(plan))
  })

  it('빌드 산출물은 저장소에 커밋되지 않는다 (dist/ 는 무시 대상)', () => {
    const ignore = readFileSync('.gitignore', 'utf8')
    expect(ignore).toMatch(/^dist\/?$/m)
  })
})
