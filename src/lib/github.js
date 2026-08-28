// GitHub 공개 저장소 로드 — 신뢰성 원칙 5: 브랜치명이 아니라 커밋 SHA에 심사를 고정한다.
// 로드 도중 새 커밋이 푸시되어도 "이 심사는 커밋 X에 대한 것"이 성립해야 한다.
import { isScannablePath, MAX_FILE_SIZE, loadPriority } from './scanner.js'

const MAX_FILES = 800
const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const CONCURRENCY = 8

export function parseGithubUrl(input) {
  const s = String(input).trim().replace(/[?#].*$/, '').replace(/\.git$/, '').replace(/\/+$/, '')
  if (!s) return null
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+))?/i)
  if (m) return { owner: m[1], repo: decodeURIComponent(m[2]), branch: m[3] ? decodeURIComponent(m[3]) : null }
  m = s.match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/)
  if (m) return { owner: m[1], repo: m[2], branch: null }
  return null
}

async function ghJson(url) {
  let res
  try {
    res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } })
  } catch {
    throw new Error('GitHub에 연결하지 못했어요. 네트워크를 확인해 주세요.')
  }
  if (!res.ok) {
    if (res.status === 404) throw new Error('저장소를 찾을 수 없어요. 공개 저장소인지 확인해 주세요.')
    if (res.status === 403 || res.status === 429) throw new Error('GitHub 요청 한도(시간당 60회)를 넘었어요. 잠시 후 다시 시도해 주세요.')
    throw new Error(`GitHub 응답 오류 (${res.status})`)
  }
  return res.json()
}

/**
 * returns { files: [{path, name, text}], branch, commitSha, skippedCount }
 */
export async function fetchRepoFiles({ owner, repo, branch, onProgress }) {
  if (!branch) {
    const info = await ghJson(`https://api.github.com/repos/${owner}/${repo}`)
    branch = info.default_branch
  }
  const branchInfo = await ghJson(`https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`)
  const commitSha = branchInfo.commit?.sha || ''
  // 이후 모든 조회는 SHA 기준 — 여기가 심사 무결성의 실체
  const tree = await ghJson(`https://api.github.com/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`)

  // 초대형 저장소는 GitHub이 트리 목록 자체를 잘라서 반환한다 — 숨기지 말고 고지한다.
  const treeTruncated = Boolean(tree.truncated)
  const blobs = (tree.tree || []).filter((e) => e.type === 'blob')
  const candidates = blobs
    .filter((e) => isScannablePath(e.path) && (e.size ?? 0) <= MAX_FILE_SIZE)
    .sort((a, b) => loadPriority(a.path) - loadPriority(b.path) || a.path.localeCompare(b.path))
  const selected = []
  let total = 0
  for (const e of candidates) {
    if (selected.length >= MAX_FILES || total + (e.size ?? 0) > MAX_TOTAL_BYTES) continue
    selected.push(e)
    total += e.size ?? 0
  }
  const scannableSkipped = candidates.length - selected.length

  const queue = [...selected]
  const files = []
  let done = 0
  const worker = async () => {
    while (queue.length > 0) {
      const e = queue.shift()
      try {
        const res = await fetch(encodeURI(`https://raw.githubusercontent.com/${owner}/${repo}/${commitSha}/${e.path}`))
        if (res.ok) {
          const text = await res.text()
          files.push({ path: e.path, name: e.path.split('/').pop(), text })
        }
      } catch {
        // 개별 파일 실패는 건너뛴다
      }
      done++
      onProgress?.(done, selected.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, worker))

  files.sort((a, b) => a.path.localeCompare(b.path))
  const selectedSet = new Set(selected.map((e) => e.path))
  const skippedPaths = blobs.filter((e) => !selectedSet.has(e.path)).map((e) => e.path)
  return { files, branch, commitSha, skippedCount: skippedPaths.length, skippedPaths, scannableSkipped, treeTruncated }
}
