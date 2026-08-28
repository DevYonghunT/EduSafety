import { useMemo, useState } from 'react'
import { parseGithubUrl, fetchRepoFiles } from '../lib/github.js'
import { scanFiles, countBySeverity, suspectDataFiles, isVendorPath } from '../lib/scanner.js'
import { SEVERITIES } from '../data/securityRules.js'
import { FEATURES, featureProfile, AUTHORITY_LABELS, RUBRIC_VERSION, rubricItems } from '../data/rubric.js'
import { checkGate } from '../lib/submissionGate.js'
import { readFolderFiles, computeFingerprint } from '../lib/localFolder.js'
import { buildAiPayloadChunks } from '../lib/redact.js'
import { suggestFeatures, judgeItems, deriveProtectionLevel, PROTECTION_LEVELS, DEFAULT_MODEL, MODEL_OPTIONS } from '../lib/reviewAi.js'
import { computeSummary, finalVerdict } from '../lib/reviewSummary.js'
import { saveRecord, targetKey } from '../lib/ledger.js'
import { buildTeacherNotice } from '../lib/dataNotice.js'
import ReviewReport, { VERDICT_LABELS, verdictColor } from './ReviewReport.jsx'

const STEPS = ['① 불러오기', '② 앱 확인', '③ 판정 확인', '④ 보고서']

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
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('edusafe_api_key') || '')
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
  const [noticeCopied, setNoticeCopied] = useState(false)

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

  const saveKey = (v) => { setApiKey(v); localStorage.setItem('edusafe_api_key', v) }
  const saveModel = (v) => { setModel(v); localStorage.setItem('edusafe_model', v) }

  const loadFolder = async (fileList) => {
    if (!fileList || fileList.length === 0) return
    setError('')
    try {
      setBusy('폴더 파일 읽는 중…')
      const { files: read, skippedCount, skippedPaths, scannableSkipped } = await readFolderFiles(fileList)
      if (read.length === 0) throw new Error('검사할 수 있는 파일이 없어요.')
      setBusy('SHA-256 콘텐츠 지문 계산 중…')
      const fingerprint = await computeFingerprint(read)
      const name = (fileList[0].webkitRelativePath || '제출 폴더').split('/')[0]
      const meta = { source: 'folder', name, fingerprint, skippedCount, skippedPaths, scannableSkipped }
      setRepoMeta(meta)
      setFiles(read)
      setScan(scanFiles(read))
      setGate(checkGate(read, meta))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  const loadRepo = async () => {
    const parsed = parseGithubUrl(repoUrl)
    if (!parsed) return setError('주소 형식을 알 수 없어요. 예: https://github.com/아이디/저장소')
    setError('')
    try {
      setBusy('저장소 불러오는 중…')
      const result = await fetchRepoFiles({ ...parsed, onProgress: (d, t) => setBusy(`파일 내려받는 중… ${d}/${t}`) })
      if (result.files.length === 0) throw new Error('검사할 수 있는 파일이 없어요.')
      const meta = { owner: parsed.owner, repo: parsed.repo, branch: result.branch, commitSha: result.commitSha, skippedCount: result.skippedCount, skippedPaths: result.skippedPaths, scannableSkipped: result.scannableSkipped }
      setRepoMeta(meta)
      setFiles(result.files)
      setScan(scanFiles(result.files))
      setGate(checkGate(result.files, meta))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  const runSuggest = async () => {
    setError('')
    try {
      setBusy('AI가 앱 기능을 확인하는 중…')
      const { chunks } = buildAiPayloadChunks(files)
      const result = await suggestFeatures({ payloadText: chunks[0], apiKey, model })
      setAiSuggest(result)
      setFeatures(result.features || {})
    } catch (err) {
      setError(`AI 제안 실패: ${err.message} — 체크박스로 직접 확인할 수 있어요.`)
    } finally {
      setBusy('')
    }
  }

  const runJudge = async () => {
    setError('')
    try {
      const payload = buildAiPayloadChunks(files)
      const many = payload.chunks.length > 1
      setBusy(many ? `AI가 판정 초안을 작성하는 중… 코드가 커서 ${payload.chunks.length}개 묶음으로 나눠 분석합니다 (수 분)` : 'AI가 항목별 판정 초안을 작성하는 중… (1~2분)')
      const aiItems = summary.items.filter((it) => it.aiVerifiable)
      const result = await judgeItems({
        payloadChunks: payload.chunks, items: aiItems, scanFindings: scan.findings, apiKey, model, files,
        onProgress: (d, t) => { if (t > 1) setBusy(`AI 분할 분석 중… ${d}/${t} 묶음 완료`) },
      })
      setJudgments(result.judgments)
      setAiMeta({ demoted: result.demoted, filled: result.filled, coverage: payload })
      setAiRan(true)
    } catch (err) {
      setError(`AI 판정 실패: ${err.message}`)
    } finally {
      setBusy('')
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
  const setHuman = (id, verdict) => setHumanInputs((prev) => ({ ...prev, [id]: { verdict } }))

  const resetAll = () => {
    setStep(1); setRepoUrl(''); setRepoMeta(null); setFiles([]); setScan(null); setGate(null)
    setFeatures({}); setAiSuggest(null)
    setJudgments({}); setAiMeta(null); setAiRan(false); setOverrides({}); setHumanInputs({}); setFilter('')
    setSavedRound(null); setError('')
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
      {busy && <div className="busy">⏳ {busy}</div>}

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
                <label className="field">앱 폴더 선택
                  <input type="file" webkitdirectory="" directory="" multiple disabled={!!busy}
                    onChange={(e) => loadFolder(e.target.files)} />
                </label>
                <p className="hint">파일은 이 브라우저 안에서만 읽힙니다 — 서버 업로드 없음.</p>
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
                    {(repoMeta.scannableSkipped || 0) > 0 && (
                      <p className="gate-warn">
                        🚨 <strong>검사 가능한 파일 {repoMeta.scannableSkipped}개가 수집 상한에 걸려 읽히지 못했습니다 — 심사 범위가 불완전합니다.</strong>
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
            <strong>AI 설정 — 3단계 판정 초안에 사용 (심사자 개인 키, 이 브라우저에만 저장)</strong>
            <label className="field">Anthropic API 키
              <input type="password" value={apiKey} onChange={(e) => saveKey(e.target.value)} placeholder="sk-ant-…" />
            </label>
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

          {!aiRan && (
            <div className="scan-box">
              <button className="btn-primary" onClick={runJudge} disabled={!!busy || !apiKey.trim()}>🤖 AI 판정 초안 실행 ({summary.items.filter((i) => i.aiVerifiable).length}개 항목)</button>
              <p className="hint">{apiKey.trim() ? '전송 전 비밀키 마스킹·데이터 파일 제외가 적용됩니다.' : 'API 키가 없어 수동 심사 모드입니다 — 모든 항목을 심사자가 직접 판정합니다.'}</p>
            </div>
          )}

          {aiMeta && (aiMeta.demoted.length > 0 || aiMeta.filled.length > 0) && (
            <div className="busy">
              🔎 검증 결과: 근거가 확인되지 않아 판단불가로 강등 {aiMeta.demoted.length}건, 응답 누락으로 판단불가 채움 {aiMeta.filled.length}건 (원칙 1·2)
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
                            {Object.entries(VERDICT_LABELS).map(([k, label]) => <option key={k} value={k}>{label}(으)로 번복</option>)}
                          </select>
                        </label>
                        {ov?.verdict && (
                          <input type="text" className="reason-input" placeholder="번복 사유 (기록 보존)" value={ov.reason || ''}
                            onChange={(e) => setOverrideReason(it.id, e.target.value)} />
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="override-row">
                      <label>심사자 판정:{' '}
                        <select value={humanInputs[it.id]?.verdict || ''} onChange={(e) => setHuman(it.id, e.target.value)}>
                          <option value="">판정 선택 (미선택 = 판단불가)</option>
                          {Object.entries(VERDICT_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                        </select>
                      </label>
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
            coverage={aiMeta?.coverage} gate={gate} model={model} aiUsed={aiRan}
          />
          <div className="btn-row no-print">
            <button className="btn-primary" disabled={!!savedRound} onClick={() => {
              const entry = saveRecord({
                target: targetKey(repoMeta),
                owner: repoMeta.owner, repo: repoMeta.repo, commitSha: repoMeta.commitSha,
                name: repoMeta.name, fingerprint: repoMeta.fingerprint,
                profile: featureProfile(features), protectionLevel, status: summary.status, actions: summary.actions,
                rubricVersion: RUBRIC_VERSION, savedAt: new Date().toISOString(),
              })
              setSavedRound(entry.round)
            }}>
              {savedRound ? `✅ 저장됨 (${savedRound}회차)` : '📚 심사 기록에 저장'}
            </button>
            <button className="btn-secondary" onClick={() => setStep(3)}>← 판정으로 돌아가기</button>
            <button className="btn-secondary" onClick={resetAll}>새 심사 시작</button>
          </div>
        </div>
      )}
    </section>
  )
}
