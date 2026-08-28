let csrfToken = "";
let criteria = [];
let policies = [];
let editingPolicyId = null;
let revokeUid = null;

const policyForm = document.querySelector("#policy-form");
const policyError = document.querySelector("#policy-error");
const criteriaList = document.querySelector("#criteria-list");
const safetyList = document.querySelector("#safety-list");
const policiesBody = document.querySelector("#policies-body");
const badgesBody = document.querySelector("#badges-body");
const revokeDialog = document.querySelector("#revoke-dialog");
const revokeForm = document.querySelector("#revoke-form");

function escapeHtml(value) {
  return String(value ?? "—").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function formatDate(value) { return value ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—"; }

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET") headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) { location.assign("/admin/login"); throw new Error("관리자 로그인이 필요합니다."); }
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error?.message ?? "요청을 완료하지 못했습니다.");
  return body;
}

function renderCriteria(safetyBlockers) {
  const requiredCriteria = criteria.filter((criterion) => criterion.requiredByRuleset);
  criteriaList.innerHTML = requiredCriteria.length > 0
    ? requiredCriteria.map((criterion) => `<div class="locked-item"><strong>필수 · ${escapeHtml(criterion.name)}</strong><br><span>criterionId: <code>${escapeHtml(criterion.criterionId)}</code></span><br><span>${escapeHtml(criterion.publicDescription)}</span><br><span>category: ${escapeHtml(criterion.category)} · version: ${escapeHtml(criterion.criterionVersion)} · evaluatorKey: <code>${escapeHtml(criterion.evaluatorKey)}</code></span><br><span>available: ${escapeHtml(criterion.available)} · active: ${escapeHtml(criterion.active)} · displayOrder: ${escapeHtml(criterion.displayOrder)}</span></div>`).join("")
    : `<p class="form-error">현재 ruleset에 적용할 수 있는 필수 심사 항목이 없습니다.</p>`;
  safetyList.innerHTML = safetyBlockers.map((blocker) => `<div class="locked-item">잠금 · ${escapeHtml(blocker.name)} · v${escapeHtml(blocker.version)}</div>`).join("");
}

function policyActions(policy) {
  const id = escapeHtml(policy.snapshot.policyId);
  if (policy.status === "DRAFT") return `<div class="actions"><button class="button-secondary" type="button" data-edit-policy="${id}">수정</button><button type="button" data-publish-policy="${id}">발행</button></div>`;
  return `<button class="button-secondary" type="button" data-clone-policy="${id}">새 초안으로 복제</button>`;
}

function renderPolicies() {
  if (policies.length === 0) { policiesBody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><p>정책이 없습니다.</p><a href="#policy-form">첫 초안 만들기</a></div></td></tr>`; return; }
  policiesBody.innerHTML = policies.map((policy) => `<tr><td class="tabular">v${escapeHtml(policy.snapshot.policyVersion)}</td><td><strong>${escapeHtml(policy.snapshot.name)}</strong><br><small>${escapeHtml(policy.snapshot.rulesetVersion)}</small></td><td><span class="status-badge">${escapeHtml(policy.status)}</span></td><td>${escapeHtml(policy.snapshot.criteria.length)}개</td><td><code>${escapeHtml(policy.snapshot.policyHash)}</code></td><td>${policyActions(policy)}</td></tr>`).join("");
}

function renderBadges(badges) {
  if (badges.length === 0) { badgesBody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><p>발급 내역이 없습니다.</p><a href="/">첫 인증 요청 보기</a></div></td></tr>`; return; }
  badgesBody.innerHTML = badges.map((badge) => {
    const criteriaItems = badge.criteria.map((item) => `<li><code>${escapeHtml(item.criterionId)}</code> v${escapeHtml(item.criterionVersion)} · ${escapeHtml(item.result)}</li>`).join("");
    const safetyItems = badge.safetyBlockers.map((item) => `<li>${escapeHtml(item.name)} · ${item.triggered ? "BLOCK" : "PASS"}</li>`).join("");
    return `<tr><td><a href="${escapeHtml(badge.repository.canonicalRepositoryUrl)}" rel="noreferrer">${escapeHtml(badge.repository.owner)}/${escapeHtml(badge.repository.name)}</a><br><small>repositoryId: <span class="tabular">${escapeHtml(badge.repository.repositoryId)}</span></small><br><code>${escapeHtml(badge.commitSha)}</code></td><td>v${escapeHtml(badge.policy.policyVersion)}<details><summary>${escapeHtml(badge.criteria.length)}개 항목 및 안전 조건</summary><ul>${criteriaItems}${safetyItems}</ul></details></td><td><a href="/verify/${escapeHtml(badge.uid)}"><code>${escapeHtml(badge.uid)}</code></a><br><code>${escapeHtml(badge.attester)}</code></td><td>발급 ${escapeHtml(formatDate(badge.issuedAt))}<br><small>만료 ${escapeHtml(formatDate(badge.expiresAt))}</small><br><small>취소 ${escapeHtml(formatDate(badge.revokedAt))}</small></td><td><span class="status-badge" data-status="${escapeHtml(badge.status)}">${escapeHtml(badge.status)}</span></td><td>${badge.revokedAt ? "취소됨" : `<button class="button-danger" type="button" data-revoke="${escapeHtml(badge.uid)}">취소</button>`}</td></tr>`;
  }).join("");
}

function loadIntoForm(policy, clone = false) {
  editingPolicyId = clone ? null : policy.snapshot.policyId;
  document.querySelector("#policy-name").value = clone ? `${policy.snapshot.name} 후속` : policy.snapshot.name;
  document.querySelector("#save-policy").textContent = clone ? "새 초안 생성" : "초안 변경 저장";
  policyForm.scrollIntoView({ block: "start" });
}

async function reload() {
  const [criteriaBody, policiesBodyResponse, badgesBodyResponse] = await Promise.all([
    api("/api/admin/certification/criteria"), api("/api/admin/certification/policies"), api("/api/admin/certification/badges"),
  ]);
  criteria = criteriaBody.criteria; policies = policiesBodyResponse.policies;
  renderCriteria(criteriaBody.safetyBlockers); renderPolicies(); renderBadges(badgesBodyResponse.badges);
}

policyForm?.addEventListener("submit", async (event) => {
  event.preventDefault(); policyError.textContent = "";
  const name = document.querySelector("#policy-name").value;
  try {
    if (editingPolicyId) await api(`/api/admin/certification/policies/${editingPolicyId}`, { method: "PUT", body: JSON.stringify({ name }) });
    else await api("/api/admin/certification/policies", { method: "POST", body: JSON.stringify({ name }) });
    editingPolicyId = null; policyForm.reset(); document.querySelector("#save-policy").textContent = "새 초안 생성"; await reload();
  } catch (error) { policyError.textContent = error instanceof Error ? error.message : "정책을 저장하지 못했습니다."; }
});

policiesBody?.addEventListener("click", async (event) => {
  const target = event.target.closest("button"); if (!target) return;
  const editId = target.dataset.editPolicy; const cloneId = target.dataset.clonePolicy; const publishId = target.dataset.publishPolicy;
  const selected = policies.find((policy) => policy.snapshot.policyId === (editId ?? cloneId ?? publishId)); if (!selected) return;
  if (editId) loadIntoForm(selected); else if (cloneId) loadIntoForm(selected, true); else if (publishId) {
    try { target.disabled = true; await api(`/api/admin/certification/policies/${publishId}/publish`, { method: "POST", body: "{}" }); await reload(); }
    catch (error) { policyError.textContent = error instanceof Error ? error.message : "정책을 발행하지 못했습니다."; }
    finally { target.disabled = false; }
  }
});

badgesBody?.addEventListener("click", (event) => { const target = event.target.closest("button[data-revoke]"); if (!target) return; revokeUid = target.dataset.revoke; document.querySelector("#revoke-reason").value = "ISSUED_IN_ERROR"; document.querySelector("#revoke-error").textContent = ""; revokeDialog.showModal(); });
document.querySelector("#cancel-revoke")?.addEventListener("click", () => revokeDialog.close());
revokeForm?.addEventListener("submit", async (event) => {
  event.preventDefault(); if (!revokeUid) return;
  const reason = document.querySelector("#revoke-reason").value;
  try { await api(`/api/admin/certification/badges/${revokeUid}/revoke`, { method: "POST", body: JSON.stringify({ reason }) }); revokeDialog.close(); revokeUid = null; await reload(); }
  catch (error) { document.querySelector("#revoke-error").textContent = error instanceof Error ? error.message : "인증을 취소하지 못했습니다."; }
});

document.querySelector("#logout")?.addEventListener("click", async () => { try { await api("/api/admin/session", { method: "DELETE" }); } finally { location.assign("/admin/login"); } });

async function initialize() {
  try { const session = await api("/api/admin/session"); csrfToken = session.csrfToken; await reload(); }
  catch (error) { policyError.textContent = error instanceof Error ? error.message : "관리자 데이터를 불러오지 못했습니다."; }
}

void initialize();
