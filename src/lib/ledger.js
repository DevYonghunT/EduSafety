// 심사 기록 대장 — 브라우저 로컬(localStorage) 저장, 같은 대상 재심사는 회차로 연결.
const KEY = 'edusafe_ledger'

const load = (storage) => {
  try {
    return JSON.parse(storage.getItem(KEY)) || []
  } catch {
    return []
  }
}

export function listRecords(storage = localStorage) {
  return load(storage).sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))
}

export function targetKey(repoMeta) {
  return repoMeta.commitSha ? `${repoMeta.owner}/${repoMeta.repo}` : `folder:${repoMeta.name || ''}`
}

export function saveRecord(record, storage = localStorage) {
  const records = load(storage)
  const round = records.filter((r) => r.target === record.target).length + 1
  const entry = { ...record, id: `${Date.now()}-${records.length}`, round }
  storage.setItem(KEY, JSON.stringify([...records, entry]))
  return entry
}

export function deleteRecord(id, storage = localStorage) {
  storage.setItem(KEY, JSON.stringify(load(storage).filter((r) => r.id !== id)))
}

export function exportJson(storage = localStorage) {
  return JSON.stringify({ exportedAt: new Date().toISOString(), records: listRecords(storage) }, null, 2)
}

// ── 서버 대장 동기화 — 관리자 세션이 있는 브라우저에서만 서버 사본을 남긴다 (실패해도 로컬 저장은 유지) ──
function toServerRecord(entry) {
  return {
    target: entry.target,
    ...(entry.commitSha ? { commitSha: entry.commitSha } : {}),
    ...(entry.fingerprint ? { fingerprint: entry.fingerprint } : {}),
    status: entry.status,
    rubricVersion: entry.rubricVersion,
    protectionLevel: entry.protectionLevel,
    profile: entry.profile || '',
    record: entry,
  }
}

export async function syncRecordToServer(entry, fetchImpl = globalThis.fetch) {
  try {
    const session = await fetchImpl('/api/admin/session', { credentials: 'same-origin' })
    if (session.status === 401) return { synced: false, reason: 'login' }
    if (!session.ok) return { synced: false, reason: `session ${session.status}` }
    const { csrfToken } = await session.json()
    const res = await fetchImpl('/api/reviews', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify(toServerRecord(entry)),
    })
    if (res.status === 503) return { synced: false, reason: 'unavailable' }
    if (!res.ok) return { synced: false, reason: `http ${res.status}` }
    const body = await res.json()
    return { synced: true, id: body.record?.id, round: body.record?.round }
  } catch (err) {
    return { synced: false, reason: err?.message || 'network' }
  }
}

export async function fetchServerRecords(fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl('/api/reviews', { credentials: 'same-origin' })
    if (res.status === 401) return { available: false, reason: 'login', records: [] }
    if (!res.ok) return { available: false, reason: `http ${res.status}`, records: [] }
    const body = await res.json()
    return { available: true, records: body.records || [] }
  } catch (err) {
    return { available: false, reason: err?.message || 'network', records: [] }
  }
}
