import type { VerificationResult } from "../certification/verification-service.js";

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;",
    };
    return entities[character] ?? character;
  });
}

export function renderShowcaseSvg(result: VerificationResult): string {
  const { badge, status } = result;
  const passLike = status === "VALID";
  const heading = passLike ? "CERTIFIED" : status;
  const reviewLabel = result.integrityValid ? "REVIEW PASSED" : "VERIFICATION FAILED";
  const color = passLike ? "#166534" : status === "STALE" ? "#92400e" : "#991b1b";
  const surface = passLike ? "#f0fdf4" : status === "STALE" ? "#fffbeb" : "#fef2f2";
  const criteria = `${badge.report.criteriaResults.length} SELECTED CHECKS PASSED`;
  const commit = badge.report.commitSha.slice(0, 7);
  const policy = `POLICY v${badge.report.policy.policyVersion}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="172" viewBox="0 0 560 172" role="img" aria-labelledby="title desc">
  <title id="title">EduSafety ${escapeXml(heading)}</title>
  <desc id="desc">${escapeXml(criteria)}, commit ${escapeXml(commit)}, ${escapeXml(policy)}, EAS signed, gasless</desc>
  <rect width="560" height="172" rx="16" fill="#ffffff"/>
  <rect x="1" y="1" width="558" height="170" rx="15" fill="none" stroke="#cbd5e1" stroke-width="2"/>
  <rect x="24" y="24" width="56" height="56" rx="14" fill="${surface}"/>
  <path d="M41 52l8 8 16-18" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="100" y="46" fill="${color}" font-family="Arial, sans-serif" font-size="13" font-weight="700">${escapeXml(heading)}</text>
  <text x="100" y="73" fill="#0f172a" font-family="Arial, sans-serif" font-size="22" font-weight="700">${reviewLabel}</text>
  <text x="24" y="112" fill="#475569" font-family="Arial, sans-serif" font-size="13">${escapeXml(criteria)}</text>
  <text x="24" y="140" fill="#0f172a" font-family="monospace" font-size="13">${escapeXml(commit)}</text>
  <text x="110" y="140" fill="#475569" font-family="Arial, sans-serif" font-size="13">${escapeXml(policy)}</text>
  <text x="364" y="140" fill="#166534" font-family="Arial, sans-serif" font-size="12" font-weight="700">EAS SIGNED · GASLESS</text>
</svg>`;
}
