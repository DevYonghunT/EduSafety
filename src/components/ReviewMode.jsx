import { useState } from 'react'
import { parseGithubUrl, fetchRepoFiles } from '../lib/github.js'
import { scanFiles, countBySeverity } from '../lib/scanner.js'
import { SEVERITIES } from '../data/securityRules.js'

export default function ReviewMode() {
  const [repoUrl, setRepoUrl] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [repoMeta, setRepoMeta] = useState(null) // { owner, repo, branch, commitSha }
  const [files, setFiles] = useState([])
  const [scan, setScan] = useState(null)

  const loadRepo = async () => {
    const parsed = parseGithubUrl(repoUrl)
    if (!parsed) return setError('주소 형식을 알 수 없어요. 예: https://github.com/아이디/저장소')
    setError('')
    try {
      setBusy('저장소 불러오는 중…')
      const result = await fetchRepoFiles({ ...parsed, onProgress: (d, t) => setBusy(`파일 내려받는 중… ${d}/${t}`) })
      if (result.files.length === 0) throw new Error('검사할 수 있는 파일이 없어요.')
      setRepoMeta({ owner: parsed.owner, repo: parsed.repo, branch: result.branch, commitSha: result.commitSha })
      setFiles(result.files)
      setScan(scanFiles(result.files))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="panel">
      <h1>⚖️ 앱 심사</h1>
      <p className="intro">
        AI가 코드에서 증거를 수집해 판정 초안을 만들고, 최종 판정은 심사자가 합니다.
        심사는 커밋 SHA에 고정됩니다 — "이 심사는 커밋 X에 대한 것".
      </p>

      {error && <div className="error">⚠️ {error}</div>}
      {busy && <div className="busy">{busy}</div>}

      {!repoMeta && (
        <form className="setup" onSubmit={(e) => { e.preventDefault(); if (!busy && repoUrl.trim()) loadRepo() }}>
          <label className="field">심사 대상 GitHub 공개 저장소
            <input type="text" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/아이디/저장소" disabled={!!busy} />
          </label>
          <button type="submit" className="btn-primary" disabled={!!busy || !repoUrl.trim()}>
            ① 불러오기 + 규칙 스캔
          </button>
          <p className="hint">이 단계는 API 키 없이 실행됩니다. 심사자 API 키는 다음 단계(AI 분석)부터 사용됩니다.</p>
        </form>
      )}

      {repoMeta && scan && (
        <div className="loaded">
          <div className="repo-line">
            📦 {repoMeta.owner}/{repoMeta.repo} ({repoMeta.branch}) · 커밋 <code>{repoMeta.commitSha.slice(0, 12)}</code> · 파일 {files.length}개
          </div>
          <div className="scan-box">
            <strong>자동 규칙 스캔</strong>
            {scan.findings.length === 0 ? (
              <p className="intro">등록된 패턴에서 발견된 문제 없음</p>
            ) : (
              <ul className="scan-list">
                {scan.findings.map((f) => (
                  <li key={f.rule.id}>
                    <span className="sev" style={{ background: SEVERITIES[f.rule.severity].color }}>
                      {SEVERITIES[f.rule.severity].label}
                    </span>{' '}
                    {f.rule.title} ({f.occurrences.length}곳)
                  </li>
                ))}
              </ul>
            )}
            <p className="hint">
              심각 {countBySeverity(scan.findings).critical} · 경고 {countBySeverity(scan.findings).warning} ·
              확인 필요 {countBySeverity(scan.findings).info}
            </p>
          </div>
          <button className="btn-secondary" onClick={() => { setRepoMeta(null); setFiles([]); setScan(null); setRepoUrl('') }}>
            새 심사 시작
          </button>
        </div>
      )}
    </section>
  )
}
