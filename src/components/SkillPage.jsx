// 트랙 1 — 교사용 자가점검 스킬 배포 안내.
// 버전·해시는 skill/dist/manifest.json 에서 계산된 공식 값이며, public/download/ 의
// 파일과 같은 배포본을 가리킨다. 스킬을 다시 빌드하면 이 세 값도 함께 고쳐야 한다.
const VERSION = '0.1.0'
const ZIP_SHA256 = 'ba50fad8d63986b8e0689ea5888ae5c3c57fe8a3116640dc24e14dc189684717'
const SKILL_DIGEST = 'sha256:da7c4ee9f853a7a78c883c19051294e70e0175ce4fdb7e2a4df33e2ad807ba86'
// 게시 파일명은 버전을 빼고 `edusafe.zip` 으로 둔다. 압축을 풀면 대부분의 도구가
// 파일명과 같은 폴더를 만들기 때문에, 교사가 이름을 바꾸지 않아도 바로 `edusafe/` 가
// 나온다. zip 안에 edusafe/ 를 한 겹 넣는 방법은 Windows 에서 edusafe-v0.1.0\edusafe\
// 처럼 두 겹이 되어 오히려 나쁘다. 빌드 산출물 이름(edusafe-v<버전>.zip)은 REQ-13.1
// 이 정한 대로 유지하고, 게시할 때만 이름을 바꿔 복사한다. 바이트는 같으므로
// ZIP_SHA256 도 그대로다.
const ZIP_PATH = '/download/edusafe.zip'
const SHA_PATH = '/download/edusafe.sha256'

const CATEGORIES = [
  { name: '1. 수집', note: '무엇을 모으나' },
  { name: '2. 접근·권한', note: '누가 무엇을 할 수 있나' },
  { name: '3. 비밀·파일 노출', note: '저장소·번들·히스토리에 뭐가 있나' },
  { name: '4. 제3자 전송·추적', note: '데이터가 어디로 나가나' },
  { name: '5. 화면·로그 노출', note: '눈에 어디까지 보이나' },
  { name: '6. 코드 안전', note: '주입·검증 취약점' },
  { name: '7. 고지·보유·파기', note: '알리고, 지키고, 지우나' },
  { name: '8. 학생 안전', note: '미성년 보호 장치' },
]

const INSTALL = [
  { tool: 'Claude Code', path: '~/.claude/skills/edusafe/', call: '/edusafe' },
  { tool: 'Claude Code (Windows)', path: '%USERPROFILE%\\.claude\\skills\\edusafe\\', call: '/edusafe' },
  { tool: 'Codex CLI', path: '~/.agents/skills/edusafe/', call: '$edusafe' },
  { tool: 'Codex CLI (Windows)', path: '%USERPROFILE%\\.agents\\skills\\edusafe\\', call: '$edusafe' },
]

const OUTPUTS = [
  {
    icon: '📄',
    title: '한 장짜리 HTML 보고서',
    body: '인터넷 없이 열립니다. 자바스크립트가 없고 외부에서 아무것도 불러오지 않습니다. 인쇄·PDF 저장할 때 접어 둔 내용을 모두 펼칠지 고를 수 있어, 학교운영위원회 제출 자료로 그대로 쓸 수 있습니다.',
  },
  {
    icon: '🚦',
    title: '점수가 아니라 다섯 줄',
    body: '반드시 수정 / 권장 / 참고 / 판단불가 / 교사 확인. 앱을 서열화하는 단일 점수는 없습니다.',
  },
  {
    icon: '🔍',
    title: '근거가 붙습니다',
    body: '파일·줄 위치와 코드 인용, 그리고 근거 법령 조항. 시크릿은 저장 전에 마스킹됩니다.',
  },
  {
    icon: '🛠️',
    title: '코드를 고치지 않습니다',
    body: '점검만 합니다. 수정을 원하시면 보고서를 본 뒤 따로 요청하세요. 검사는 파일과 git 기록만 읽습니다.',
  },
]

export default function SkillPage() {
  return (
    <div className="about">
      <section className="hero">
        <h1>선생님이 직접,<br />배포하기 전에 점검하세요</h1>
        <p className="intro">
          <strong>에듀세이프 스킬</strong>은 선생님이 만든 교육용 앱을 <strong>선생님 컴퓨터에서, 선생님 구독으로</strong>{' '}
          배포 전에 점검하는 도구입니다. 개인정보 보호법과 안전성 확보조치 기준을 기준으로
          무엇을 고쳐야 하는지 근거와 함께 알려 드립니다. 코드를 어디로도 보내지 않습니다.
        </p>

        <div className="skill-get">
          <a className="btn-primary" href={ZIP_PATH} download>⬇️ 스킬 내려받기 (258KB)</a>
          <div className="skill-get-meta">
            버전 <strong>v{VERSION}</strong> · 설치할 의존성 없음<br />
            Claude Code 또는 Codex CLI 필요 · Node 18+ 권장
          </div>
        </div>
      </section>

      <section className="about-section">
        <h2>무엇을 점검하나</h2>
        <p className="intro">
          8개 카테고리 <strong>37개 항목</strong>, 하위 점검 134개. 항목마다 법령·고시·안내서의 근거를 조항 단위로 달았습니다.
        </p>
        <div className="skill-cats">
          {CATEGORIES.map((c) => (
            <div key={c.name} className="skill-cat">
              <b>{c.name}</b>
              <span>{c.note}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="about-section">
        <h2>어떻게 쓰나</h2>
        <p className="intro">
          압축을 풀어 나온 <code>edusafe</code> 폴더를 통째로 아래 위치에 놓고, 도구를 새로 실행하면 인식됩니다.
        </p>
        <table className="skill-install">
          <thead>
            <tr><th>도구</th><th>놓을 위치</th><th>부르는 법</th></tr>
          </thead>
          <tbody>
            {INSTALL.map((r) => (
              <tr key={r.tool}>
                <td>{r.tool}</td>
                <td><code>{r.path}</code></td>
                <td><code>{r.call}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="intro skill-note">
          점검할 앱 폴더에서 도구를 열고 <code>/edusafe</code> 라고 하면 나머지는 스킬이 진행합니다.
          실제 앱(파일 864개·커밋 842개)에서 <strong>보고서까지 약 22분</strong> 걸렸습니다.
        </p>
      </section>

      <section className="about-section">
        <h2>무엇이 나오나</h2>
        <div className="card-grid">
          {OUTPUTS.map((o) => (
            <div key={o.title} className="info-card">
              <div className="info-icon">{o.icon}</div>
              <strong>{o.title}</strong>
              <p>{o.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="about-section">
        <h2>받으신 파일이 맞는지 대조하세요</h2>
        <p className="intro">
          이 값들은 배포본에서 계산한 공식 값입니다. 내려받은 zip 의 해시가 아래와 다르면 그 파일을 쓰지 마세요.
        </p>
        <div className="skill-hashes">
          <dl>
            <div><dt>버전</dt><dd>{VERSION}</dd></div>
            <div>
              <dt>ZIP SHA-256</dt>
              <dd>{ZIP_SHA256} (<a href={SHA_PATH}>파일로 받기</a>)</dd>
            </div>
            <div><dt>공식 스킬 지문</dt><dd>{SKILL_DIGEST}</dd></div>
            <div>
              <dt>구성 대조 자료</dt>
              <dd><a href="/download/manifest.json">manifest.json</a> — 파일별 해시 11개</dd>
            </div>
          </dl>
        </div>
        <p className="intro skill-note skill-note-muted">
          보고서에도 스킬 지문이 찍힙니다. 그 값이 위 <strong>공식 스킬 지문</strong>과 같아야
          손대지 않은 스킬로 점검한 것입니다.
        </p>
      </section>

      <section className="about-section">
        <h2>알려진 한계 (v0.1)</h2>
        <div className="skill-limits">
          <h3>이 판이 아직 못 하는 것을 그대로 적습니다.</h3>
          <ul>
            <li>
              <strong>"앞으로 하겠다"는 답은 아직 "미충족"으로 잡힙니다.</strong>{' '}
              동의를 받으실 예정이거나 학교운영위원회 심의를 앞두고 계시면, 순서를 옳게 잡고 계셔도
              "반드시 수정"에 올라올 수 있습니다. 그 항목의 판정 근거를 읽어 보시고, 계획대로
              진행 중이라면 그대로 두셔도 됩니다.
            </li>
            <li>
              <strong>사람 없이 자동으로 돌리는 실행(<code>claude -p</code>)은 아직 검증하지 못했습니다.</strong>{' '}
              대화형 실행은 실제 앱에서 완주를 확인했지만, 무인 실행은 마감 전에 시험을 마치지
              못했습니다. 자동화에 넣으실 계획이라면 먼저 작은 앱으로 확인해 보세요.
            </li>
            <li>
              <strong>정식 지원 스택은 HTML/JS · React/Vite · Next.js 에 Firebase 또는 Supabase 조합입니다.</strong>{' '}
              그 밖의 스택에서는 스택과 무관한 항목만 판정하고, 스택 특화 항목은 "판단불가"로 남습니다.
            </li>
            <li>
              <strong>남의 코드에는 쓰지 마세요.</strong> "내가 만든 앱을 내가 점검한다"를 전제로
              만들어졌습니다. 점검이 필요하면 그 코드의 주인에게 이 페이지를 안내해 직접 돌리게 하세요.
            </li>
          </ul>
        </div>
      </section>
    </div>
  )
}
