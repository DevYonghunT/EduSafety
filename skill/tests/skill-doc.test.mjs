import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { readSpec, specStepTable, cells } from './helpers/spec-parse.mjs'

const SKILL = readFileSync('edusafe/SKILL.md', 'utf8')
const README = readFileSync('edusafe/README.md', 'utf8')
const version = JSON.parse(readFileSync('edusafe/rules/version.json', 'utf8'))
const CR = String.fromCharCode(13)

// SKILL.md 에서 5열 단계표를 spec 과 같은 방식으로 뽑는다
function stepTableOf(text) {
  const rows = []
  let started = false
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) {
      if (started) break
      continue
    }
    const c = cells(line)
    if (c.length !== 5) { if (started) break; continue }
    if (c[0] === '단계') { started = true; continue }
    if (c.every((x) => /^-+$/.test(x))) continue
    if (!started) continue
    rows.push({ step: c[0], work: c[1], waits: c[2], headless: c[3], coverage: c[4] })
  }
  return rows
}

// 3열 결정표(항목·조건·effective)를 구간에서 뽑는다. spec §7.6 과 절차서를 대조하는 데 쓴다.
function severityRows(text, from, to) {
  const a = text.indexOf(from)
  const b = text.indexOf(to, a + 1)
  if (a < 0) throw new Error(`구간 시작을 찾지 못했습니다: ${from}`)
  const section = b < 0 ? text.slice(a) : text.slice(a, b)
  return section.split('\n')
    .filter((l) => l.startsWith('|'))
    .map(cells)
    .filter((c) => c.length === 3 && c[0] !== '항목' && !/^-+$/.test(c[0]))
    .map((c) => c.map((x) => x.replace(/`/g, '')))
}

describe('SKILL.md 절차서', () => {
  it('1. frontmatter 에 name·description 만 있고 name 은 edusafe 다 (REQ-10.1)', () => {
    const m = SKILL.match(/^---\n([\s\S]*?)\n---\n/)
    expect(m, 'frontmatter 를 찾지 못했습니다').toBeTruthy()
    const keys = m[1].split('\n').filter(Boolean).map((l) => l.split(':')[0].trim())
    expect(keys.sort()).toEqual(['description', 'name'])
    expect(m[1]).toMatch(/^name:\s*edusafe\s*$/m)
  })

  it('1. frontmatter 에 버전을 적지 않는다 (version.json 이 정본 · REQ-13.3)', () => {
    const m = SKILL.match(/^---\n([\s\S]*?)\n---\n/)
    expect(m[1]).not.toMatch(/version/i)
  })

  it('2. CRLF 가 없다 (REQ-10.2)', () => {
    expect(SKILL.includes(CR), 'SKILL.md 에 CRLF 가 있습니다').toBe(false)
    expect(README.includes(CR), 'README.md 에 CRLF 가 있습니다').toBe(false)
  })

  it('3. 가드레일 표현을 지킨다 (REQ-10.3)', () => {
    for (const banned of ['해킹', '침투 테스트', '침투테스트', '공격해', '공격 시도', '취약점 공격']) {
      expect(SKILL, `SKILL.md 에 금지 표현: ${banned}`).not.toContain(banned)
      expect(README, `README.md 에 금지 표현: ${banned}`).not.toContain(banned)
    }
    expect(SKILL).toContain('자가점검')
    expect(README).toContain('자가점검')
  })

  it('4. 0~7단계가 전부 언급된다', () => {
    for (const step of ['0단계', '1단계', '2단계', '3단계', '4a단계', '4b단계', '5단계', '6단계', '7단계']) {
      expect(SKILL, `${step} 가 없습니다`).toContain(step)
    }
  })

  it('5. 스크립트 경로와 staging 을 언급한다 (REQ-5.25 · REQ-8.4)', () => {
    expect(SKILL).toContain('scripts/scan.mjs')
    expect(SKILL).toContain('scripts/render.mjs')
    expect(SKILL).toContain('.staging-')
    // 전역 경로를 임의로 뒤지지 않는다
    expect(SKILL).toContain('이 스킬 폴더')
    expect(SKILL).toMatch(/전역 경로를 임의로? 뒤지지 않는다|임의 탐색/)
  })

  it('6. 승인이 필요한 단계는 3단계뿐이고 0단계는 확인을 받지 않는다', () => {
    expect(SKILL).toMatch(/승인이 필요한 단계는 3단계\(빌드\)뿐이다/)
    expect(SKILL).toMatch(/0단계는 시작 확인을 받지 않고/)
  })

  it('7. 단계표가 spec §5.1 과 행 단위로 일치한다', () => {
    const fromSpec = specStepTable(readSpec())
    const fromSkill = stepTableOf(SKILL)
    expect(fromSpec.length, 'spec 단계표를 읽지 못했습니다').toBeGreaterThan(0)
    expect(fromSkill.length, 'SKILL.md 단계표를 읽지 못했습니다').toBe(fromSpec.length)
    for (let i = 0; i < fromSpec.length; i++) {
      expect(fromSkill[i], `${i + 1}번째 행이 spec 과 다릅니다`).toEqual(fromSpec[i])
    }
  })

  it('7. 대기·승인이 있는 단계의 무인 동작이 절차서에도 살아 있다', () => {
    const rows = stepTableOf(SKILL)
    const waiting = rows.filter((r) => r.waits.includes('있음'))
    expect(waiting.length).toBeGreaterThan(0)
    for (const r of waiting) {
      expect(r.headless, `${r.step}: 사람이 없을 때가 비어 있습니다`).not.toBe('')
      expect(r.headless).not.toBe('—')
    }
  })

  it('8. 판정 우선순위와 근거 필수를 적는다 (REQ-7.3 · REQ-7.7)', () => {
    expect(SKILL).toContain('검증된 fail')
    expect(SKILL).toContain('needs_human')
    expect(SKILL).toContain('교사확인 pass')
    expect(SKILL).toMatch(/근거가 1개 이상 필수/)
    expect(SKILL).toMatch(/demotion_reason/)
  })

  it('REQ-7.4 — 교사 답변이 검증된 fail 을 해제하지 못한다고 적는다', () => {
    expect(SKILL).toMatch(/교사 답변으로 해제되지 않는다/)
  })

  it('REQ-7.5 — 항목 판정이 하위 점검 중 최악이라고 적는다', () => {
    expect(SKILL).toMatch(/하위 점검 중 최악/)
    expect(SKILL).toMatch(/전부 `?na`? 면 항목도 `?na`?/)
  })

  it('REQ-7.9 — 확신이 없으면 fail 이 아니라 needs_human 이라고 적는다', () => {
    expect(SKILL).toMatch(/확신이 없으면 .*needs_human/)
    expect(SKILL).toMatch(/과잉 판정/)
  })

  it('REQ-7.17·7.18 — 제출물을 신뢰할 수 없는 입력으로 다룬다고 적는다', () => {
    expect(SKILL).toContain('신뢰할 수 없는 입력')
    expect(SKILL).toContain('20KB')
    expect(SKILL).toMatch(/지시는 따르지 않고 데이터로만/)
    expect(SKILL).toMatch(/sha256/)
  })

  it('REQ-5.3·5.4 — 5단계는 묻지 않고 6단계에서 끝난다고 적는다', () => {
    expect(SKILL).toMatch(/5단계는 질문을 던지지 않는다/)
    expect(SKILL).toMatch(/6단계까지 한 번의 실행에서 반드시 끝난다/)
  })

  it('REQ-5.14 — 사람이 없으면 빌드를 건너뛴다고 적는다', () => {
    expect(SKILL).toContain('non-interactive')
    expect(SKILL).toContain('prebuilt-artifact')
  })

  it('REQ-5.5 — 프로젝트 파일을 수정하지 않는다고 적는다', () => {
    expect(SKILL).toMatch(/프로젝트 파일을 수정하지 않는다/)
  })

  it('REQ-8.2·8.3 — .gitignore 권고와 기록 삭제 방법을 적는다', () => {
    expect(SKILL).toContain('edusafe-report/')
    expect(SKILL).toMatch(/\.gitignore/)
    expect(SKILL).toMatch(/폴더를 통째로 지운다/)
  })

  it('REQ-8.21 — Node 가 없으면 MD 를 직접 쓴다고 적는다', () => {
    expect(SKILL).toMatch(/MD 를 직접 작성한다/)
    expect(SKILL).toMatch(/아무 산출물도 남기지 않는 경우는 없다/)
  })

  it('REQ-7.21 — 점수를 매기지 않는다고 적는다', () => {
    expect(SKILL).toMatch(/점수를 매기지 않는다/)
    expect(SKILL).toMatch(/반드시 수정 항목 없음/)
  })

  it('데이터는 rules/ 에 있고 절차서에 항목을 복제하지 않는다 (REQ-4.1)', () => {
    expect(SKILL).toContain('rules/items.json')
    expect(SKILL).toContain('rules/session.json')
    // 절차서에 나타나도 되는 항목 id 는 §7.6 결정표의 것뿐이다.
    // 그 밖의 id 를 늘어놓으면 항목을 개정할 때 두 곳을 고치게 된다.
    const itemIds = JSON.parse(readFileSync('edusafe/rules/items.json', 'utf8')).items.map((i) => i.id)
    const allowed = new Set(severityRows(readSpec(), '### 7.6 effective_severity', '`[REQ-7.20]`').map((r) => r[0]))
    const extra = itemIds.filter((id) => SKILL.includes(id) && !allowed.has(id))
    expect(extra, '§7.6 결정표 밖의 항목 id 가 절차서에 하드코딩돼 있습니다').toEqual([])
  })

  it('effective_severity 결정표가 spec §7.6 과 일치한다 (REQ-7.20)', () => {
    const fromSpec = severityRows(readSpec(), '### 7.6 effective_severity', '`[REQ-7.20]`')
    const fromSkill = severityRows(SKILL, '### 중요도 조정', '### 종합 판정')
    expect(fromSpec.length, 'spec §7.6 표를 읽지 못했습니다').toBe(4)
    expect(fromSkill, 'SKILL.md 의 결정표가 spec 과 다릅니다').toEqual(fromSpec)
  })
  // REQ-5.3 은 "이 실행이 대화형인지 스킬은 스스로 판단할 수 없다" 고 못박는다.
  // 그러므로 절차서가 모드 판별을 전제한 분기를 지시하면 그 지시는 실행될 수 없다.
  // 실제로 1단계에 "대화형일 때만 묻는다" 를 넣었다가 이 문제로 되돌린 적이 있다.
  it('⑬ 절차서가 대화형 여부로 동작을 가르지 않는다 (REQ-5.3)', () => {
    const banned = ['대화형일 때만', '대화형이면', '비대화형이면', '대화형인 경우', '비대화형인 경우']
    for (const phrase of banned) {
      expect(SKILL, `SKILL.md 가 모드 판별을 전제합니다: "${phrase}" — REQ-5.3 상 판별할 수 없습니다`)
        .not.toContain(phrase)
    }
    // 판별할 수 없다는 사실 자체는 절차서에 남아 있어야 한다
    expect(SKILL).toMatch(/대화형인지 스스로 판단할 수 없다/)
  })
})

describe('README', () => {
  it('9. 버전을 하드코딩하지 않고 version.json 을 가리킨다 (REQ-13.3)', () => {
    expect(README).toContain('rules/version.json')
    const semvers = [...new Set(README.match(/\b\d+\.\d+\.\d+\b/g) || [])]
      .filter((v) => v !== version.edusafe_version)
    expect(semvers, `version.json 과 다른 버전 문자열이 있습니다: ${semvers.join(', ')}`).toEqual([])
  })

  it('10. 신뢰 경계 문구가 있다 (REQ-11.1)', () => {
    expect(README).toContain('이 보고서는 거울이지 증명서가 아닙니다 — 인증은 교육청 심사에서 코드를 직접 재검사합니다.')
    expect(README).toMatch(/인증 증거가 아닙니다/)
  })

  it('10. "남의 코드에는 쓰지 말 것" 경고가 있다 (REQ-10.5)', () => {
    expect(README).toMatch(/남의 코드/)
    expect(README).toMatch(/그대로 쓰지 마세요/)
  })

  it('설치 경로를 도구·OS별로 안내한다 (spec §10)', () => {
    expect(README).toContain('~/.claude/skills/edusafe/')
    expect(README).toContain('.agents/skills/edusafe/')
    expect(README).toContain('%USERPROFILE%')
    expect(README).toContain('/edusafe')
    expect(README).toContain('$edusafe')
  })

  it('빌드 승인 화면의 위험을 고지한다 (REQ-5.12)', () => {
    expect(README).toMatch(/임의 코드를 실행할 수 있고 이 컴퓨터의 환경변수·토큰에 접근할 수 있습니다/)
    expect(SKILL).toMatch(/임의 코드를 실행할 수 있고 이 컴퓨터의 환경변수·토큰에 접근할 수 있습니다/)
  })

  it('의존성 0 임을 알린다 (REQ-4.2)', () => {
    expect(README).toMatch(/npm install/)
    expect(README).toMatch(/내장 모듈만/)
  })

  it('산출물 위치와 .gitignore 권고를 안내한다 (REQ-8.2)', () => {
    expect(README).toContain('edusafe-report/')
    expect(README).toContain('.gitignore')
  })

  it('REQ-10.4 — 하지 않는 격리를 했다고 말하지 않는다', () => {
    // 빌드 시 네트워크 차단·환경변수 격리는 v0.1 비범위다. 한다고 적으면 거짓 안내가 된다.
    expect(README).not.toMatch(/네트워크를? 차단/)
    expect(README).not.toMatch(/환경변수를? 격리/)
    expect(SKILL).not.toMatch(/네트워크를? 차단/)
    expect(SKILL).not.toMatch(/환경변수를? 격리/)
  })
})

// Task 7 은 REQ 38개를 담당한다. 대부분 "절차서가 그렇게 지시하는가" 로만 확인할 수 있으므로
// REQ 별로 절차서에 반드시 남아야 하는 문구를 표로 두고 전수 확인한다.
describe('Task 7 이 담당하는 REQ 가 절차서에 살아 있다', () => {
  const REQUIRED = [
    ['REQ-5.1', ['0~6단계는 사람의 응답 없이 끝까지 진행한다']],
    ['REQ-5.6', ['.staging-', '지우고 새로 만든다']],
    ['REQ-5.7', ['node_modules', '2MB 초과', 'symlink']],
    ['REQ-5.8', ['sha256', '건너뛴 파일과 사유', '마스킹']],
    ['REQ-5.9', ['agent-fallback', '부재 증명 항목은 pass 할 수 없다']],
    ['REQ-5.10', ['--all', '120초', '200MB', 'shallow']],
    ['REQ-5.11', ['no-git']],
    ['REQ-5.13', ['10분', 'dist']],
    ['REQ-5.15', ['prebuilt-artifact', '현재 소스와 일치한다는 보장이 없다']],
    ['REQ-5.16', ['빌드가 필요한 하위 점검']],
    ['REQ-5.17', ['data_inventory', 'actors', 'entry', 'controller', 'student_facing', 'trusted_outcomes']],
    ['REQ-5.18', ['db_paths', 'destinations']],
    ['REQ-5.19', ['카테고리 순으로 판정', 'applicability']],
    ['REQ-5.20', ['negative_scan', '코드를 추적해 판정']],
    ['REQ-5.21', ['확인 후보', '기다리지 않는다']],
    ['REQ-5.22', ['계약 검증', 'history 이동']],
    ['REQ-5.23', ['항목 ID 고쳐줘', '보고서는 수정 전 상태']],
    ['REQ-5.24', ['답하지 않으셔도 보고서는 이미 완성돼 있습니다', '건너뛰기']],
    ['REQ-7.6', ['required_coverage']],
    ['REQ-7.19', ['모름', '직접 확인할 것']],
    ['REQ-7.23', ['커버리지 입력으로 쓴다', 'sources']],
    ['REQ-7.1', ['다섯 번째 값을 두지 않고']],
    ['REQ-7.2', ['verification_level', 'attested']],
    ['REQ-7.10', ['applicability_reason']],
    ['REQ-7.11', ['앞 6자']],
    ['REQ-7.12', ['200자 이내', '4개 이내']],
    ['REQ-7.15', ['secretValue', '그대로 판정 근거로 쓴다']],
    ['REQ-7.16', ['문서에서 발견(참고)']],
  ]

  for (const [req, phrases] of REQUIRED) {
    it(`${req} — 절차서에 지시가 남아 있다`, () => {
      const missing = phrases.filter((p) => !SKILL.includes(p))
      expect(missing, `${req}: 절차서에서 빠진 문구`).toEqual([])
    })
  }
})
