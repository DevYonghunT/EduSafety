// 폴더 업로드 — GitHub이 없는 제출물의 두 번째 입력 경로.
// 심사 고정은 커밋 SHA 대신 파일 경로+내용 전체의 SHA-256 콘텐츠 지문으로 한다 (원칙 5).
import { isScannablePath, MAX_FILE_SIZE } from './scanner.js'

const MAX_FILES = 200

export function filterFolderFiles(fileList) {
  const all = [...fileList]
  const usable = []
  let skippedCount = 0
  for (const f of all) {
    const rel = (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name
    if (!isScannablePath(rel) || f.size > MAX_FILE_SIZE || usable.length >= MAX_FILES) {
      skippedCount++
      continue
    }
    usable.push({ file: f, rel })
  }
  return { usable, skippedCount, total: all.length }
}

export async function readFolderFiles(fileList) {
  const { usable, skippedCount } = filterFolderFiles(fileList)
  const files = []
  for (const { file, rel } of usable) {
    files.push({ path: rel, name: rel.split('/').pop(), text: await file.text() })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, skippedCount }
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
