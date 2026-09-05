import { useEffect, useMemo, useRef, useState } from 'react'
import { parseGithubUrl, fetchRepoFiles } from '../lib/github.js'
import { scanFiles, countBySeverity, suspectDataFiles, isVendorPath } from '../lib/scanner.js'
import { SEVERITIES } from '../data/securityRules.js'
import { FEATURES, featureProfile, AUTHORITY_LABELS, RUBRIC_VERSION, rubricItems } from '../data/rubric.js'
import { checkGate } from '../lib/submissionGate.js'
import { readFolderFiles, computeFingerprint } from '../lib/localFolder.js'
import { buildAiPayloadChunks } from '../lib/redact.js'
import { suggestFeatures, judgeItems, deriveProtectionLevel, PROTECTION_LEVELS, DEFAULT_MODEL, MODEL_OPTIONS, emptyUsage } from '../lib/reviewAi.js'
import { issueCertificationBadge, settleCertificationRequest } from '../lib/certificationBadge.js'
import { computeSummary, finalVerdict, naNeedsReason } from '../lib/reviewSummary.js'
import { saveRecord, targetKey, syncRecordToServer } from '../lib/ledger.js'
import { buildTeacherNotice } from '../lib/dataNotice.js'
import ReviewReport, { VERDICT_LABELS, verdictColor } from './ReviewReport.jsx'

const mergeUsage = (a, b) => ({
  calls: a.calls + b.calls, input: a.input + b.input, output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
  costUsd: a.costUsd + b.costUsd, model: b.model || a.model,
})

const STEPS = ['① 불러오기', '② 앱 확인', '③ 판정 확인', '④ 보고서']
const API_KEY_STORAGE = 'edusafe_api_key'

// 심사자 API 키는 탭 세션에만 둔다 — localStorage는 같은 출처의 다른 페이지·XSS에 노출되고 지워지지 않는다.
function loadApiKey() {
  try {
    localStorage.removeItem(API_KEY_STORAGE)
    return sessionStorage.getItem(API_KEY_STORAGE) || ''
  } catch {
    return ''
  }
}

export default function ReviewMode() {
  const [step, setStep] = useState(1)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  // 1단계
  const [repoUrl, setRepoUrl] = useState('')
  const [repoMeta, setRepoMeta] = useState(null)
  const [files, setFiles] = useState([])
  const [scan, setScan] = useState(null)
  const [gate, setGate] = useState(null)

  // 2단계
  const [apiKey, setApiKey] = useState(loadApiKey)
  const [model, setModel] = useState(() => localStorage.getItem('edusafe_model') || DEFAULT_MODEL)
  const [features, setFeatures] = useState({})
  const [aiSuggest, setAiSuggest] = useState(null)

  // 3단계
  const [judgments, setJudgments] = useState({})
  const [aiMeta, setAiMeta] = useState(null) // { demoted, filled, coverage }
  const [aiRan, setAiRan] = useState(false)
  const [overrides, setOverrides] = useState({})
  const [humanInputs, setHumanInputs] = useState({})
  const [filter, setFilter] = useState('')
  const [savedRound, setSavedRound] = useState(null)
  const [usage, setUsage] = useState(emptyUsage())
  const [serverSync, setServerSync] = useState(null) // { synced, reason }
  const [certification, setCertification] = useState(null) // null | {phase:'pending'|'issued'|'not_issued'|'error', ...}
  const [noticeCopied, setNoticeCopied] = useState(false)
  // 실행 토큰 — '새 심사 시작' 뒤에 도착한 이전 앱의 AI 결과·불러오기 결과가 다음 심사에 섞이지 않게.
  const runRef = useRef(0)
  const certReqRef = useRef(0)
  const stillCurrent = (run) => run === runRef.current

  const copyTeacherNotice = async () => {
    try {
      await navigator.clipboard.writeText(buildTeacherNotice())
      setNoticeCopied(true)
      setTimeout(() => setNoticeCopied(false), 2500)
    } catch {
      window.alert(buildTeacherNotice())
    }
  }

  const protectionLevel = deriveProtectionLevel(features)
  const summary = useMemo(
    () => computeSummary(features, judgments, overrides, humanInputs),
    [features, judgments, overrides, humanInputs],
  )

  const saveKey = (v) => {
    setApiKey(v)
    try { sessionStorage.setItem(API_KEY_STORAGE, v) } catch { /* 세션 저장 불가 — 메모리에만 유지 */ }
  }
  const clearKey = () => saveKey('')
  const saveModel = (v) => { setModel(v); localStorage.setItem('edusafe_model', v) }

  const loadFolder = async (fileList) => {
    if (!fileList || fileList.length === 0) return
    const run = runRef.current
    setError('')
    try {
      setBusy('폴더 파일 읽는 중…')
      const { files: read, skippedCount, skippedPaths, scannableSkipped } = await readFolderFiles(fileList)
      if (read.length === 0) throw new Error('검사할 수 있는 파일이 없어요.')
      setBusy('SHA-256 콘텐츠 지문 계산 중…')
      const fingerprint = await computeFingerprint(read)
      const name = (fileList[0].webkitRelativePath || '제출 폴더').split('/')[0]
      const meta = { source: 'folder', name, fingerprint, skippedCount, skippedPaths, scannableSkipped }
      setBusy(`규칙 스캔 중… (파일 ${read.length}개)`)
      await new Promise((r) => setTimeout(r, 30))
      if (!stillCurrent(run)) return
      setRepoMeta(meta)
      setFiles(read)
      setScan(scanFiles(read))
      setGate(checkGate(read, meta))
    } catch (err) {
      if (stillCurrent(run)) setError(err.message)
    } finally {
      if (stillCurrent(run)) setBusy('')
    }
  }

  const loadRepo = async () => {
    const parsed = parseGithubUrl(repoUrl)
    if (!parsed) return setError('주소 형식을 알 수 없어요. 예: https://github.com/아이디/저장소')
    const run = runRef.current
    setError('')
    try {
      setBusy('저장소 불러오는 중…')
      const result = await fetchRepoFiles({ ...parsed, onProgress: (d, t) => { if (stillCurrent(run)) setBusy(`파일 내려받는 중… ${d}/${t}`) } })
      if (result.files.length === 0) throw new Error('검사할 수 있는 파일이 없어요.')
      const meta = {
        owner: parsed.owner, repo: parsed.repo, branch: result.branch, commitSha: result.commitSha,
        skippedCount: result.skippedCount, skippedPaths: result.skippedPaths, scannableSkipped: result.scannableSkipped,
        failedPaths: result.failedPaths || [], treeTruncated: result.treeTruncated,
      }
      setBusy(`규칙 스캔 중… (파일 ${result.files.length}개)`)
      await new Promise((r) => setTimeout(r, 30))
      if (!stillCurrent(run)) return
      setRepoMeta(meta)
      setFiles(result.files)
      setScan(scanFiles(result.files))
      setGate(checkGate(result.files, meta))
    } catch (err) {
      if (stillCurrent(run)) setError(err.message)
    } finally {
      if (stillCurrent(run)) setBusy('')
    }
  }

  const runSuggest = async () => {
    const run = runRef.current
    setError('')
    try {
      const { chunks } = buildAiPayloadChunks(files)
      setBusy(chunks.length > 1 ? `AI가 앱 기능을 확인하는 중… 코드 ${chunks.length}개 묶음 전체를 봅니다` : 'AI가 앱 기능을 확인하는 중…')
      const result = await suggestFeatures({ payloadChunks: chunks, apiKey, model })
      if (!stillCurrent(run)) return
      setAiSuggest(result)
      if (result.usage) setUsage((u) => mergeUsage(u, result.usage))
      setFeatures(result.features || {})
    } catch (err) {
      if (stillCurrent(run)) setError(`AI 제안 실패: ${err.message} — 체크박스로 직접 확인할 수 있어요.`)
    } finally {
      if (stillCurrent(run)) setBusy('')
    }
  }

  // 판정이 없는 적용 항목 — 첫 실행 전에는 전부, 실행 뒤 기능 확인을 바꿔 새로 적용된 항목만 남는다.
  const pendingAiItems = summary.items.filter((it) => it.aiVerifiable && !judgments[it.id])

  const runJudge = async () => {
    const run = runRef.current
    setError('')
    try {
      const payload = buildAiPayloadChunks(files)
      const many = payload.chunks.length > 1
      setBusy(many ? `AI가 판정 초안을 작성하는 중… 코드가 커서 ${payload.chunks.length}개 묶음으로 나눠 분석합니다 (수 분)` : 'AI가 항목별 판정 초안을 작성하는 중… (1~2분)')
      const aiItems = aiRan ? pendingAiItems : summary.items.filter((it) => it.aiVerifiable)
      const result = await judgeItems({
        payloadChunks: payload.chunks, items: aiItems, scanFindings: scan.findings, apiKey, model, files,
        onProgress: (d, t) => { if (t > 1 && stillCurrent(run)) setBusy(`AI 분할 분석 중… ${d}/${t} 묶음 완료`) },
      })
      if (!stillCurrent(run)) return
      setJudgments((prev) => ({ ...prev, ...result.judgments }))
      setAiMeta((prev) => ({
        demoted: [...(prev?.demoted || []), ...result.demoted],
        filled: [...(prev?.filled || []), ...result.filled],
        coverage: payload,
      }))
      if (result.usage) setUsage((u) => mergeUsage(u, result.usage))
      setAiRan(true)
    } catch (err) {
      if (stillCurrent(run)) setError(`AI 판정 실패: ${err.message}`)
    } finally {
      if (stillCurrent(run)) setBusy('')
    }
  }

  const setOverride = (id, verdict) => {
    setOverrides((prev) => {
      const next = { ...prev }
      if (!verdict) delete next[id]
      else next[id] = { ...next[id], verdict }
      return next
    })
  }
  const setOverrideReason = (id, reason) => setOverrides((prev) => ({ ...prev, [id]: { ...prev[id], reason } }))
  const setHuman = (id, verdict) => setHumanInputs((prev) => ({ ...prev, [id]: { ...prev[id], verdict } }))
  const setHumanReason = (id, reason) => setHumanInputs((prev) => ({ ...prev, [id]: { ...prev[id], reason } }))

  // 인증 응답은 요청 당시의 대상(저장소@커밋)·요청 번호와 맞을 때만 반영한다 — 새 심사 뒤 늦게 온 응답 차단.
  const requestCertification = async () => {
    if (!repoMeta?.commitSha) return
    const subjectKey = `${repoMeta.owner}/${repoMeta.repo}@${repoMeta.commitSha}`
    const requestId = ++certReqRef.current
    const settle = (next) => setCertification((cur) => settleCertificationRequest(cur, { subjectKey, requestId }, next))
    setCertification({ phase: 'pending', subjectKey, requestId })
    try {
      const response = await issueCertificationBadge({
        repositoryUrl: `https://github.com/${repoMeta.owner}/${repoMeta.repo}`,
        commitSha: repoMeta.commitSha,
      })
      settle(response.outcome === 'ISSUED' ? { phase: 'issued', response } : { phase: 'not_issued', response })
    } catch (err) {
      settle({ phase: 'error', message: err.message })
    }
  }

  const resetAll = () => {
    runRef.current++
    setStep(1); setRepoUrl(''); setRepoMeta(null); setFiles([]); setScan(null); setGate(null); setBusy('')
    setFeatures({}); setAiSuggest(null)
    setJudgments({}); setAiMeta(null); setAiRan(false); setOverrides({}); setHumanInputs({}); setFilter('')
    setSavedRound(null); setUsage(emptyUsage()); setCertification(null); setServerSync(null); setError('')
  }

  // 저장 뒤 판정·기능이 바뀌면 다시 저장할 수 있어야 한다 — 한 번 저장한 뒤의 변경이 대장에 못 남는 일 방지.
  useEffect(() => {
    setSavedRound(null)
    setServerSync(null)
  }, [judgments, overrides, humanInputs, features])

  const saveToLedger = () => {
    try {
      const entry = saveRecord({
        target: targetKey(repoMeta),
        owner: repoMeta.owner, repo: repoMeta.repo, commitSha: repoMeta.commitSha,
        name: repoMeta.name, fingerprint: repoMeta.fingerprint,
        profile: featureProfile(features), protectionLevel, status: summary.status, actions: summary.actions,
        rubricVersion: RUBRIC_VERSION, savedAt: new Date().toISOString(),
        counts, overrides: Object.keys(overrides).length, applicableItems: summary.items.length,
        aiUsed: aiRan, costUsd: usage.costUsd, certified: certification?.phase === 'issued',
      })
      setSavedRound(entry.round)
      syncRecordToServer(entry).then(setServerSync)
    } catch (err) {
      setError(`심사 기록 저장 실패: ${err?.message || err} — 브라우저 저장 공간을 확인하고 JSON 내보내기로 백업해 주세요.`)
    }
  }

  const counts = useMemo(() => {
    const c = { ok: 0, fail: 0, needs_human: 0, na: 0 }
    for (const it of summary.items) c[finalVerdict(it, judgments, overrides, humanInputs)]++
    return c
  }, [summary, judgments, overrides, humanInputs])

  const visibleItems = filter ? summary.items.filter((it) => finalVerdict(it, judgments, overrides, humanInputs) === filter) : summary.items

  return (
    <section className="panel">
      <div className="stepper no-print">
        {STEPS.map((label, i) => (
          <button key={label}
            className={`step ${step === i + 1 ? 'active' : ''} ${step > i + 1 ? 'done' : ''}`}
            disabled={i + 1 >= step}
            onClick={() => setStep(i + 1)}>
            {label}
          </button>
        ))}
      </div>

      {error && <div className="error">⚠️ {error}</div>}
      {busy && (
        <div className="busy busy-live">
          <div>
            <strong>검사 진행 중</strong> — {busy}
            <div className="hint">진행 중에는 이 화면을 닫거나 새로고침하지 마세요.</div>
          </div>
        </div>
      )}

      {/* ── ① 불러오기 ── */}
      {step === 1 && (
        <div>
          <h1>앱 불러오기</h1>
          <p className="intro">심사는 커밋 SHA에 고정됩니다 — "이 심사는 커밋 X에 대한 것".</p>
          {!repoMeta && (
            <div className="source-grid">
              <form className="source-card" onSubmit={(e) => { e.preventDefault(); if (!busy && repoUrl.trim()) loadRepo() }}>
                <strong>🐙 GitHub 저장소</strong>
                <p className="hint">공개 저장소 주소로 불러옵니다. 심사는 커밋 SHA에 고정됩니다.</p>
                <label className="field">저장소 주소
                  <input type="text" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)}
                    placeholder="https://github.com/아이디/저장소" disabled={!!busy} />
                </label>
                <button type="submit" className="btn-primary" disabled={!!busy || !repoUrl.trim()}>불러오기 + 규칙 스캔</button>
              </form>
              <div className="source-card">
                <strong>📁 폴더 업로드</strong>
                <p className="hint">GitHub이 없는 제출물은 폴더째 올립니다. 파일 전체의 SHA-256 콘텐츠 지문에 심사가 고정됩니다.</p>
                <label className={`upload-zone ${busy ? 'upload-disabled' : ''}`}>
                  <input type="file" webkitdirectory="" directory="" multiple disabled={!!busy}
                    onChange={(e) => loadFolder(e.target.files)} />
                  <span className="upload-icon">📂</span>
                  <strong>여기를 눌러 앱 폴더 선택</strong>
                  <span className="hint">파일은 이 브라우저 안에서만 읽힙니다 — 서버 업로드 없음</span>
                </label>
              </div>
              <p className="hint source-note">
                이 단계는 API 키 없이 실행됩니다. 심사자 API 키는 다음 단계(AI 분석)부터 사용되며, 이때 코드가 Anthropic API로 전송됩니다
                (데이터 파일 미전송·비밀키 마스킹 — 자세한 내용은 소개 페이지).
                제작 교사에게는 제출 전에 데이터 처리 방식을 안내해 주세요:{' '}
                <button type="button" className="btn-secondary btn-inline" onClick={copyTeacherNotice}>
                  {noticeCopied ? '✅ 복사됨' : '📋 제출 교사용 안내문 복사'}
                </button>
              </p>
            </div>
          )}
          {repoMeta && scan && gate && (
            <div className="loaded">
              <div className="repo-line">
                {repoMeta.commitSha
                  ? <>📦 {repoMeta.owner}/{repoMeta.repo} ({repoMeta.branch}) · 커밋 <code>{repoMeta.commitSha.slice(0, 12)}</code> · 파일 {files.length}개{repoMeta.skippedCount > 0 ? ` (코드 아님·상한 초과 ${repoMeta.skippedCount}개 수집 제외)` : ''}</>
                  : <>📁 {repoMeta.name} (폴더 제출) · 지문 <code>{repoMeta.fingerprint.slice(0, 12)}</code> · 파일 {files.length}개{repoMeta.skippedCount > 0 ? ` (코드 아님·상한 초과 ${repoMeta.skippedCount}개 수집 제외)` : ''}</>}
              </div>

              <div className="scan-box">
                <strong>제출 완결성 사전 게이트</strong>
                <ul className="gate-list">
                  {gate.checks.map((c) => (
                    <li key={c.id} className={c.pass ? 'gate-pass' : 'gate-fail'}>
                      {c.pass ? '✅' : '❌'} <strong>{c.label}</strong>
                      <div className="hint">{c.detail}</div>
                    </li>
                  ))}
                </ul>
                {!gate.pass && <p className="gate-warn">게이트 미비 — 심사 대신 <strong>반려 권고</strong>. 자료를 보완받은 뒤 심사하는 것이 판단불가를 줄입니다.</p>}
              </div>

              {(repoMeta.skippedPaths?.length || 0) > 0 && (() => {
                const suspects = suspectDataFiles(repoMeta.skippedPaths)
                const vendorCount = repoMeta.skippedPaths.filter(isVendorPath).length
                const others = repoMeta.skippedPaths.filter((p) => !isVendorPath(p))
                return (
                  <div className="scan-box">
                    <strong>읽지 않은 파일 {repoMeta.skippedPaths.length}개 — 코드가 아니거나 상한 초과</strong>
                    {repoMeta.treeTruncated && (
                      <p className="gate-warn">
                        🚨 <strong>GitHub이 저장소 파일 목록 자체를 잘라서 반환했습니다 (초대형 저장소).</strong>
                        {' '}목록에 없는 파일은 심사 대상에서 아예 빠졌을 수 있으니, 폴더 업로드로 다시 제출받는 것을 권합니다.
                      </p>
                    )}
                    {(repoMeta.failedPaths?.length || 0) > 0 && (
                      <p className="gate-warn">
                        🚨 <strong>파일 {repoMeta.failedPaths.length}개는 GitHub에서 내려받기에 실패해 읽지 못했습니다 (네트워크·요청 한도) — 심사 범위가 불완전합니다.</strong>
                        {' '}잠시 후 다시 불러오거나 폴더 업로드로 제출받으세요: {repoMeta.failedPaths.slice(0, 5).join(', ')}{repoMeta.failedPaths.length > 5 ? ' …' : ''}
                      </p>
                    )}
                    {(repoMeta.scannableSkipped || 0) - (repoMeta.failedPaths?.length || 0) > 0 && (
                      <p className="gate-warn">
                        🚨 <strong>검사 가능한 파일 {repoMeta.scannableSkipped - (repoMeta.failedPaths?.length || 0)}개가 수집 상한에 걸려 읽히지 못했습니다 — 심사 범위가 불완전합니다.</strong>
                        {' '}보안 설정·코드를 먼저 읽도록 우선순위를 적용했지만, 문서·산출물을 정리한 제출물로 재심사하는 것을 권합니다.
                      </p>
                    )}
                    {suspects.length > 0 ? (
                      <>
                        <p className="gate-warn">
                          ⚠️ 이 중 <strong>{suspects.length}개</strong>는 이름으로 볼 때 학생 데이터일 수 있습니다.
                          심사 도구가 내용을 읽지 못했으니 <strong>직접 열어 확인</strong>해 주세요 — 학생 실데이터 포함은 미충족 사유입니다.
                        </p>
                        <ul className="scan-list">
                          {suspects.slice(0, 20).map((p) => <li key={p}><code>{p}</code></li>)}
                          {suspects.length > 20 && <li className="hint">… 외 {suspects.length - 20}개</li>}
                        </ul>
                      </>
                    ) : (
                      <p className="hint">이름 기준으로 학생 데이터로 의심되는 파일은 없습니다 (이미지·폰트 등).</p>
                    )}
                    <details className="skipped-list">
                      <summary>읽지 않은 파일 전체 목록 보기</summary>
                      <ul className="scan-list">
                        {vendorCount > 0 && <li className="hint">📦 라이브러리·빌드 산출물(node_modules 등) {vendorCount}개 — 관례상 심사 제외</li>}
                        {others.slice(0, 200).map((p) => <li key={p}><code>{p}</code></li>)}
                        {others.length > 200 && <li className="hint">… 외 {others.length - 200}개</li>}
                      </ul>
                    </details>
                  </div>
                )
              })()}

              <div className="scan-box">
                <strong>자동 규칙 스캔</strong>
                {scan.findings.length === 0 ? (
                  <p className="intro">등록된 패턴에서 발견된 문제 없음</p>
                ) : (
                  <ul className="scan-list">
                    {scan.findings.map((f) => (
                      <li key={f.rule.id}>
                        <span className="sev" style={{ background: SEVERITIES[f.rule.severity].color }}>{SEVERITIES[f.rule.severity].label}</span>{' '}
                        {f.rule.title} ({f.occurrences.length}곳)
                        <div className="hint">{f.occurrences[0].file}:{f.occurrences[0].line} — <code>{f.occurrences[0].snippet}</code></div>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="hint">심각 {countBySeverity(scan.findings).critical} · 경고 {countBySeverity(scan.findings).warning} · 확인 필요 {countBySeverity(scan.findings).info} — 스캔 결과는 AI 판정 초안의 참고 입력이 됩니다.</p>
              </div>

              <div className="btn-row">
                <button className="btn-primary" onClick={() => setStep(2)}>
                  {gate.pass ? '② 앱 확인으로 계속' : '반려 권고를 확인했지만 계속 (심사자 재량)'}
                </button>
                <button className="btn-secondary" onClick={resetAll}>새 심사 시작</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── ② 앱 확인 ── */}
      {step === 2 && (
        <div>
          <h1>앱 확인</h1>
          <p className="intro">
            앱의 기능이 심사 항목과 보호 수준을 정합니다 — 해당하는 것을 모두 확인하세요.
            조건이 꺼진 항목은 자동 '해당없음'으로 접혀 표시되며, 판정 화면에서 되살릴 수 있습니다.
          </p>

          <div className="scan-box">
            <strong>앱 기능 확인 (심사자)</strong>
            {Object.entries(FEATURES).map(([key, f]) => (
              <label key={key} className="check-line">
                <input type="checkbox" checked={!!features[key]} onChange={(e) => setFeatures((p) => ({ ...p, [key]: e.target.checked }))} />
                <span>{f.label} <span className="hint">→ {f.gates}</span></span>
              </label>
            ))}
            <div className="level-line">
              적용 심사 항목: <strong>{summary.items.length} / {rubricItems.length}</strong> (조건 미해당 {summary.inapplicable.length}) ·
              보호 수준: <strong>{PROTECTION_LEVELS[protectionLevel].label}</strong> — {PROTECTION_LEVELS[protectionLevel].plain}
            </div>
          </div>

          <div className="scan-box">
            <strong>AI 설정 — 3단계 판정 초안에 사용 (심사자 개인 키, 이 탭을 닫으면 지워짐)</strong>
            <label className="field">Anthropic API 키
              <input type="password" value={apiKey} onChange={(e) => saveKey(e.target.value)} placeholder="sk-ant-…" autoComplete="off" />
            </label>
            {apiKey && <div><button type="button" className="btn-secondary btn-inline" onClick={clearKey}>🗑️ 키 지우기</button></div>}
            <label className="field">모델
              <select value={model} onChange={(e) => saveModel(e.target.value)}>
                {MODEL_OPTIONS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
            <div>
              <button className="btn-secondary" onClick={runSuggest} disabled={!!busy || !apiKey.trim()}>🤖 기능 확인을 AI에게 제안받기 (선택)</button>
            </div>
            <p className="hint">{apiKey.trim() ? '애매할 때만 쓰는 보조 기능입니다 — 제안을 받아도 확정은 심사자가 합니다.' : 'API 키가 없어도 확인·심사 전 과정을 수동으로 진행할 수 있습니다.'}</p>
          </div>

          {aiSuggest && (
            <div className="ai-suggest">
              <strong>AI 제안</strong>: {featureProfile(aiSuggest.features)} — {aiSuggest.featureReason}
              {aiSuggest.appSummary && <div className="hint">{aiSuggest.appSummary}</div>}
              {aiSuggest.chunkCount > 1 && <div className="hint">코드 {aiSuggest.chunkCount}개 묶음을 모두 보고 합친 제안입니다.</div>}
            </div>
          )}

          <div className="btn-row">
            <button className="btn-primary" onClick={() => setStep(3)}>③ 판정으로 계속 ({summary.items.length}항목)</button>
            <button className="btn-secondary" onClick={() => setStep(1)}>← 뒤로</button>
          </div>
        </div>
      )}

      {/* ── ③ 판정 확인 ── */}
      {step === 3 && summary && (
        <div>
          <h1>판정 확인 — 적용 {summary.items.length}항목 <span className="hint">({featureProfile(features)})</span></h1>
          <p className="intro">AI 출력은 판정 초안입니다. 최종 판정은 심사자가 하며, 번복은 사유와 함께 기록됩니다.</p>

          {(!aiRan || pendingAiItems.length > 0) && (
            <div className="scan-box">
              <button className="btn-primary" onClick={runJudge} disabled={!!busy || !apiKey.trim() || pendingAiItems.length === 0}>
                {aiRan ? `🤖 AI 판정 초안 재실행 — 기능 확인 변경으로 새로 적용된 ${pendingAiItems.length}개 항목만` : `🤖 AI 판정 초안 실행 (${pendingAiItems.length}개 항목)`}
              </button>
              <p className="hint">{apiKey.trim() ? '전송 전 비밀키 마스킹·데이터 파일 제외가 적용됩니다.' : 'API 키가 없어 수동 심사 모드입니다 — 모든 항목을 심사자가 직접 판정합니다.'}</p>
            </div>
          )}

          {aiMeta && (aiMeta.demoted.length > 0 || aiMeta.filled.length > 0) && (
            <div className="busy">
              🔎 검증 결과: 근거가 확인되지 않아 판단불가로 강등 {aiMeta.demoted.length}건, 응답 누락으로 판단불가 채움 {aiMeta.filled.length}건 (원칙 1·2)
            </div>
          )}
          {usage.calls > 0 && (
            <div className="busy">
              💰 이번 심사의 AI 비용 ≈ <strong>${usage.costUsd.toFixed(3)}</strong> (호출 {usage.calls}회 · 입력 {usage.input.toLocaleString()} · 출력 {usage.output.toLocaleString()} 토큰{usage.cacheRead > 0 ? ` · 캐시 재사용 ${usage.cacheRead.toLocaleString()}` : ''}) — 공식 단가 기준 추정치, 보고서에 고지됩니다
            </div>
          )}
          {aiMeta && aiMeta.coverage.excludedFiles.length > 0 && (
            <div className="busy">📄 AI 검토 커버리지 {aiMeta.coverage.coveragePercent}% — 제외 {aiMeta.coverage.excludedFiles.length}개 파일 (보고서에 고지됩니다)</div>
          )}

          <div className="chip-row">
            {[['ok', '충족'], ['fail', '미충족'], ['needs_human', '판단불가'], ['na', '해당없음']].map(([k, label]) => (
              <button key={k} className={`chip chip-${k} ${filter === k ? 'chip-on' : ''}`} onClick={() => setFilter(filter === k ? '' : k)}>
                {label} {counts[k]}
              </button>
            ))}
            {filter && <button className="chip" onClick={() => setFilter('')}>전체 보기</button>}
          </div>

          <div className="item-list">
            {visibleItems.map((it) => {
              const v = finalVerdict(it, judgments, overrides, humanInputs)
              const j = judgments[it.id]
              const ov = overrides[it.id]
              return (
                <div key={it.id} className="item-card" style={{ borderLeftColor: verdictColor(v, it) }}>
                  <div className="item-head">
                    <span className="verdict-chip" style={{ background: verdictColor(v, it), opacity: v === 'na' ? 0.55 : 1 }}>{VERDICT_LABELS[v]}</span>
                    <strong>{it.question}</strong>
                  </div>
                  <div className="item-sub">
                    {it.id} · {it.type === 'required' ? '필수' : '점수'} · {AUTHORITY_LABELS[it.authority]}{it.level ? ` · 기준선 ${it.level}` : ''} {it.aiVerifiable ? '' : '· 수동 판정 항목'}
                  </div>
                  <p className="item-plain">{it.plain}</p>

                  {it.aiVerifiable ? (
                    <div className="item-ai">
                      {j ? (
                        <>
                          <div className="hint">AI 초안: {VERDICT_LABELS[j.verdict]} — {j.reason}</div>
                          {j.evidence?.map((e, i) => (
                            <div key={i} className="vt-evidence"><code>{e.file}</code>: {e.quote}</div>
                          ))}
                        </>
                      ) : (
                        <div className="hint">AI 판정 없음 — 판단불가 (심사자 직접 판정 가능)</div>
                      )}
                      <div className="override-row">
                        <label>심사자 판정:{' '}
                          <select value={ov?.verdict || ''} onChange={(e) => setOverride(it.id, e.target.value)}>
                            <option value="">AI 초안 따름{j ? ` (${VERDICT_LABELS[j.verdict]})` : ' (판단불가)'}</option>
                            {Object.entries(VERDICT_LABELS).map(([k, label]) => <option key={k} value={k}>{label}(으)로 번복{k === 'na' && it.type === 'required' ? ' — 사유 필수' : ''}</option>)}
                          </select>
                        </label>
                        {ov?.verdict && (
                          <input type="text" className="reason-input" placeholder={naNeedsReason(it, ov.verdict, overrides, humanInputs) ? '필수 항목의 해당없음 사유 — 적어야 인정됩니다' : '번복 사유 (기록 보존)'} value={ov.reason || ''}
                            onChange={(e) => setOverrideReason(it.id, e.target.value)} />
                        )}
                      </div>
                      {ov?.verdict && naNeedsReason(it, ov.verdict, overrides, humanInputs) && (
                        <p className="hint">필수 항목의 '해당없음'은 사유가 있어야 인정됩니다 — 사유가 비어 있는 동안은 판단불가로 집계됩니다.</p>
                      )}
                    </div>
                  ) : (
                    <div className="override-row">
                      <label>심사자 판정:{' '}
                        <select value={humanInputs[it.id]?.verdict || ''} onChange={(e) => setHuman(it.id, e.target.value)}>
                          <option value="">판정 선택 (미선택 = 판단불가)</option>
                          {Object.entries(VERDICT_LABELS).map(([k, label]) => <option key={k} value={k}>{label}{k === 'na' && it.type === 'required' ? ' — 사유 필수' : ''}</option>)}
                        </select>
                      </label>
                      {humanInputs[it.id]?.verdict === 'na' && it.type === 'required' && (
                        <input type="text" className="reason-input" placeholder="필수 항목의 해당없음 사유 — 적어야 인정됩니다" value={humanInputs[it.id]?.reason || ''}
                          onChange={(e) => setHumanReason(it.id, e.target.value)} />
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {summary.inapplicable.length > 0 && (
            <details className="skipped-list inapplicable-box">
              <summary>조건 미해당으로 자동 '해당없음' 처리된 항목 {summary.inapplicable.length}개 — 펼쳐서 확인·되살리기</summary>
              <div className="item-list" style={{ marginTop: 10 }}>
                {summary.inapplicable.map((it) => (
                  <div key={it.id} className="item-card item-card-muted">
                    <div className="item-head"><strong>{it.question}</strong></div>
                    <div className="item-sub">{it.id} · 적용 조건: "{FEATURES[it.when].label}" (미확인 상태)</div>
                    <div className="override-row">
                      <label>이 항목을 심사에 포함:{' '}
                        <select value={overrides[it.id]?.verdict || ''} onChange={(e) => setOverride(it.id, e.target.value)}>
                          <option value="">해당없음 유지</option>
                          {Object.entries(VERDICT_LABELS).map(([k, label]) => <option key={k} value={k}>{label}(으)로 판정</option>)}
                        </select>
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}

          <div className="btn-row">
            <button className="btn-primary" onClick={() => setStep(4)}>④ 보고서 생성</button>
            <button className="btn-secondary" onClick={() => setStep(2)}>← 뒤로</button>
          </div>
        </div>
      )}

      {/* ── ④ 보고서 ── */}
      {step === 4 && summary && (
        <div>
          <ReviewReport
            repoMeta={repoMeta} features={features} protectionLevel={protectionLevel}
            appSummary={aiSuggest?.appSummary} summary={summary}
            judgments={judgments} overrides={overrides} humanInputs={humanInputs}
            coverage={aiMeta?.coverage} gate={gate} model={model} aiUsed={aiRan} usage={usage} certification={certification}
          />
          {summary.status === 'pass_candidate' && repoMeta.commitSha && (
            <div className="scan-box no-print">
              <strong>🏅 EAS 인증마크 (가스리스 오프체인 서명)</strong>
              <p className="hint">합격 후보이고 GitHub 커밋에 고정된 심사만 발급 요청할 수 있습니다. 인증 서버가 같은 커밋을 다시 분석해 필수 기준 전항 충족·차단 사유 없음을 확인한 뒤 서명합니다.</p>
              {!certification && <div><button className="btn-primary" onClick={requestCertification}>인증마크 발급 요청</button></div>}
              {certification?.phase === 'pending' && <div className="busy busy-live"><div><strong>인증 서버가 커밋을 재분석 중</strong> — 잠시만 기다려 주세요.</div></div>}
              {certification?.phase === 'issued' && <p className="gate-warn" style={{ background: 'var(--primary-soft)', color: 'var(--primary-deep)' }}>✅ 발급 완료 — 보고서 하단 심사 기록마크에 서명·검증 링크가 표시됩니다.</p>}
              {certification?.phase === 'not_issued' && (
                <p className="gate-warn">인증 서버 재분석 결과 <strong>미발급</strong>: {(certification.response?.safetyBlockers || []).length > 0 ? `차단 사유 ${certification.response.safetyBlockers.length}건` : '필수 기준 미충족'} — 보완 후 재심사하세요.</p>
              )}
              {certification?.phase === 'error' && <p className="gate-warn">인증 요청 실패: {certification.message} (인증 서버가 없는 배포에서는 발급되지 않습니다)</p>}
            </div>
          )}
          <div className="btn-row no-print">
            <button className="btn-primary" disabled={!!savedRound} onClick={saveToLedger}>
              {savedRound ? `✅ 저장됨 (${savedRound}회차)` : '📚 심사 기록에 저장'}
            </button>
            <button className="btn-secondary" onClick={() => setStep(3)}>← 판정으로 돌아가기</button>
            <button className="btn-secondary" onClick={resetAll}>새 심사 시작</button>
          </div>
          {serverSync && (
            <p className="hint no-print">
              {serverSync.synced
                ? `☁️ 서버 대장에도 저장됨 (서버 ${serverSync.round}회차)`
                : serverSync.reason === 'login'
                  ? '이 브라우저에만 저장됨 — 서버 대장에 남기려면 /admin/login 으로 로그인 후 다시 저장하세요.'
                  : serverSync.reason === 'unavailable'
                    ? '이 브라우저에만 저장됨 — 서버 대장 테이블이 아직 준비되지 않았습니다 (db:migrate).'
                    : `이 브라우저에만 저장됨 — 서버 저장 실패 (${serverSync.reason})`}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
