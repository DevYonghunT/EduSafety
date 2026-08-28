import { describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_SUMMARY_TIMEOUT_MS,
  createAnthropicSecuritySummarizer,
} from "../../src/security-scan/anthropic-summary.js";
import {
  MAX_SECURITY_SCAN_HTML_BYTES,
  PassiveSecurityScanService,
  collectBoundedUtf8Body,
  isPublicIpAddress,
} from "../../src/security-scan/service.js";
import type { SecurityScanError } from "../../src/security-scan/service.js";

const targetOrigin = "https://school.example";

function safeProbe() {
  return {
    httpStatus: 200,
    tlsProtocol: "TLSv1.3",
    certificateValidTo: "Dec 31 23:59:59 2030 GMT",
    headers: {
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "camera=(), microphone=()",
    },
  };
}

function completedAnthropicResponse(
  overview: string,
  priorityActions: readonly string[],
  stopReason = "end_turn",
): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [{
        type: "text",
        text: JSON.stringify({ overview, priority_actions: priorityActions }),
      }],
      stop_reason: stopReason,
      stop_sequence: null,
      stop_details: null,
      container: null,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: null,
        inference_geo: null,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: "standard",
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("passive security scan", () => {
  it("blocks private, loopback, documentation, and mapped addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "169.254.169.254",
      "203.0.113.10",
      "::1",
      "::7f00:1",
      "::ffff:127.0.0.1",
      "::ffff:1.1.1.1",
      "64:ff9b:1::7f00:1",
      "2001:2::1",
      "2001:20::1",
      "2001:db8::1",
      "2002::1",
      "3fff::1",
      "5f00::1",
      "fc00::1",
      "fec0::1",
    ]) {
      expect(isPublicIpAddress(address), address).toBe(false);
    }
    expect(isPublicIpAddress("1.1.1.1")).toBe(true);
    expect(isPublicIpAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("returns deterministic evidence and an optional AI summary", async () => {
    const probe = vi.fn(async () => safeProbe());
    const service = new PassiveSecurityScanService({
      allowedOrigins: new Set([targetOrigin]),
      timeoutMs: 5_000,
      now: () => new Date("2026-08-28T01:02:03.000Z"),
      resolve: async () => [{ address: "1.1.1.1", family: 4 }],
      probe,
    });

    const result = await service.scan(`${targetOrigin}/review/../audit`, "scan_user", async () => ({
      overview: "기본 방어 헤더가 확인되었습니다.",
      priorityActions: ["정기적으로 다시 점검하세요."],
    }));
    expect(result.targetUrl).toBe(`${targetOrigin}/audit`);
    expect(result.targetOrigin).toBe(targetOrigin);
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({ href: `${targetOrigin}/audit`, pathname: "/audit" }),
      { address: "1.1.1.1", family: 4 },
      5_000,
    );
    expect(result.checkedAt).toBe("2026-08-28T01:02:03.000Z");
    expect(result.summary).toBe("이번 저영향 점검 범위에서 보완 신호를 찾지 못했습니다.");
    expect(result.counts).toEqual({ passed: 9, high: 0, medium: 0, low: 0, info: 0 });
    expect(result.ai).toEqual({
      used: true,
      status: "used",
      overview: "기본 방어 헤더가 확인되었습니다.",
      riskLevel: "minimal",
      priorityActions: ["정기적으로 다시 점검하세요."],
    });
  });

  it("fails closed when DNS resolves to any non-public address", async () => {
    const probe = vi.fn(async () => safeProbe());
    const service = new PassiveSecurityScanService({
      allowedOrigins: new Set([targetOrigin]),
      timeoutMs: 5_000,
      resolve: async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      probe,
    });

    await expect(service.scan(targetOrigin, "scan_user")).rejects.toMatchObject({
      code: "SECURITY_SCAN_TARGET_BLOCKED",
    } satisfies Partial<SecurityScanError>);
    expect(probe).not.toHaveBeenCalled();
  });

  it("rejects a target outside the server-owned exact allowlist", async () => {
    const service = new PassiveSecurityScanService({
      allowedOrigins: new Set([targetOrigin]),
      timeoutMs: 5_000,
      resolve: async () => [{ address: "1.1.1.1", family: 4 }],
      probe: async () => safeProbe(),
    });

    await expect(service.scan("https://other.example", "scan_user")).rejects.toMatchObject({
      code: "SECURITY_SCAN_TARGET_NOT_ALLOWED",
    } satisfies Partial<SecurityScanError>);
  });

  it("allows a dynamic public HTTPS path only when the dynamic option is enabled", async () => {
    const probe = vi.fn(async () => safeProbe());
    const service = new PassiveSecurityScanService({
      allowedOrigins: new Set(),
      dynamicTargetsEnabled: true,
      timeoutMs: 5_000,
      resolve: async () => [{ address: "1.1.1.1", family: 4 }],
      probe,
    });

    await expect(service.scan("https://other.example/public/code", "scan_user"))
      .resolves.toMatchObject({
        targetUrl: "https://other.example/public/code",
        targetOrigin: "https://other.example",
      });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("keeps the deterministic result when AI summarization fails", async () => {
    const service = new PassiveSecurityScanService({
      allowedOrigins: new Set([targetOrigin]),
      timeoutMs: 5_000,
      resolve: async () => [{ address: "1.1.1.1", family: 4 }],
      probe: async () => ({ ...safeProbe(), headers: {} }),
    });

    const result = await service.scan(targetOrigin, "scan_user", async () => {
      throw new Error("model unavailable");
    });
    expect(result.ai.used).toBe(false);
    expect(result.ai.status).toBe("failed");
    expect(result.ai.riskLevel).toBe("medium");
    expect(result.counts.medium).toBeGreaterThan(0);
  });

  it("does not treat present but ineffective headers or redirects as passes", async () => {
    const probe = vi.fn(async () => ({
      ...safeProbe(),
      httpStatus: 302,
      headers: {
        "strict-transport-security": "max-age=0",
        "content-security-policy": "default-src *; frame-ancestors *",
        "x-frame-options": "ALLOWALL",
        "x-content-type-options": "nosniff",
        "referrer-policy": "unsafe-url",
        "permissions-policy": "camera=*",
      },
    }));
    const service = new PassiveSecurityScanService({
      allowedOrigins: new Set([targetOrigin]),
      timeoutMs: 5_000,
      resolve: async () => [{ address: "1.1.1.1", family: 4 }],
      probe,
    });

    const result = await service.scan(targetOrigin, "scan_user");
    const findings = Object.fromEntries(result.findings.map((finding) => [finding.id, finding]));
    expect(findings["http-status"]?.status).toBe("warning");
    expect(findings["http-status"]?.evidence).toContain("따라가지 않음");
    expect(findings["strict-transport-security"]?.status).toBe("fail");
    expect(findings["content-security-policy"]?.status).toBe("fail");
    expect(findings["clickjacking-protection"]?.status).toBe("fail");
    expect(findings["referrer-policy"]?.status).toBe("fail");
    expect(findings["permissions-policy"]?.status).toBe("warning");
    expect(result.ai.riskLevel).toBe("medium");
    expect(probe).toHaveBeenCalledOnce();
  });

  it("reports cookie flag gaps as review-needed because cookie purpose is unknown", async () => {
    const service = new PassiveSecurityScanService({
      allowedOrigins: new Set([targetOrigin]),
      timeoutMs: 5_000,
      resolve: async () => [{ address: "1.1.1.1", family: 4 }],
      probe: async () => ({
        ...safeProbe(),
        headers: {
          ...safeProbe().headers,
          "set-cookie": ["preferences=compact; Secure; SameSite=Lax"],
        },
      }),
    });

    const result = await service.scan(targetOrigin, "scan_user");
    const cookieFinding = result.findings.find(({ id }) => id === "cookie-flags");

    expect(cookieFinding).toMatchObject({
      severity: "medium",
      status: "warning",
    });
    expect(cookieFinding?.evidence).toContain("보호 속성 누락 1개");
  });

  it("bounds DNS resolution with the configured timeout", async () => {
    const probe = vi.fn(async () => safeProbe());
    const service = new PassiveSecurityScanService({
      allowedOrigins: new Set([targetOrigin]),
      timeoutMs: 10,
      resolve: () => new Promise<never>(() => undefined),
      probe,
    });

    await expect(service.scan(targetOrigin, "scan_user")).rejects.toMatchObject({
      code: "SECURITY_SCAN_DNS_FAILED",
    } satisfies Partial<SecurityScanError>);
    expect(probe).not.toHaveBeenCalled();
  });

  it("caps HTML collection without retaining bytes beyond the limit", async () => {
    async function* body(): AsyncGenerator<Uint8Array> {
      yield Buffer.alloc(MAX_SECURITY_SCAN_HTML_BYTES, "a");
      yield Buffer.from("raw-secret-after-cap");
    }

    const collected = await collectBoundedUtf8Body(body());
    expect(collected.bytesInspected).toBe(MAX_SECURITY_SCAN_HTML_BYTES);
    expect(collected.truncated).toBe(true);
    expect(collected.text).toHaveLength(MAX_SECURITY_SCAN_HTML_BYTES);
    expect(collected.text).not.toContain("raw-secret-after-cap");
  });

  it("reports low-confidence browser source signals without exposing raw HTML to the result or AI", async () => {
    const rawSecret = "raw-source-secret-value";
    const html = [
      `<a href="http://assets.example/${rawSecret}">mixed</a>`,
      "<a href=\"javascript:alert(1)\">action</a>",
      "<form action=\"/submit\"></form>",
      `<script>/* ${rawSecret} */ eval("code"); document.write("x")</script>`,
      "<script src=\"https://cdn.example/library.js\"></script>",
    ].join("");
    const summarize = vi.fn(async (input: unknown) => {
      expect(JSON.stringify(input)).not.toContain(rawSecret);
      return { overview: "휴리스틱 신호를 검토하세요.", priorityActions: [] };
    });
    const service = new PassiveSecurityScanService({
      allowedOrigins: new Set(),
      dynamicTargetsEnabled: true,
      timeoutMs: 5_000,
      resolve: async () => [{ address: "1.1.1.1", family: 4 }],
      probe: async () => ({
        ...safeProbe(),
        source: {
          contentType: "text/html",
          bytesInspected: Buffer.byteLength(html),
          truncated: false,
          html,
        },
      }),
    });

    const result = await service.scan(`${targetOrigin}/public`, "scan_user", summarize);
    const findings = Object.fromEntries(result.findings.map((finding) => [finding.id, finding]));
    expect(findings["browser-mixed-content"]?.status).toBe("warning");
    expect(findings["browser-javascript-url"]?.status).toBe("warning");
    expect(findings["browser-inline-script-sinks"]?.status).toBe("warning");
    expect(findings["browser-external-script-integrity"]?.status).toBe("warning");
    expect(result.sourceSummary).toEqual({
      contentType: "text/html",
      analyzed: true,
      bytesInspected: Buffer.byteLength(html),
      truncated: false,
      scriptCount: 2,
      formCount: 1,
    });
    expect(result.limitations.join(" ")).toMatch(/정규식.*오탐|오탐.*정규식/);
    expect(JSON.stringify(result)).not.toContain(rawSecret);
    expect(summarize).toHaveBeenCalledOnce();
  });

  it("does not decode or analyze a non-HTML response body", async () => {
    const service = new PassiveSecurityScanService({
      allowedOrigins: new Set([targetOrigin]),
      timeoutMs: 5_000,
      resolve: async () => [{ address: "1.1.1.1", family: 4 }],
      probe: async () => ({
        ...safeProbe(),
        source: {
          contentType: "application/json",
          bytesInspected: 0,
          truncated: false,
          html: null,
        },
      }),
    });

    const result = await service.scan(targetOrigin, "scan_user");
    expect(result.sourceSummary).toMatchObject({
      contentType: "application/json",
      analyzed: false,
      bytesInspected: 0,
      scriptCount: 0,
      formCount: 0,
    });
    expect(result.findings.some(({ id }) => id.startsWith("browser-"))).toBe(false);
  });
});

describe("Anthropic security summary", () => {
  it("uses Messages structured output with opaque user metadata and a 20 second deadline", async () => {
    const remediation = "HSTS에 양수 max-age를 설정하세요.";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe("claude-sonnet-5");
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(body.metadata).toEqual({ user_id: "scan_user" });
      expect(body.output_config).toMatchObject({ format: { type: "json_schema" } });
      const messages = body.messages as Array<{ content: string }>;
      const input = JSON.parse(messages[0]?.content ?? "") as unknown;
      expect(input).toEqual({
        deterministicRiskLevel: "medium",
        activeFindings: [{ id: "strict-transport-security", severity: "medium", remediation }],
      });
      const serializedBody = JSON.stringify(body);
      expect(serializedBody).not.toContain("sensitive-header-value");
      expect(serializedBody).not.toContain(targetOrigin);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return completedAnthropicResponse("보안 헤더 누락을 먼저 개선하세요.", [remediation]);
    });
    const summarize = createAnthropicSecuritySummarizer({
      apiKey: "test-anthropic-key",
      model: "claude-sonnet-5",
      fetch: fetchMock,
    });

    expect(ANTHROPIC_SUMMARY_TIMEOUT_MS).toBe(20_000);

    await expect(
      summarize({
        targetOrigin,
        riskLevel: "medium",
        findings: [{
          id: "strict-transport-security",
          title: "HSTS",
          severity: "medium",
          status: "fail",
          evidence: "sensitive-header-value",
          remediation,
        }],
        safetyIdentifier: "scan_user",
      }),
    ).resolves.toEqual({
      overview: "보안 헤더 누락을 먼저 개선하세요.",
      priorityActions: [remediation],
    });
  });

  it.each([
    "claude-sonnet-5",
    "claude-haiku-4-5-20251001",
    "claude-opus-5",
  ] as const)("keeps the bounded structured summary in no-thinking mode for %s", async (model) => {
    const summarize = createAnthropicSecuritySummarizer({
      apiKey: "test-anthropic-key",
      model,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.model).toBe(model);
        expect(body.max_tokens).toBe(600);
        expect(body.thinking).toEqual({ type: "disabled" });
        return completedAnthropicResponse("간단한 요약", []);
      },
    });

    await expect(summarize({
      targetOrigin,
      riskLevel: "minimal",
      findings: [],
      safetyIdentifier: "scan_user",
    })).resolves.toEqual({ overview: "간단한 요약", priorityActions: [] });
  });

  it("rejects an incomplete model response instead of marking AI as used", async () => {
    const summarize = createAnthropicSecuritySummarizer({
      apiKey: "test-anthropic-key",
      model: "claude-haiku-4-5-20251001",
      fetch: async () => completedAnthropicResponse("불완전한 요약", [], "max_tokens"),
    });

    await expect(
      summarize({ targetOrigin, riskLevel: "medium", findings: [], safetyIdentifier: "scan_user" }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("rejects priority actions not present in deterministic remediations", async () => {
    const summarize = createAnthropicSecuritySummarizer({
      apiKey: "test-anthropic-key",
      model: "claude-opus-5",
      fetch: async () => completedAnthropicResponse("요약", ["모델이 새로 만든 조치"]),
    });

    await expect(
      summarize({ targetOrigin, riskLevel: "medium", findings: [], safetyIdentifier: "scan_user" }),
    ).rejects.toThrow(/deterministic remediation set/);
  });

  it("propagates a caller abort signal to the Anthropic request", async () => {
    let markRequestStarted: (() => void) | undefined;
    let requestSignal: AbortSignal | null | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const summarize = createAnthropicSecuritySummarizer({
      apiKey: "test-anthropic-key",
      model: "claude-sonnet-5",
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        requestSignal = init?.signal;
        markRequestStarted?.();
        requestSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      }),
    });
    const controller = new AbortController();
    const pending = summarize({
      targetOrigin,
      riskLevel: "minimal",
      findings: [],
      safetyIdentifier: "scan_user",
    }, controller.signal);

    await requestStarted;
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(requestSignal?.aborted).toBe(true);
  });
});
