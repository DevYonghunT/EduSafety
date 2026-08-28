import { DATA_NOTICE_POINTS } from '../lib/dataNotice.js'

const WHY = [
  { icon: '⛰️', title: '우매한 봉우리 문제', body: '바이브 코딩은 전문성 없이도 "작동하는 앱"을 즉시 만들어 줍니다. 화면이 돌아가는 순간 만든 사람은 자신이 무엇을 모르는지 모르는 지점에 서게 되고, 절벽 아래에 있는 것은 학생의 개인정보입니다.' },
  { icon: '🧒', title: '학생 데이터가 걸려 있다', body: '교사 제작 앱은 감정 기록·성적·이름 같은 민감정보를 자주 다룹니다. 만든 교사도 검증할 전문성이 없고, 검증해 줄 공적 체계도 없습니다.' },
  { icon: '⚖️', title: '법은 이미 요구하고 있다', body: '초·중등교육법 제29조의2(2026-03 시행)는 학습지원 소프트웨어의 선정기준 준수와 학교운영위원회 심의를 요구합니다. 그런데 그 심의를 뒷받침할 증거 인프라가 비어 있습니다.' },
  { icon: '🔍', title: '자기신고가 아니라 증거', body: '자가점검은 "정직한 답변"을 전제하지만, 심사는 "통과하고 싶은 사람"을 전제해야 합니다. 이 시스템은 코드에서 수집한 증거로 판정합니다.' },
]

const FLOW = [
  { step: '①', title: '불러오기 + 규칙 스캔', body: 'GitHub 저장소를 불러와 커밋 SHA에 심사를 고정하고, 결정적 규칙으로 비밀키·열린 DB 등을 스캔합니다. API 키 없이 실행됩니다.' },
  { step: '②', title: 'AI 분류 추론', body: '4트랙(교무·행정/교과 도구/학습 콘텐츠/학급 운영) 중 하나를 AI가 근거와 함께 제안하고, 심사자가 확정합니다. 보호 수준(L0~L2)이 기능에서 자동 도출됩니다.' },
  { step: '③', title: '루브릭 판정 초안', body: 'AI가 항목별 판정 초안을 작성합니다. 근거 코드 인용이 강제되며, 근거가 확인되지 않으면 자동으로 판단불가로 강등됩니다.' },
  { step: '④', title: '심사자 승인·번복', body: '항목별로 심사자가 확인합니다. 번복은 사유와 함께 기록 보존됩니다. 최종 판정은 언제나 사람입니다.' },
  { step: '⑤', title: '보고서·보완 요청서', body: '커밋 SHA가 각인된 보고서와, 판단불가 항목을 원인별로 정리한 보완 요청서가 발급됩니다.' },
]

const TRUST = [
  { icon: '📌', title: '커밋 SHA 고정', body: '"이 심사는 커밋 X에 대한 것" — 인증 후 코드를 수정하면 지문이 달라져 변조가 증명됩니다.' },
  { icon: '🚫', title: '근거 없는 판정은 강등', body: 'AI가 근거 인용 없이 충족/미충족을 판정하면 검증 함수가 자동으로 판단불가로 강등합니다. 원칙은 문서가 아니라 테스트로 강제됩니다.' },
  { icon: '🎭', title: '점수가 아니라 상태', body: '앱을 서열화하는 단일 점수는 없습니다. 카테고리별 상태와 "반드시 수정 n건" 같은 행동 중심 요약만 제공합니다.' },
  { icon: '🔒', title: '심사 도구 스스로 규칙 준수', body: '학생 데이터 파일은 AI에 전송하지 않고, 비밀키는 마스킹 후 전송하며, AI가 검토하지 못한 범위는 정직하게 고지합니다.' },
]

const LAWS = [
  { name: '초·중등교육법 제29조의2 + 학습지원 SW 선정기준', note: '이 심사의 법적 존재 이유 — 선정기준 준수·학운위 심의를 법률이 요구' },
  { name: '개인정보 보호법', note: '최소수집(16조)·만 14세 동의(22조의2)·주민번호(24조의2)·안전조치(29조)·파기(21조)' },
  { name: 'AI 기본법 (2026-07-21 현행)', note: '유·초·중등 학생 평가 AI는 고영향 인공지능' },
  { name: '개인정보의 안전성 확보조치 기준 (개보위 고시)', note: '접근통제·암호화·인증정보 보호' },
  { name: '교육부 개인정보 보호지침(훈령 476호)·교육분야 AI 윤리원칙', note: '학교·교육기관 직접 적용 규범' },
  { name: 'KISA 개발보안 가이드 / CWE', note: '보안약점의 공인 분류 — 자동 스캔 규칙의 근거' },
]

export default function AboutPage({ onStart }) {
  return (
    <div className="about">
      <section className="hero">
        <h1>선생님이 만든 앱,<br />증거로 검증합니다</h1>
        <p className="intro">
          에듀 세이프는 교사가 바이브 코딩으로 만든 앱을 공인 기관의 심사자가 심사하기 위한
          심사자 전용 시스템입니다. AI가 코드에서 증거를 수집해 판정 초안을 만들고,
          최종 판정은 사람이 합니다.
        </p>
        <button className="btn-primary" onClick={onStart}>⚖️ 심사 시작하기</button>
      </section>

      <section className="about-section">
        <h2>왜 필요한가</h2>
        <div className="card-grid">
          {WHY.map((c) => (
            <div key={c.title} className="info-card">
              <div className="info-icon">{c.icon}</div>
              <strong>{c.title}</strong>
              <p>{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="about-section">
        <h2>심사 흐름</h2>
        <ol className="flow-list">
          {FLOW.map((f) => (
            <li key={f.step}>
              <span className="flow-step">{f.step}</span>
              <div><strong>{f.title}</strong><p>{f.body}</p></div>
            </li>
          ))}
        </ol>
      </section>

      <section className="about-section">
        <h2>신뢰의 장치</h2>
        <div className="card-grid">
          {TRUST.map((c) => (
            <div key={c.title} className="info-card">
              <div className="info-icon">{c.icon}</div>
              <strong>{c.title}</strong>
              <p>{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="about-section">
        <h2>제출된 코드는 어떻게 처리되나 (제작 교사님께)</h2>
        <ul className="law-list">
          {DATA_NOTICE_POINTS.map((p) => (
            <li key={p.title}><strong>{p.title}</strong> — {p.body}</li>
          ))}
        </ul>
        <p className="hint">같은 내용이 심사 화면의 "제출 교사용 안내문"과 심사 보고서에도 표기됩니다 — 심사 도구가 스스로 개인정보 원칙을 지킵니다.</p>
      </section>

      <section className="about-section">
        <h2>심사 기준의 법령·공식 근거</h2>
        <ul className="law-list">
          {LAWS.map((l) => (
            <li key={l.name}><strong>{l.name}</strong> — {l.note}</li>
          ))}
        </ul>
        <p className="hint">모든 루브릭 항목에 법적 무게(법률/고시·훈령/공식 권고/모범 사례)를 표기해 "법적 의무"와 "권고"를 섞어 말하지 않습니다.</p>
      </section>

      <section className="about-cta">
        <p>심사할 앱이 있다면, 저장소 주소 하나로 시작할 수 있습니다.</p>
        <button className="btn-primary" onClick={onStart}>⚖️ 심사 시작하기</button>
      </section>
    </div>
  )
}
