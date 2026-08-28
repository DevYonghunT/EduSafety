const root = document.querySelector("#verification");
const uid = decodeURIComponent(location.pathname.split("/").filter(Boolean).at(-1) ?? "");

function escapeHtml(value) {
  return String(value ?? "—").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function formatDate(value) {
  return value ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "없음";
}

async function loadVerification() {
  try {
    const response = await fetch(`/api/badges/${encodeURIComponent(uid)}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message ?? "인증을 확인하지 못했습니다.");
    const badge = body.badge;
    const criteria = badge.criteria.map((criterion) => `<li><span><strong>${escapeHtml(criterion.criterionId)}</strong><br><small>v${escapeHtml(criterion.criterionVersion)}</small></span><strong>${escapeHtml(criterion.result)}</strong></li>`).join("");
    const proofJson = escapeHtml(JSON.stringify(badge.proof, null, 2));
    const verifyUrl = `${location.origin}/verify/${badge.uid}`;
    const svgUrl = `${location.origin}/api/badges/${badge.uid}.svg?variant=showcase`;
    const snippet = `<a href="${verifyUrl}"><img src="${svgUrl}" alt="EduSafety certification" /></a>`;
    const headMatchLabel = badge.headMatches === true ? "일치" : badge.headMatches === false ? "불일치" : "확인 불가";
    root.innerHTML = `
      <div class="content-column">
        <section class="card">
          <span class="status-badge" data-status="${escapeHtml(badge.status)}">${escapeHtml(badge.status)}</span>
          <h2>${escapeHtml(badge.reason)}</h2>
          <dl class="data-list">
            <dt>저장소</dt><dd><a href="${escapeHtml(badge.repository.canonicalRepositoryUrl)}" rel="noreferrer">${escapeHtml(badge.repository.canonicalRepositoryUrl)}</a></dd>
            <dt>Exact commit</dt><dd><code>${escapeHtml(badge.commitSha)}</code></dd>
            <dt>현재 HEAD</dt><dd><code>${escapeHtml(badge.currentHead)}</code></dd>
            <dt>HEAD 일치 여부</dt><dd>${escapeHtml(headMatchLabel)}</dd>
            <dt>정책</dt><dd>${escapeHtml(badge.policy.name)} · v${escapeHtml(badge.policy.policyVersion)}</dd>
            <dt>발급자</dt><dd><code>${escapeHtml(badge.attester)}</code></dd>
            <dt>발급 시각</dt><dd>${escapeHtml(formatDate(badge.issuedAt))}</dd>
            <dt>만료 시각</dt><dd>${escapeHtml(formatDate(badge.expiresAt))}</dd>
            <dt>취소 시각</dt><dd>${escapeHtml(formatDate(badge.revokedAt))}</dd>
          </dl>
        </section>
        <section class="card"><h2>고정 심사 항목</h2><p class="card-copy">발급 당시 서버 기준에 고정된 전체 필수 항목입니다.</p><ul class="check-list">${criteria}</ul></section>
        <section class="card"><h2>독립 검증 proof</h2><p class="card-copy">domain, types, message, signature, UID와 안전한 snapshot을 포함합니다.</p><details><summary>전체 proof 보기</summary><pre>${proofJson}</pre></details></section>
      </div>
      <aside class="content-column">
        <section class="card"><h2>Showcase</h2><a href="${escapeHtml(verifyUrl)}" aria-label="EduSafety 인증마크 검증 페이지 열기"><img class="responsive-image" src="${escapeHtml(svgUrl)}" alt="EduSafety 인증마크" width="560" height="172"></a><p class="card-copy">인증마크를 클릭하면 이 검증 페이지로 연결할 수 있습니다.</p></section>
        <section class="card"><h2>README 삽입</h2><label class="field-label" for="readme-code">HTML 코드</label><textarea class="snippet" id="readme-code" readonly>${escapeHtml(snippet)}</textarea><button class="button-secondary" id="copy-snippet" type="button">코드 복사</button><p class="inline-error" id="copy-status" aria-live="polite"></p></section>
      </aside>`;
    document.querySelector("#copy-snippet")?.addEventListener("click", async () => {
      const status = document.querySelector("#copy-status");
      try { await navigator.clipboard.writeText(snippet); status.textContent = "복사했습니다."; }
      catch { status.textContent = "복사할 수 없습니다. 텍스트를 직접 선택해 주세요."; }
    });
  } catch (error) {
    root.innerHTML = `<section class="card"><span class="status-badge" data-status="INVALID">확인 불가</span><h2>${escapeHtml(error instanceof Error ? error.message : "인증을 확인하지 못했습니다.")}</h2><a class="button" href="/">홈으로 돌아가기</a></section>`;
  }
}

void loadVerification();
