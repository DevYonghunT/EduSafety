const form = document.querySelector("#issue-form");
const errorElement = document.querySelector("#issue-error");
const resultElement = document.querySelector("#issue-result");
const submitButton = document.querySelector("#issue-submit");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorElement.textContent = "";
  resultElement.replaceChildren();
  if (!form.reportValidity()) return;
  submitButton.disabled = true;
  submitButton.textContent = "정적 분석 중…";
  const data = new FormData(form);
  try {
    const response = await fetch("/api/badges/issue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryUrl: data.get("repositoryUrl"), commitSha: data.get("commitSha") }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message ?? "요청을 완료하지 못했습니다.");
    if (body.outcome === "NOT_ISSUED") {
      const failed = body.criteria.filter((criterion) => criterion.result !== "PASS").length;
      const blocked = body.safetyBlockers.filter((blocker) => blocker.triggered).length;
      resultElement.innerHTML = `<strong>인증마크가 발급되지 않았습니다.</strong><p>필수 항목 미통과 ${escapeHtml(failed)}개, 안전 차단 ${escapeHtml(blocked)}개를 확인하세요.</p>`;
      return;
    }
    const badge = body.badge;
    resultElement.innerHTML = `<strong>${body.existing ? "기존 인증을 확인했습니다." : "인증마크가 발급됐습니다."}</strong><p>상태: ${escapeHtml(badge.status)} · commit ${escapeHtml(badge.commitSha.slice(0, 7))}</p><a class="button" href="${escapeHtml(body.verificationUrl)}">공개 검증 보기</a>`;
  } catch (error) {
    errorElement.textContent = error instanceof Error ? error.message : "요청을 완료하지 못했습니다.";
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "정적 분석 후 인증 요청";
  }
});
