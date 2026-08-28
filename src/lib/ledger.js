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
