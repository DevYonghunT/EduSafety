import { promises as dns } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { TLSSocket } from "node:tls";
import type { IncomingHttpHeaders } from "node:http";

export type SecurityFindingSeverity = "high" | "medium" | "low" | "info";
export type SecurityFindingStatus = "pass" | "warning" | "fail";
export type SecurityRiskLevel = "high" | "medium" | "low" | "minimal";
export type SecurityScanAiStatus = "not_requested" | "used" | "failed" | "busy";

export interface SecurityFinding {
  readonly id: string;
  readonly title: string;
  readonly severity: SecurityFindingSeverity;
  readonly status: SecurityFindingStatus;
  readonly evidence: string;
  readonly remediation: string;
}

export interface SecurityScanAiSummary {
  readonly used: boolean;
  readonly status: SecurityScanAiStatus;
  readonly overview: string;
  readonly riskLevel: SecurityRiskLevel;
  readonly priorityActions: readonly string[];
}

export interface SecurityScanResult {
  readonly targetUrl: string;
  readonly targetOrigin: string;
  readonly checkedAt: string;
  readonly httpStatus: number;
  readonly tls: {
    readonly protocol: string;
    readonly certificateValidTo: string | null;
  };
  readonly summary: string;
  readonly counts: {
    readonly passed: number;
    readonly high: number;
    readonly medium: number;
    readonly low: number;
    readonly info: number;
  };
  readonly findings: readonly SecurityFinding[];
  readonly ai: SecurityScanAiSummary;
  readonly sourceSummary: {
    readonly contentType: string | null;
    readonly analyzed: boolean;
    readonly bytesInspected: number;
    readonly truncated: boolean;
    readonly scriptCount: number;
    readonly formCount: number;
  };
  readonly limitations: readonly string[];
}

export interface SecurityScanRunner {
  scan(
    targetUrl: string,
    safetyIdentifier: string,
    summarize?: SecurityScanSummarizer,
  ): Promise<SecurityScanResult>;
}

export type SecurityScanErrorCode =
  | "SECURITY_SCAN_TARGET_NOT_ALLOWED"
  | "SECURITY_SCAN_TARGET_BLOCKED"
  | "SECURITY_SCAN_DNS_FAILED"
  | "SECURITY_SCAN_TLS_CERTIFICATE_INVALID"
  | "SECURITY_SCAN_TLS_HANDSHAKE_FAILED"
  | "SECURITY_SCAN_TARGET_UNREACHABLE";

export class SecurityScanError extends Error {
  public constructor(
    public readonly code: SecurityScanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SecurityScanError";
  }
}

interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

interface ProbeResult {
  readonly httpStatus: number;
  readonly headers: IncomingHttpHeaders;
  readonly tlsProtocol: string;
  readonly certificateValidTo: string | null;
  readonly source?: {
    readonly contentType: string | null;
    readonly bytesInspected: number;
    readonly truncated: boolean;
    readonly html: string | null;
  };
}

export interface SecuritySummaryInput {
  readonly targetOrigin: string;
  readonly riskLevel: SecurityRiskLevel;
  readonly findings: readonly SecurityFinding[];
  readonly safetyIdentifier: string;
}

export interface SecuritySummaryOutput {
  readonly overview: string;
  readonly priorityActions: readonly string[];
}

export type SecurityScanSummarizer = (
  input: SecuritySummaryInput,
  signal?: AbortSignal,
) => Promise<SecuritySummaryOutput>;

export async function applySecurityScanSummary(
  scan: SecurityScanResult,
  safetyIdentifier: string,
  summarize: SecurityScanSummarizer,
  signal?: AbortSignal,
): Promise<SecurityScanResult> {
  try {
    const generated = await summarize({
      targetOrigin: scan.targetOrigin,
      riskLevel: scan.ai.riskLevel,
      findings: scan.findings,
      safetyIdentifier,
    }, signal);
    return {
      ...scan,
      ai: {
        used: true,
        status: "used",
        overview: generated.overview,
        riskLevel: scan.ai.riskLevel,
        priorityActions: generated.priorityActions.slice(0, 3),
      },
    };
  } catch {
    // The deterministic scan remains useful when the optional AI summary is unavailable.
    return {
      ...scan,
      ai: { ...scan.ai, used: false, status: "failed" },
    };
  }
}

export interface SecurityScanServiceOptions {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly dynamicTargetsEnabled?: boolean;
  readonly timeoutMs: number;
  readonly now?: () => Date;
  readonly resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  readonly probe?: (target: URL, address: ResolvedAddress, timeoutMs: number) => Promise<ProbeResult>;
}

export const MAX_SECURITY_SCAN_HTML_BYTES = 256 * 1024;

const SECURITY_SCAN_LIMITATIONS = [
  "루트 또는 입력한 경로의 HTML 응답만 최대 256 KiB까지 확인하며 리디렉션을 따라가지 않습니다.",
  "브라우저 코드 신호는 정규식 기반 휴리스틱이므로 문자열·주석 때문에 오탐 또는 누락이 발생할 수 있습니다.",
  "JavaScript를 실행하지 않으며 SPA 렌더링 결과, 외부 스크립트 번들, 다른 경로와 하위 리소스는 확인하지 않습니다.",
  "text/html 응답만 UTF-8로 읽으며 서버가 압축 본문을 반환하거나 다른 콘텐츠 유형이면 코드 분석을 건너뜁니다.",
] as const;

const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();
const globallyRoutableIpv6Addresses = new BlockList();
globallyRoutableIpv6Addresses.addSubnet("2000::", 3, "ipv6");

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

function normalizeAddress(address: string): string {
  return address.toLowerCase().split("%", 1)[0] ?? address.toLowerCase();
}

function hostnameIpVersion(hostname: string): number {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return isIP(normalizeAddress(unwrapped));
}

export function normalizeSecurityScanTarget(targetUrl: string): URL {
  const input = targetUrl.trim();
  let target: URL;
  try {
    target = new URL(input);
  } catch {
    throw new SecurityScanError("SECURITY_SCAN_TARGET_BLOCKED", "유효한 HTTPS URL을 입력해 주세요.");
  }
  const schemeSeparator = input.indexOf("://");
  const authority = schemeSeparator < 0
    ? ""
    : (input.slice(schemeSeparator + 3).split(/[/?#]/, 1)[0] ?? "");
  if (
    schemeSeparator < 0 ||
    target.protocol !== "https:" ||
    target.port !== "" ||
    target.username !== "" ||
    target.password !== "" ||
    authority.includes("@") ||
    input.includes("?") ||
    input.includes("#") ||
    [...input].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x20 || codePoint === 0x7f;
    }) ||
    hostnameIpVersion(target.hostname) !== 0
  ) {
    throw new SecurityScanError(
      "SECURITY_SCAN_TARGET_BLOCKED",
      "계정정보·쿼리·프래그먼트·IP 주소가 없는 HTTPS 기본 포트 URL만 점검할 수 있습니다.",
    );
  }
  return target;
}

export function isPublicIpAddress(address: string): boolean {
  const normalized = normalizeAddress(address);
  const version = isIP(normalized);
  if (version === 4) return !blockedIpv4Addresses.check(normalized, "ipv4");
  if (version === 6) {
    return (
      globallyRoutableIpv6Addresses.check(normalized, "ipv6") &&
      !blockedIpv6Addresses.check(normalized, "ipv6")
    );
  }
  return false;
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number, timeoutError: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), timeoutMs);
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("operation failed"));
      },
    );
  });
}

async function resolvePublicAddresses(hostname: string): Promise<readonly ResolvedAddress[]> {
  const lookups = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
  const addresses: ResolvedAddress[] = [];
  for (const [index, lookup] of lookups.entries()) {
    if (lookup.status === "fulfilled") {
      const family: 4 | 6 = index === 0 ? 4 : 6;
      addresses.push(...lookup.value.map((address) => ({ address, family })));
      continue;
    }
    const code = (lookup.reason as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENODATA" && code !== "ENOTFOUND") {
      throw new SecurityScanError("SECURITY_SCAN_DNS_FAILED", "대상 도메인의 DNS 주소를 확인할 수 없습니다.");
    }
  }
  if (addresses.length === 0) {
    throw new SecurityScanError("SECURITY_SCAN_DNS_FAILED", "대상 도메인의 DNS 주소가 없습니다.");
  }
  if (addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw new SecurityScanError(
      "SECURITY_SCAN_TARGET_BLOCKED",
      "공개 인터넷 주소가 아닌 대상으로 연결되는 도메인은 점검할 수 없습니다.",
    );
  }
  return addresses;
}

export async function collectBoundedUtf8Body(
  source: AsyncIterable<Uint8Array>,
  expectedBytes?: number,
): Promise<{ readonly text: string; readonly bytesInspected: number; readonly truncated: boolean }> {
  const chunks: Buffer[] = [];
  let bytesInspected = 0;
  let truncated = expectedBytes !== undefined && expectedBytes > MAX_SECURITY_SCAN_HTML_BYTES;
  for await (const value of source) {
    const chunk = Buffer.from(value);
    const remaining = MAX_SECURITY_SCAN_HTML_BYTES - bytesInspected;
    if (chunk.byteLength > remaining) {
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      bytesInspected += Math.max(remaining, 0);
      truncated = true;
      break;
    }
    chunks.push(chunk);
    bytesInspected += chunk.byteLength;
    if (bytesInspected === MAX_SECURITY_SCAN_HTML_BYTES && truncated) break;
  }
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks, bytesInspected)),
    bytesInspected,
    truncated,
  };
}

function normalizedContentType(headers: IncomingHttpHeaders): string | null {
  const value = header(headers, "content-type").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value) ? value : null;
}

function contentLength(headers: IncomingHttpHeaders): number | undefined {
  const value = header(headers, "content-length").trim();
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function probePage(target: URL, address: ResolvedAddress, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const succeed = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const fail = (error: SecurityScanError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(error);
    };
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname: address.address,
        family: address.family,
        port: 443,
        method: "GET",
        path: target.pathname || "/",
        servername: target.hostname,
        rejectUnauthorized: true,
        agent: false,
        maxHeaderSize: 16 * 1024,
        headers: {
          Host: target.hostname,
          Accept: "text/html",
          "Accept-Encoding": "identity",
          "User-Agent": "EduSafety-Passive-Security-Check/1.0",
        },
      },
      (response) => {
        const socket = response.socket;
        const certificate = socket instanceof TLSSocket ? socket.getPeerCertificate() : null;
        const baseResult = {
          httpStatus: response.statusCode ?? 0,
          headers: response.headers,
          tlsProtocol: socket instanceof TLSSocket ? (socket.getProtocol() ?? "unknown") : "unknown",
          certificateValidTo: certificate?.valid_to ?? null,
        };
        const responseContentType = normalizedContentType(response.headers);
        const contentEncoding = header(response.headers, "content-encoding").trim().toLowerCase();
        const redirect = baseResult.httpStatus >= 300 && baseResult.httpStatus < 400;
        if (
          redirect ||
          responseContentType !== "text/html" ||
          (contentEncoding !== "" && contentEncoding !== "identity")
        ) {
          succeed({
            ...baseResult,
            source: {
              contentType: responseContentType,
              bytesInspected: 0,
              truncated: false,
              html: null,
            },
          });
          response.destroy();
          return;
        }
        void collectBoundedUtf8Body(response, contentLength(response.headers)).then(
          (body) => {
            succeed({
              ...baseResult,
              source: {
                contentType: responseContentType,
                bytesInspected: body.bytesInspected,
                truncated: body.truncated,
                html: body.text,
              },
            });
            if (body.truncated) response.destroy();
          },
          () => fail(new SecurityScanError(
            "SECURITY_SCAN_TARGET_UNREACHABLE",
            "대상 HTTPS 응답을 제한 범위 안에서 읽을 수 없습니다.",
          )),
        );
      },
    );
    const deadline = setTimeout(() => request.destroy(new Error("target timeout")), timeoutMs);
    request.setTimeout(timeoutMs, () => request.destroy(new Error("target timeout")));
    request.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      const code = error.code ?? "";
      if (TLS_CERTIFICATE_ERROR_CODES.has(code)) {
        fail(new SecurityScanError(
          "SECURITY_SCAN_TLS_CERTIFICATE_INVALID",
          "대상 HTTPS 인증서의 유효성 또는 호스트 일치를 확인할 수 없습니다.",
        ));
        return;
      }
      if (code === "EPROTO" || code.startsWith("ERR_SSL_") || code.startsWith("ERR_TLS_")) {
        fail(new SecurityScanError(
          "SECURITY_SCAN_TLS_HANDSHAKE_FAILED",
          "대상 HTTPS 서비스와 안전한 TLS 연결을 협상할 수 없습니다.",
        ));
        return;
      }
      fail(new SecurityScanError(
        "SECURITY_SCAN_TARGET_UNREACHABLE",
        "대상 HTTPS 서비스에 안전하게 연결할 수 없습니다.",
      ));
    });
    request.end();
  });
}

const TLS_CERTIFICATE_ERROR_CODES = new Set([
  "CERT_CHAIN_TOO_LONG",
  "CERT_HAS_EXPIRED",
  "CERT_INVALID",
  "CERT_NOT_YET_VALID",
  "CERT_REJECTED",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "CRL_SIGNATURE_FAILURE",
  "CRL_NOT_YET_VALID",
  "CRL_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
  "INVALID_CA",
  "INVALID_PURPOSE",
  "PATH_LENGTH_EXCEEDED",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  "UNABLE_TO_GET_CRL",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function header(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : (value ?? "");
}

function hasPositiveHsts(value: string): boolean {
  const match = /(?:^|;)\s*max-age\s*=\s*(\d+)\s*(?:;|$)/i.exec(value);
  if (!match?.[1]) return false;
  const seconds = Number(match[1]);
  return Number.isSafeInteger(seconds) && seconds > 0;
}

function cspDirectives(value: string): ReadonlyMap<string, readonly string[]> {
  const directives = new Map<string, readonly string[]>();
  for (const part of value.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const name = tokens.shift()?.toLowerCase();
    if (name && !directives.has(name)) {
      directives.set(name, tokens.map((token) => token.toLowerCase()));
    }
  }
  return directives;
}

function hasMeaningfulCsp(directives: ReadonlyMap<string, readonly string[]>): boolean {
  const defaultSources = directives.get("default-src");
  if (!defaultSources || defaultSources.length === 0 || defaultSources.includes("*")) return false;
  const scriptSources = directives.get("script-src") ?? defaultSources;
  const unsafeScriptSources = new Set(["*", "http:", "https:", "data:", "'unsafe-eval'", "'unsafe-inline'"]);
  return scriptSources.length > 0 && !scriptSources.some((source) => unsafeScriptSources.has(source));
}

function hasMeaningfulFrameAncestors(directives: ReadonlyMap<string, readonly string[]>): boolean {
  const sources = directives.get("frame-ancestors");
  if (!sources || sources.length === 0) return false;
  return !sources.some((source) => source === "*" || source === "http:" || source === "https:");
}

function hasValidFrameOptions(value: string): boolean {
  return /^(?:DENY|SAMEORIGIN)$/i.test(value.trim());
}

const KNOWN_REFERRER_POLICIES = new Set([
  "no-referrer",
  "no-referrer-when-downgrade",
  "origin",
  "origin-when-cross-origin",
  "same-origin",
  "strict-origin",
  "strict-origin-when-cross-origin",
  "unsafe-url",
]);
const SAFE_REFERRER_POLICIES = new Set([
  "no-referrer",
  "origin",
  "origin-when-cross-origin",
  "same-origin",
  "strict-origin",
  "strict-origin-when-cross-origin",
]);

function hasSafeReferrerPolicy(value: string): boolean {
  const policies = value.split(",").map((policy) => policy.trim().toLowerCase()).filter(Boolean);
  const effective = policies.reverse().find((policy) => KNOWN_REFERRER_POLICIES.has(policy));
  return effective !== undefined && SAFE_REFERRER_POLICIES.has(effective);
}

function hasRestrictivePermissionsPolicy(value: string): boolean {
  const directives = value.split(",").map((directive) => directive.trim()).filter(Boolean);
  if (directives.length === 0) return false;
  let hasDisabledFeature = false;
  for (const directive of directives) {
    const match = /^[a-z][a-z0-9-]*\s*=\s*\(([^)]*)\)$/i.exec(directive);
    if (!match) return false;
    const allowlist = match[1]?.trim() ?? "";
    if (allowlist.includes("*")) return false;
    if (allowlist === "") hasDisabledFeature = true;
  }
  return hasDisabledFeature;
}

function finding(
  id: string,
  title: string,
  severity: SecurityFindingSeverity,
  passed: boolean,
  evidence: string,
  remediation: string,
  warning = false,
): SecurityFinding {
  return {
    id,
    title,
    severity,
    status: passed ? "pass" : warning ? "warning" : "fail",
    evidence,
    remediation,
  };
}

interface BrowserSourceAnalysis {
  readonly scriptCount: number;
  readonly formCount: number;
  readonly mixedContentUrls: number;
  readonly javascriptUrls: number;
  readonly inlineDangerousSinks: number;
  readonly externalScriptsWithoutIntegrity: number;
}

function attributeValue(attributes: string, name: string): string | null {
  const pattern = new RegExp(
    String.raw`(?:^|\s)${name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+))`,
    "i",
  );
  const match = pattern.exec(attributes);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function analyzeBrowserSource(html: string, target: URL): BrowserSourceAnalysis {
  let mixedContentUrls = 0;
  let javascriptUrls = 0;
  const urlAttributePattern = /(?:^|\s)(?:src|href|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  for (const match of html.matchAll(urlAttributePattern)) {
    const value = [...(match[1] ?? match[2] ?? match[3] ?? "")]
      .filter((character) => (character.codePointAt(0) ?? 0) > 0x20)
      .join("")
      .toLowerCase();
    if (value.startsWith("http://")) mixedContentUrls += 1;
    if (value.startsWith("javascript:")) javascriptUrls += 1;
  }

  const scriptCount = [...html.matchAll(/<script\b/gi)].length;
  let inlineDangerousSinks = 0;
  let externalScriptsWithoutIntegrity = 0;
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    const attributes = match[1] ?? "";
    const source = attributeValue(attributes, "src");
    if (source === null) {
      inlineDangerousSinks += [...(match[2] ?? "").matchAll(
        /\beval\s*\(|\bnew\s+Function\s*\(|\bdocument\s*\.\s*write(?:ln)?\s*\(/gi,
      )].length;
      continue;
    }
    try {
      const sourceUrl = new URL(source, target);
      const external = ["http:", "https:"].includes(sourceUrl.protocol) && sourceUrl.origin !== target.origin;
      const integrity = attributeValue(attributes, "integrity");
      if (external && (integrity === null || integrity.trim() === "")) {
        externalScriptsWithoutIntegrity += 1;
      }
    } catch {
      // Malformed source URLs are outside this deliberately narrow heuristic.
    }
  }

  return {
    scriptCount,
    formCount: [...html.matchAll(/<form\b/gi)].length,
    mixedContentUrls,
    javascriptUrls,
    inlineDangerousSinks,
    externalScriptsWithoutIntegrity,
  };
}

function sourceFindings(analysis: BrowserSourceAnalysis): readonly SecurityFinding[] {
  return [
    finding(
      "browser-mixed-content",
      "혼합 콘텐츠 URL 신호",
      "low",
      analysis.mixedContentUrls === 0,
      analysis.mixedContentUrls === 0
        ? "공개 HTML 속성에서 http:// URL 신호 없음"
        : `공개 HTML의 src/href/action 속성에서 http:// URL 신호 ${analysis.mixedContentUrls}개`,
      "HTTPS 페이지의 리소스와 이동·폼 URL을 HTTPS 또는 안전한 상대 경로로 변경하세요.",
      true,
    ),
    finding(
      "browser-javascript-url",
      "javascript: URL 신호",
      "low",
      analysis.javascriptUrls === 0,
      analysis.javascriptUrls === 0
        ? "공개 HTML 속성에서 javascript: URL 신호 없음"
        : `공개 HTML의 src/href/action 속성에서 javascript: URL 신호 ${analysis.javascriptUrls}개`,
      "javascript: URL 대신 이벤트 리스너와 제한적인 CSP를 사용하세요.",
      true,
    ),
    finding(
      "browser-inline-script-sinks",
      "인라인 스크립트 위험 API 신호",
      "low",
      analysis.inlineDangerousSinks === 0,
      analysis.inlineDangerousSinks === 0
        ? "인라인 스크립트에서 지정된 위험 API 신호 없음"
        : `인라인 스크립트에서 eval/new Function/document.write 신호 ${analysis.inlineDangerousSinks}개`,
      "동적 코드 실행과 document.write 사용을 제거하고 안전한 DOM API로 대체하세요.",
      true,
    ),
    finding(
      "browser-external-script-integrity",
      "외부 스크립트 무결성 신호",
      "info",
      analysis.externalScriptsWithoutIntegrity === 0,
      analysis.externalScriptsWithoutIntegrity === 0
        ? "교차 출처 스크립트에서 integrity 누락 신호 없음"
        : `교차 출처 스크립트 중 integrity 속성 누락 신호 ${analysis.externalScriptsWithoutIntegrity}개`,
      "고정된 교차 출처 스크립트에는 Subresource Integrity와 적절한 crossorigin 속성을 적용하세요.",
      true,
    ),
  ];
}

function evaluate(probe: ProbeResult, target: URL): readonly SecurityFinding[] {
  const hsts = header(probe.headers, "strict-transport-security");
  const csp = header(probe.headers, "content-security-policy");
  const cspPolicy = cspDirectives(csp);
  const frameOptions = header(probe.headers, "x-frame-options");
  const referrerPolicy = header(probe.headers, "referrer-policy");
  const permissionsPolicy = header(probe.headers, "permissions-policy");
  const cookies = probe.headers["set-cookie"] ?? [];
  const cookieValues = Array.isArray(cookies) ? cookies : [cookies];
  const insecureCookies = cookieValues.filter((cookie) =>
    !/;\s*secure(?:;|$)/i.test(cookie) ||
    !/;\s*httponly(?:;|$)/i.test(cookie) ||
    !/;\s*samesite=(?:lax|strict|none)(?:;|$)/i.test(cookie),
  );
  const modernTls = probe.tlsProtocol === "TLSv1.3" || probe.tlsProtocol === "TLSv1.2";
  const statusOk = probe.httpStatus >= 200 && probe.httpStatus < 300;
  const redirect = probe.httpStatus >= 300 && probe.httpStatus < 400;
  const hstsValid = hasPositiveHsts(hsts);
  const cspValid = hasMeaningfulCsp(cspPolicy);
  const clickjackingProtection = hasMeaningfulFrameAncestors(cspPolicy) || hasValidFrameOptions(frameOptions);
  const referrerPolicyValid = hasSafeReferrerPolicy(referrerPolicy);
  const permissionsPolicyValid = hasRestrictivePermissionsPolicy(permissionsPolicy);

  const headerFindings = [
    finding(
      "tls-version",
      "TLS 프로토콜",
      "high",
      modernTls,
      `협상된 프로토콜: ${probe.tlsProtocol}`,
      "TLS 1.2 이상만 허용하고 오래된 프로토콜을 비활성화하세요.",
    ),
    finding(
      "http-status",
      "요청 경로 응답",
      "low",
      statusOk,
      redirect
        ? `GET 응답 상태: ${probe.httpStatus} (리디렉션은 안전을 위해 따라가지 않음)`
        : `GET 응답 상태: ${probe.httpStatus}`,
      redirect
        ? "최종 HTTPS origin을 별도로 승인 목록에 등록해 점검하세요."
        : "점검 경로가 안정적으로 응답하는지 확인하세요.",
      true,
    ),
    finding(
      "strict-transport-security",
      "HSTS",
      "medium",
      hstsValid,
      hstsValid ? "양수 max-age를 가진 HSTS 정책 확인" : "HSTS가 없거나 max-age가 0 또는 유효하지 않음",
      "HTTPS 응답에 적절한 max-age를 가진 Strict-Transport-Security 헤더를 설정하세요.",
    ),
    finding(
      "content-security-policy",
      "콘텐츠 보안 정책",
      "medium",
      cspValid,
      cspValid ? "제한적인 기본 및 스크립트 출처 정책 확인" : "CSP가 없거나 기본·스크립트 출처 제한이 충분하지 않음",
      "서비스에 맞는 제한적인 Content-Security-Policy를 적용하세요.",
    ),
    finding(
      "clickjacking-protection",
      "클릭재킹 방어",
      "low",
      clickjackingProtection,
      clickjackingProtection
        ? "제한적인 CSP frame-ancestors 또는 X-Frame-Options 확인"
        : "유효한 X-Frame-Options 또는 제한적인 CSP frame-ancestors 없음",
      "CSP frame-ancestors 또는 X-Frame-Options로 허용 프레임 출처를 제한하세요.",
    ),
    finding(
      "x-content-type-options",
      "MIME 스니핑 방지",
      "low",
      header(probe.headers, "x-content-type-options").trim().toLowerCase() === "nosniff",
      header(probe.headers, "x-content-type-options").trim().toLowerCase() === "nosniff"
        ? "X-Content-Type-Options: nosniff 확인"
        : "X-Content-Type-Options: nosniff 없음",
      "X-Content-Type-Options: nosniff를 설정하세요.",
    ),
    finding(
      "referrer-policy",
      "리퍼러 정책",
      "low",
      referrerPolicyValid,
      referrerPolicyValid ? "교차 출처 정보 노출을 제한하는 Referrer-Policy 확인" : "Referrer-Policy가 없거나 안전 기준에 맞지 않음",
      "서비스 특성에 맞는 Referrer-Policy를 명시하세요.",
    ),
    finding(
      "permissions-policy",
      "브라우저 기능 권한",
      "info",
      permissionsPolicyValid,
      permissionsPolicyValid ? "하나 이상의 브라우저 기능을 명시적으로 비활성화함" : "Permissions-Policy가 없거나 기능 비활성화 규칙이 충분하지 않음",
      "사용하지 않는 브라우저 기능을 Permissions-Policy로 제한하세요.",
      true,
    ),
    finding(
      "cookie-flags",
      "응답 쿠키 보호 속성",
      "medium",
      insecureCookies.length === 0,
      cookieValues.length === 0
        ? "Set-Cookie 응답 없음"
        : insecureCookies.length === 0
          ? `응답 쿠키 ${cookieValues.length}개에 Secure, HttpOnly, SameSite 설정 확인`
          : `응답 쿠키 ${cookieValues.length}개 중 보호 속성 누락 ${insecureCookies.length}개`,
      "세션 쿠키에 Secure, HttpOnly, 적절한 SameSite 속성을 모두 설정하세요.",
      true,
    ),
  ];
  const html = probe.source?.html;
  return html === null || html === undefined
    ? headerFindings
    : [...headerFindings, ...sourceFindings(analyzeBrowserSource(html, target))];
}

function riskLevel(findings: readonly SecurityFinding[]): SecurityRiskLevel {
  const active = findings.filter(({ status }) => status !== "pass");
  if (active.some(({ severity }) => severity === "high")) return "high";
  if (active.some(({ severity }) => severity === "medium")) return "medium";
  if (active.length > 0) return "low";
  return "minimal";
}

function counts(findings: readonly SecurityFinding[]): SecurityScanResult["counts"] {
  const active = findings.filter(({ status }) => status !== "pass");
  return {
    passed: findings.length - active.length,
    high: active.filter(({ severity }) => severity === "high").length,
    medium: active.filter(({ severity }) => severity === "medium").length,
    low: active.filter(({ severity }) => severity === "low").length,
    info: active.filter(({ severity }) => severity === "info").length,
  };
}

function fallbackSummary(findings: readonly SecurityFinding[], level: SecurityRiskLevel): SecurityScanAiSummary {
  const active = findings.filter(({ status }) => status !== "pass");
  const overview = active.length === 0
    ? "확인한 저영향 항목에서 즉시 개선이 필요한 누락을 찾지 못했습니다."
    : `저영향 구성 점검에서 개선 항목 ${active.length}개를 확인했습니다. 근거를 검토한 뒤 우선순위대로 보완하세요.`;
  return {
    used: false,
    status: "not_requested",
    overview,
    riskLevel: level,
    priorityActions: active.slice(0, 3).map(({ remediation }) => remediation),
  };
}

export class PassiveSecurityScanService implements SecurityScanRunner {
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #dynamicTargetsEnabled: boolean;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  readonly #resolve: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  readonly #probe: (target: URL, address: ResolvedAddress, timeoutMs: number) => Promise<ProbeResult>;

  public constructor(options: SecurityScanServiceOptions) {
    this.#allowedOrigins = options.allowedOrigins;
    this.#dynamicTargetsEnabled = options.dynamicTargetsEnabled ?? false;
    this.#timeoutMs = options.timeoutMs;
    this.#now = options.now ?? (() => new Date());
    this.#resolve = options.resolve ?? resolvePublicAddresses;
    this.#probe = options.probe ?? probePage;
  }

  public async scan(
    targetUrl: string,
    safetyIdentifier: string,
    summarize?: SecurityScanSummarizer,
  ): Promise<SecurityScanResult> {
    const target = normalizeSecurityScanTarget(targetUrl);
    const targetOrigin = target.origin;
    const normalizedTargetUrl = target.href;
    if (!this.#dynamicTargetsEnabled && !this.#allowedOrigins.has(targetOrigin)) {
      throw new SecurityScanError("SECURITY_SCAN_TARGET_NOT_ALLOWED", "서버에서 승인한 도메인만 점검할 수 있습니다.");
    }
    const addresses = await withDeadline(
      this.#resolve(target.hostname),
      this.#timeoutMs,
      () => new SecurityScanError(
        "SECURITY_SCAN_DNS_FAILED",
        "대상 도메인의 DNS 확인 시간이 제한을 초과했습니다.",
      ),
    );
    if (addresses.length === 0) {
      throw new SecurityScanError("SECURITY_SCAN_DNS_FAILED", "대상 도메인의 DNS 주소가 없습니다.");
    }
    if (addresses.some(({ address, family }) =>
      !isPublicIpAddress(address) || isIP(normalizeAddress(address)) !== family
    )) {
      throw new SecurityScanError("SECURITY_SCAN_TARGET_BLOCKED", "공개 인터넷 주소가 아닌 대상은 점검할 수 없습니다.");
    }
    const selectedAddress = addresses.find(({ family }) => family === 4) ?? addresses[0];
    if (!selectedAddress) {
      throw new SecurityScanError("SECURITY_SCAN_DNS_FAILED", "연결할 공개 DNS 주소를 선택할 수 없습니다.");
    }
    const probe = await withDeadline(
      this.#probe(target, selectedAddress, this.#timeoutMs),
      this.#timeoutMs,
      () => new SecurityScanError(
        "SECURITY_SCAN_TARGET_UNREACHABLE",
        "대상 HTTPS 응답 시간이 제한을 초과했습니다.",
      ),
    );
    const findings = evaluate(probe, target);
    const level = riskLevel(findings);
    const activeCount = findings.filter(({ status }) => status !== "pass").length;
    const sourceAnalysis = probe.source?.html === null || probe.source?.html === undefined
      ? { scriptCount: 0, formCount: 0 }
      : analyzeBrowserSource(probe.source.html, target);
    const scan: SecurityScanResult = {
      targetUrl: normalizedTargetUrl,
      targetOrigin,
      checkedAt: this.#now().toISOString(),
      httpStatus: probe.httpStatus,
      tls: { protocol: probe.tlsProtocol, certificateValidTo: probe.certificateValidTo },
      summary: activeCount === 0
        ? "이번 저영향 점검 범위에서 보완 신호를 찾지 못했습니다."
        : `확인하거나 보완할 항목 ${activeCount}개가 있습니다.`,
      counts: counts(findings),
      findings,
      ai: fallbackSummary(findings, level),
      sourceSummary: {
        contentType: probe.source?.contentType ?? null,
        analyzed: probe.source?.html !== null && probe.source?.html !== undefined,
        bytesInspected: probe.source?.bytesInspected ?? 0,
        truncated: probe.source?.truncated ?? false,
        scriptCount: sourceAnalysis.scriptCount,
        formCount: sourceAnalysis.formCount,
      },
      limitations: SECURITY_SCAN_LIMITATIONS,
    };
    return summarize === undefined
      ? scan
      : applySecurityScanSummary(scan, safetyIdentifier, summarize);
  }
}
