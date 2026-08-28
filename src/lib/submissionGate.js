// 제출 완결성 사전 게이트 — 판단불가 다발의 주원인(자료 미비)을 심사 시작 전에 차단.
// 미비 시 심사 대신 반려 권고 (심사자 재량으로 계속은 가능).

const usesFirebase = (files) => files.some((f) => /firebase|firestore/i.test(f.text) && /\.(jsx?|tsx?|html)$/.test(f.path))
const usesSupabase = (files) => files.some((f) => /supabase/i.test(f.text) && /\.(jsx?|tsx?|html)$/.test(f.path))

export function checkGate(files, meta = {}) {
  const checks = []

  const hasEntry = files.some((f) => /(^|\/)index\.html$/.test(f.path)) || files.some((f) => /(^|\/)package\.json$/.test(f.path))
  checks.push({
    id: 'entry',
    label: '전체 소스 제출 (진입점 확인)',
    pass: hasEntry,
    detail: hasEntry ? '진입점(index.html 또는 package.json)이 있습니다.' : '진입점이 없습니다 — 전체 소스가 아닌 일부만 제출된 것일 수 있어요.',
  })

  const fb = usesFirebase(files)
  const sb = usesSupabase(files)
  if (fb || sb) {
    const hasRules = files.some((f) => /\.rules$|firestore\.rules|database\.rules/i.test(f.path))
    const hasRls = files.some((f) => /\.sql$/i.test(f.path) && /policy|row level|rls/i.test(f.text))
    const need = [fb && 'Firebase 규칙 파일', sb && 'Supabase RLS SQL'].filter(Boolean).join(' / ')
    const pass = (!fb || hasRules) && (!sb || hasRls)
    checks.push({
      id: 'db-config',
      label: `외부 DB 보안 설정 파일 (${need})`,
      pass,
      detail: pass
        ? 'DB 보안 설정 파일이 저장소에 포함되어 있습니다.'
        : `외부 DB를 쓰는데 ${need}이(가) 저장소에 없습니다. 콘솔에서 내보내 저장소에 포함해야 접근 규칙을 심사할 수 있어요.`,
    })
  } else {
    checks.push({ id: 'db-config', label: '외부 DB 보안 설정 파일', pass: true, detail: '외부 DB 사용 흔적 없음 — 해당 없습니다.' })
  }

  const pinned = Boolean(meta.commitSha || meta.fingerprint)
  checks.push({
    id: 'pinned',
    label: '심사 대상 고정 (커밋 SHA/콘텐츠 지문)',
    pass: pinned,
    detail: pinned ? `심사가 ${meta.commitSha ? '커밋 ' + meta.commitSha.slice(0, 12) : '콘텐츠 지문'}에 고정되었습니다.` : '심사 대상이 고정되지 않았습니다.',
  })

  return { checks, pass: checks.every((c) => c.pass) }
}
