// 배포 zip 빌더 — dist/edusafe-v<버전>.zip · .sha256 · manifest.json 을 만든다.
// 개발 전용이지만 Node 내장 모듈만으로 작성한다 (Global Constraints).
//
//   npm --prefix $REPO run build:zip
//
// manifest 는 신뢰 증거가 아니라 **구성 대조 자료**다 (spec §11 · REQ-13.2).
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { skillDigest, manifestFiles } from '../edusafe/scripts/render.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SKILL_DIR = join(REPO, 'edusafe')
const DIST = join(REPO, 'dist')

// CRC32(zip 표준 다항식 0xEDB88320) — Node 내장 API에는 없어 직접 구현한다.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date) {
  const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff
  const dosDate = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff
  return { dosTime, dosDate }
}

// store(무압축) zip 라이터: 엔트리마다 local file header + 데이터, 끝에 central
// directory + EOCD. 엔트리 이름은 항상 '/' 구분자를 쓰고(호출부에서 이미 정규화됨),
// UTF-8 파일명 플래그(bit 11)를 세운다.
function buildZip(entries) {
  const { dosTime, dosDate } = dosDateTime(new Date())
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const size = data.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4)         // version needed to extract
    local.writeUInt16LE(0x0800, 6)     // general purpose flag: UTF-8 filename
    local.writeUInt16LE(0, 8)          // compression method: store
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18)      // compressed size
    local.writeUInt32LE(size, 22)      // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)         // extra field length
    localParts.push(local, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // central directory header signature
    central.writeUInt16LE(20, 4)         // version made by
    central.writeUInt16LE(20, 6)         // version needed to extract
    central.writeUInt16LE(0x0800, 8)     // general purpose flag
    central.writeUInt16LE(0, 10)         // compression method
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(size, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)         // extra field length
    central.writeUInt16LE(0, 32)         // file comment length
    central.writeUInt16LE(0, 34)         // disk number start
    central.writeUInt16LE(0, 36)         // internal file attributes
    central.writeUInt32LE(0, 38)         // external file attributes
    central.writeUInt32LE(offset, 42)    // offset of local header
    centralParts.push(central, nameBuf)

    offset += local.length + nameBuf.length + data.length
  }

  const centralStart = offset
  const centralBuf = Buffer.concat(centralParts)

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory signature
  end.writeUInt16LE(0, 4)          // disk number
  end.writeUInt16LE(0, 6)          // disk with central directory
  end.writeUInt16LE(entries.length, 8)  // entries on this disk
  end.writeUInt16LE(entries.length, 10) // total entries
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(centralStart, 16)
  end.writeUInt16LE(0, 20)          // comment length

  return Buffer.concat([...localParts, centralBuf, end])
}

// ── 정규화 (REQ-13.2) ────────────────────────────────────────────────────
// 경로 구분자 '/' · 줄바꿈 LF · 경로 오름차순 · symlink 제외.
// 내려받아 푼 파일이 manifest 의 sha256 과 같아야 대조가 성립하므로,
// zip 에 담기 전에 줄바꿈을 LF 로 맞춰 넣는다.
export const NORMALIZATION = { separator: '/', eol: 'LF', order: 'path-asc', symlinks: 'excluded' }

// 지문 대상(spec §11) — README.md 는 zip 에 들어가지만 지문 범위 밖이다.
// 절차·데이터·스크립트·템플릿이 바뀌면 동작이 바뀌지만, 설치 안내문은 그렇지 않다.
export const DIGEST_TARGETS = ['SKILL.md', 'rules', 'scripts', 'templates']

const normalizeText = (text) => text.split('\r\n').join('\n')

// zip 에 넣을 파일 목록. manifestFiles 는 지문 대상만 돌려주므로 README 를 더한다.
export function releaseFiles(skillDir = SKILL_DIR) {
  const files = manifestFiles(skillDir).map((f) => ({ path: f.path, abs: f.abs }))
  const readme = join(skillDir, 'README.md')
  if (existsSync(readme)) files.push({ path: 'README.md', abs: readme })
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function buildRelease({ skillDir = SKILL_DIR, outDir = DIST } = {}) {
  const version = JSON.parse(readFileSync(join(skillDir, 'rules', 'version.json'), 'utf8'))
  const files = releaseFiles(skillDir)

  const entries = files.map((f) => ({
    name: f.path, // 이미 '/' 구분자·오름차순
    data: Buffer.from(normalizeText(readFileSync(f.abs, 'utf8')), 'utf8'),
  }))

  const zip = buildZip(entries)
  const zipName = `edusafe-v${version.edusafe_version}.zip`
  const zipSha = createHash('sha256').update(zip).digest('hex')

  const manifest = {
    edusafe_version: version.edusafe_version,
    rubric_version: version.rubric_version,
    normalization: NORMALIZATION,
    // 지문은 이 목록 전체가 아니라 digest_targets 아래의 파일에서만 계산한다.
    // 보고서의 self_reported_skill_digest 와 같은 값이어야 대조가 성립하기 때문이다.
    digest_targets: DIGEST_TARGETS,
    files: entries.map((e) => ({ path: e.name, sha256: createHash('sha256').update(e.data).digest('hex') })),
    skill_digest: skillDigest(skillDir),
  }

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, zipName), zip)
  writeFileSync(join(outDir, `edusafe-v${version.edusafe_version}.sha256`), `${zipSha}  ${zipName}\n`)
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  return { zipName, zipPath: join(outDir, zipName), zipSha, manifest, entries: entries.length }
}

function main() {
  const r = buildRelease()
  console.log(`${r.zipName} · 파일 ${r.entries}개 · ${r.zipSha.slice(0, 16)}…`)
  console.log(`스킬 지문: ${r.manifest.skill_digest}`)
  console.log(`출력: ${DIST}`)
}

if (process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
