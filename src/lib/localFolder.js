// 폴더 업로드 — GitHub이 없는 제출물의 두 번째 입력 경로.
// 심사 고정은 커밋 SHA 대신 파일 경로+내용 전체의 SHA-256 콘텐츠 지문으로 한다 (원칙 5).
import { isScannablePath, MAX_FILE_SIZE, loadPriority } from './scanner.js'

const MAX_FILES = 600

export function filterFolderFiles(fileList) {
  const all = [...fileList]
  const candidates = []
  const skippedPaths = []
  for (const f of all) {
    const rel = (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name
    if (!isScannablePath(rel) || f.size > MAX_FILE_SIZE) {
      skippedPaths.push(rel)
      continue
    }
    candidates.push({ file: f, rel })
  }
  // 상한에 걸리면 임의 순서가 아니라 보안 설정→코드→문서 순으로 읽는다 — 핵심 소스가 문서에 밀려 빠지지 않게.
  candidates.sort((a, b) => loadPriority(a.rel) - loadPriority(b.rel) || a.rel.localeCompare(b.rel))
  const usable = candidates.slice(0, MAX_FILES)
  const overflow = candidates.slice(MAX_FILES).map((c) => c.rel)
  const allSkipped = [...overflow, ...skippedPaths]
  return { usable, skippedPaths: allSkipped, scannableSkipped: overflow.length, skippedCount: allSkipped.length, total: all.length }
}

export async function readFolderFiles(fileList) {
  const { usable, skippedPaths, skippedCount, scannableSkipped } = filterFolderFiles(fileList)
  const files = []
  for (const { file, rel } of usable) {
    files.push({ path: rel, name: rel.split('/').pop(), text: await file.text() })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, skippedCount, skippedPaths, scannableSkipped }
}

// 경로+내용을 정렬·연결해 지문 계산 — 파일 하나만 바뀌어도 지문이 달라진다.
export async function computeFingerprint(files, subtle = crypto.subtle) {
  const canonical = [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => `${f.path}\n${f.text.length}\n${f.text}\n`)
    .join('')
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
