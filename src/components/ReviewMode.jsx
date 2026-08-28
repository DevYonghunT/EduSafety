import { useMemo, useState } from 'react'
import { parseGithubUrl, fetchRepoFiles } from '../lib/github.js'
import { scanFiles, countBySeverity } from '../lib/scanner.js'
import { SEVERITIES } from '../data/securityRules.js'
import { TRACKS, rubricItems, AUTHORITY_LABELS } from '../data/rubric.js'
import { checkGate } from '../lib/submissionGate.js'
import { buildAiPayload } from '../lib/redact.js'
import { classifyApp, judgeItems, deriveProtectionLevel, PROTECTION_LEVELS, DEFAULT_MODEL, MODEL_OPTIONS } from '../lib/reviewAi.js'
import { computeSummary, finalVerdict } from '../lib/reviewSummary.js'
import ReviewReport, { VERDICT_LABELS, verdictColor } from './ReviewReport.jsx'

const STEPS = ['① 불러오기', '② 분류 확정', '③ 판정 확인', '④ 보고서']

const FEATURE_LABELS = {
  collectsPersonalInfo: '학생·학부모 개인정보를 수집한다',
  collectsSensitiveInfo: '민감정보(건강·상담·성적 상세)를 다룬다',
  hasAssessmentOrCompetition: '평가·점수·랭킹·경쟁 기능이 있다',
  studentFacing: '학생이 직접 사용하는 화면이 있다',
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
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('edusafe_api_key') || '')
  const [model, setModel] = useState(() => localStorage.getItem('edusafe_model') || DEFAULT_MODEL)
  const [track, setTrack] = useState('')
  const [features, setFeatures] = useState({})
  const [aiClassify, setAiClassify] = useState(null)

  // 3단계
  const [judgments, setJudgments] = useState({})
  const [aiMeta, setAiMeta] = useState(null) // { demoted, filled, coverage }
  const [aiRan, setAiRan] = useState(false)
  const [overrides, setOverrides] = useState({})
  const [humanInputs, setHumanInputs] = useState({})
  const [filter, setFilter] = useState('')

  const protectionLevel = deriveProtectionLevel(features)
  const trackItems = useMemo(() => (track ? rubricItems.filter((it) => it.tracks.includes(track)) : []), [track])
  const summary = useMemo(
    () => (track ? computeSummary(track, judgments, overrides, humanInputs) : null),
    [track, judgments, overrides, humanInputs],
  )

  const saveKey = (v) => { setApiKey(v); localStorage.setItem('edusafe_api_key', v) }
  const saveModel = (v) => { setModel(v); localStorage.setItem('edusafe_model', v) }

  const loadRepo = async () => {
    const parsed = parseGithubUrl(repoUrl)
    if (!parsed) return setError('주소 형식을 알 수 없어요. 예: https://github.com/아이디/저장소')
    setError('')
    try {
      setBusy('저장소 불러오는 중…')
      const result = await fetchRepoFiles({ ...parsed, onProgress: (d, t) => setBusy(`파일 내려받는 중… ${d}/${t}`) })
      if (result.files.length === 0) throw new Error('검사할 수 있는 파일이 없어요.')
      const meta = { owner: parsed.owner, repo: parsed.repo, branch: result.branch, commitSha: result.commitSha }
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

  const runClassify = async () => {
    setError('')
    try {
      setBusy('AI가 앱을 분류하는 중…')
      const { payloadText } = buildAiPayload(files)
      const result = await classifyApp({ payloadText, apiKey, model })
      setAiClassify(result)
      if (result.track) setTrack(result.track)
      setFeatures(result.features || {})
    } catch (err) {
      setError(`AI 분류 실패: ${err.message} — 아래에서 직접 선택할 수 있어요.`)
    } finally {
      setBusy('')
    }
  }

  const runJudge = async () => {
    setError('')
    try {
      setBusy('AI가 항목별 판정 초안을 작성하는 중… (1~2분)')
      const payload = buildAiPayload(files)
      const aiItems = trackItems.filter((it) => it.aiVerifiable)
      const result = await judgeItems({
        payloadText: payload.payloadText, items: aiItems, scanFindings: scan.findings, apiKey, model, files,
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
    setTrack(''); setFeatures({}); setAiClassify(null)
    setJudgments({}); setAiMeta(null); setAiRan(false); setOverrides({}); setHumanInputs({}); setFilter('')
    setError('')
  }

  const counts = useMemo(() => {
    const c = { ok: 0, fail: 0, needs_human: 0, na: 0 }
    for (const it of trackItems) c[finalVerdict(it, judgments, overrides, humanInputs)]++
    return c
  }, [trackItems, judgments, overrides, humanInputs])

  const visibleItems = filter ? trackItems.filter((it) => finalVerdict(it, judgments, overrides, humanInputs) === filter) : trackItems

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
            <form className="setup" onSubmit={(e) => { e.preventDefault(); if (!busy && repoUrl.trim()) loadRepo() }}>
              <label className="field">심사 대상 GitHub 공개 저장소
                <input type="text" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/아이디/저장소" disabled={!!busy} />
              </label>
              <button type="submit" className="btn-primary" disabled={!!busy || !repoUrl.trim()}>불러오기 + 규칙 스캔</button>
              <p className="hint">이 단계는 API 키 없이 실행됩니다. 심사자 API 키는 다음 단계(AI 분석)부터 사용됩니다. 폴더 업로드는 추후 지원 예정.</p>
            </form>
          )}
          {repoMeta && scan && gate && (
            <div className="loaded">
              <div className="repo-line">
                📦 {repoMeta.owner}/{repoMeta.repo} ({repoMeta.branch}) · 커밋 <code>{repoMeta.commitSha.slice(0, 12)}</code> · 파일 {files.length}개
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
                  {gate.pass ? '② 분류로 계속' : '반려 권고를 확인했지만 계속 (심사자 재량)'}
                </button>
                <button className="btn-secondary" onClick={resetAll}>새 심사 시작</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── ② 분류 확정 ── */}
      {step === 2 && (
        <div>
          <h1>분류 확정</h1>
          <p className="intro">AI가 4트랙 중 하나를 근거와 함께 제안하고, 심사자가 확정합니다. 트랙에 따라 심사 항목이 달라집니다.</p>

          <div className="scan-box">
            <strong>AI 설정 (심사자 개인 키 — 이 브라우저에만 저장)</strong>
            <label className="field">Anthropic API 키
              <input type="password" value={apiKey} onChange={(e) => saveKey(e.target.value)} placeholder="sk-ant-…" />
            </label>
            <label className="field">모델
              <select value={model} onChange={(e) => saveModel(e.target.value)}>
                {MODEL_OPTIONS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
            <button className="btn-primary" onClick={runClassify} disabled={!!busy || !apiKey.trim()}>🤖 AI 분류 실행</button>
            {!apiKey.trim() && <p className="hint">API 키가 없으면 AI 없이 아래에서 직접 분류할 수 있습니다 (판정도 수동으로 진행).</p>}
          </div>

          {aiClassify && (
            <div className="ai-suggest">
              <strong>AI 제안</strong>: {aiClassify.track ? `${TRACKS[aiClassify.track].icon} ${TRACKS[aiClassify.track].label}` : '분류 불확실'} — {aiClassify.trackReason}
              {aiClassify.appSummary && <div className="hint">{aiClassify.appSummary}</div>}
            </div>
          )}

          <div className="scan-box">
            <strong>트랙 확정 (심사자)</strong>
            <div className="track-grid">
              {Object.entries(TRACKS).map(([key, t]) => (
                <label key={key} className={`track-card ${track === key ? 'selected' : ''}`}>
                  <input type="radio" name="track" checked={track === key} onChange={() => setTrack(key)} />
                  {t.icon} {t.label}
                </label>
              ))}
            </div>
          </div>

          <div className="scan-box">
            <strong>앱 기능 확인 → 보호 수준 자동 도출</strong>
            {Object.entries(FEATURE_LABELS).map(([key, label]) => (
              <label key={key} className="check-line">
                <input type="checkbox" checked={!!features[key]} onChange={(e) => setFeatures((p) => ({ ...p, [key]: e.target.checked }))} />
                {label}
              </label>
            ))}
            <div className="level-line">이 앱의 보호 수준: <strong>{PROTECTION_LEVELS[protectionLevel].label}</strong> — {PROTECTION_LEVELS[protectionLevel].plain}</div>
          </div>

          <div className="btn-row">
            <button className="btn-primary" onClick={() => setStep(3)} disabled={!track}>③ 판정으로 계속</button>
            <button className="btn-secondary" onClick={() => setStep(1)}>← 뒤로</button>
          </div>
        </div>
      )}

      {/* ── ③ 판정 확인 ── */}
      {step === 3 && summary && (
        <div>
          <h1>판정 확인 — {TRACKS[track].icon} {TRACKS[track].label} · {trackItems.length}항목</h1>
          <p className="intro">AI 출력은 판정 초안입니다. 최종 판정은 심사자가 하며, 번복은 사유와 함께 기록됩니다.</p>

          {!aiRan && (
            <div className="scan-box">
              <button className="btn-primary" onClick={runJudge} disabled={!!busy || !apiKey.trim()}>🤖 AI 판정 초안 실행 ({trackItems.filter((i) => i.aiVerifiable).length}개 항목)</button>
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
                    {it.id} · {it.type === 'required' ? '필수' : '점수'} · {AUTHORITY_LABELS[it.authority]} {it.aiVerifiable ? '' : '· 수동 판정 항목'}
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
            repoMeta={repoMeta} track={track} protectionLevel={protectionLevel}
            appSummary={aiClassify?.appSummary} summary={summary}
            judgments={judgments} overrides={overrides} humanInputs={humanInputs}
            coverage={aiMeta?.coverage} gate={gate}
          />
          <div className="btn-row no-print">
            <button className="btn-secondary" onClick={() => setStep(3)}>← 판정으로 돌아가기</button>
            <button className="btn-secondary" onClick={resetAll}>새 심사 시작</button>
          </div>
        </div>
      )}
    </section>
  )
}
