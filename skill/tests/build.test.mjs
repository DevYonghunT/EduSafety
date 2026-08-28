import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { crc32 as zlibCrc32 } from 'node:zlib'
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

    // 로컬 헤더의 값도 따로 읽어 둔다. 중앙 디렉터리만 믿으면, 로컬 헤더가 틀린 zip 을
    // 우리 리더는 통과시키고 다른 unzip 도구는 거부하는 상황을 못 잡는다.
    const local = {
      flags: buf.readUInt16LE(localOffset + 6),
      method: buf.readUInt16LE(localOffset + 8),
      crc: buf.readUInt32LE(localOffset + 14),
      compressedSize: buf.readUInt32LE(localOffset + 18),
      size: buf.readUInt32LE(localOffset + 22),
      name: buf.subarray(localOffset + 30, localOffset + 30 + localNameLen).toString('utf8'),
    }

    entries.push({ name, flags, method, crc, size, data, local })
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
  }
  return { total, centralSize, centralStart, centralEnd: p, eocdAt, entries }
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

    // CRC 는 zlib 의 독립 구현으로 검증한다. 우리 crc32() 를 불러 대조하면
    // 라이터가 틀렸을 때 테스트도 같이 틀려 아무것도 잡지 못한다.
    const wrongCrc = zip.entries.filter((e) => (zlibCrc32(e.data) >>> 0) !== e.crc)
    expect(wrongCrc.map((e) => e.name), 'CRC32 가 실제 데이터와 다릅니다').toEqual([])
  })

  it('1. 로컬 헤더와 중앙 디렉터리가 서로 맞고 중앙 디렉터리가 EOCD 에서 끝난다', () => {
    const mismatched = zip.entries.filter(
      (e) =>
        e.local.name !== e.name ||
        e.local.crc !== e.crc ||
        e.local.size !== e.size ||
        e.local.compressedSize !== e.size ||
        e.local.method !== e.method ||
        e.local.flags !== e.flags,
    )
    expect(mismatched.map((e) => e.name), '로컬 헤더가 중앙 디렉터리와 다릅니다').toEqual([])

    expect(zip.centralEnd, '중앙 디렉터리가 EOCD 에서 정확히 끝나지 않습니다').toBe(zip.eocdAt)
    expect(zip.centralSize, 'EOCD 의 중앙 디렉터리 크기가 실제와 다릅니다').toBe(zip.eocdAt - zip.centralStart)
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

  it('outDir 가 스킬 폴더를 삼키면 지우기 전에 거부한다', () => {
    const dir = tmp('guard')
    mkdirSync(join(dir, 'rules'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '절차서\n')
    writeFileSync(join(dir, 'rules', 'version.json'), JSON.stringify({ edusafe_version: '9.9.9', rubric_version: 'x' }))

    // outDir === skillDir, 그리고 outDir 가 skillDir 의 조상인 경우 둘 다
    expect(() => buildRelease({ skillDir: dir, outDir: dir })).toThrow(/배포 대상이 사라집니다/)
    expect(() => buildRelease({ skillDir: dir, outDir: join(dir, '..') })).toThrow(/배포 대상이 사라집니다/)

    // 막았으니 스킬 폴더가 그대로 있어야 한다
    expect(readdirSync(dir).sort()).toEqual(['SKILL.md', 'rules'])
  })

  it('바이너리 파일이 바이트 그대로 zip 에 들어간다', () => {
    const dir = tmp('binary')
    mkdirSync(join(dir, 'templates'), { recursive: true })
    mkdirSync(join(dir, 'rules'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '절차서\n')
    writeFileSync(join(dir, 'rules', 'version.json'), JSON.stringify({ edusafe_version: '9.9.9', rubric_version: 'x' }))
    // PNG 시그니처는 0x0D 0x0A 를 품고 있다 — utf8 로 왕복시키면 손상된다
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8, 0x00, 0x80])
    writeFileSync(join(dir, 'templates', 'logo.png'), png)

    const r = buildRelease({ skillDir: dir, outDir: tmp('dist-bin') })
    const z = readZip(readFileSync(r.zipPath))
    const entry = z.entries.find((e) => e.name === 'templates/logo.png')
    expect(entry, 'zip 에 바이너리가 들어가지 않았습니다').toBeTruthy()
    expect(Buffer.compare(entry.data, png), '바이너리 바이트가 바뀌었습니다').toBe(0)
  })

  it('텍스트의 CRLF 는 LF 로 바뀌고 그 결과가 manifest 해시와 맞는다', () => {
    const dir = tmp('crlf')
    mkdirSync(join(dir, 'rules'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '한 줄\r\n두 줄\r\n')
    writeFileSync(join(dir, 'rules', 'version.json'), JSON.stringify({ edusafe_version: '9.9.9', rubric_version: 'x' }))

    const r = buildRelease({ skillDir: dir, outDir: tmp('dist-crlf') })
    const z = readZip(readFileSync(r.zipPath))
    const entry = z.entries.find((e) => e.name === 'SKILL.md')
    expect(entry.data.toString('utf8')).toBe('한 줄\n두 줄\n')
    // 교사가 내려받아 푼 파일이 manifest 의 해시와 맞아야 대조가 성립한다
    const listed = r.manifest.files.find((f) => f.path === 'SKILL.md')
    expect(createHash('sha256').update(entry.data).digest('hex')).toBe(listed.sha256)
  })

  it('빌드 산출물은 저장소에 커밋되지 않는다 (dist/ 는 무시 대상)', () => {
    const ignore = readFileSync('.gitignore', 'utf8')
    expect(ignore).toMatch(/^dist\/?$/m)
  })
})
