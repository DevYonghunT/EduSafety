// GitHub 공개 저장소 로드 — 신뢰성 원칙 5: 브랜치명이 아니라 커밋 SHA에 심사를 고정한다.
// 로드 도중 새 커밋이 푸시되어도 "이 심사는 커밋 X에 대한 것"이 성립해야 한다.
import { isScannablePath, MAX_FILE_SIZE, loadPriority } from './scanner.js'

const MAX_FILES = 800
const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const CONCURRENCY = 8

export function parseGithubUrl(input) {
  const s = String(input).trim().replace(/[?#].*$/, '').replace(/\.git$/, '').replace(/\/+$/, '')
  if (!s) return null
  // 브랜치명은 슬래시를 포함할 수 있다(feature/new-ui) — 나머지 경로를 통째로 후보로 잡고 로드 시 브랜치 목록에 대조한다.
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/tree\/(.+))?/i)
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
    const err = new Error(
      res.status === 404 ? '저장소를 찾을 수 없어요. 공개 저장소인지 확인해 주세요.'
        : res.status === 403 || res.status === 429 ? 'GitHub 요청 한도(시간당 60회)를 넘었어요. 잠시 후 다시 시도해 주세요.'
          : `GitHub 응답 오류 (${res.status})`,
    )
    err.status = res.status
    throw err
  }
  return res.json()
}

// /tree/ 뒤 경로에서 실제 브랜치를 찾는다 — 'feature/new-ui/src'처럼 하위 경로가 붙어 있어도 가장 긴 접두 브랜치를 택한다.
async function resolveBranch(owner, repo, candidate) {
  const parts = candidate.split('/')
  for (let n = parts.length; n >= 1; n--) {
    const name = parts.slice(0, n).join('/')
    try {
      const info = await ghJson(`https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(name)}`)
      return { branch: name, commitSha: info.commit?.sha || '' }
    } catch (err) {
      if (err.status !== 404) throw err
    }
  }
  throw new Error(`브랜치를 찾을 수 없어요: ${candidate} — 주소의 /tree/ 뒤 이름을 확인해 주세요.`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * returns { files: [{path, name, text}], branch, commitSha, skippedCount, skippedPaths, scannableSkipped, failedPaths, treeTruncated }
 */
export async function fetchRepoFiles({ owner, repo, branch, onProgress }) {
  if (!branch) {
    const info = await ghJson(`https://api.github.com/repos/${owner}/${repo}`)
    branch = info.default_branch
  }
  const resolved = await resolveBranch(owner, repo, branch)
  branch = resolved.branch
  const commitSha = resolved.commitSha
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
  // 내려받기에 실패한 파일은 조용히 빠지지 않는다 — 심사 범위 불완전으로 고지된다 (원칙 8: 조용한 절단 금지).
  const failedPaths = []
  let done = 0
  const download = async (e) => {
    const res = await fetch(encodeURI(`https://raw.githubusercontent.com/${owner}/${repo}/${commitSha}/${e.path}`))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.text()
  }
  const worker = async () => {
    while (queue.length > 0) {
      const e = queue.shift()
      let text = null
      for (let attempt = 0; attempt < 2 && text === null; attempt++) {
        try {
          text = await download(e)
        } catch {
          if (attempt === 0) await sleep(400)
        }
      }
      if (text === null) failedPaths.push(e.path)
      else files.push({ path: e.path, name: e.path.split('/').pop(), text })
      done++
      onProgress?.(done, selected.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, worker))

  files.sort((a, b) => a.path.localeCompare(b.path))
  const loadedSet = new Set(files.map((f) => f.path))
  const skippedPaths = blobs.filter((e) => !loadedSet.has(e.path)).map((e) => e.path)
  return {
    files, branch, commitSha,
    skippedCount: skippedPaths.length, skippedPaths,
    scannableSkipped: scannableSkipped + failedPaths.length, failedPaths, treeTruncated,
  }
}
