import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const wallet = Wallet.createRandom();
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test.invalid/edusafety",
    EAS_ATTESTER_ADDRESS: wallet.address,
    EAS_ATTESTER_PRIVATE_KEY: wallet.privateKey,
    EAS_TRUSTED_ATTESTER_ADDRESSES: wallet.address,
    ADMIN_ID: "test-admin",
    ADMIN_USERNAME: "admin@example.test",
    ADMIN_PASSWORD_SCRYPT: "scrypt$c2FsdA$aGFzaA",
    ADMIN_SESSION_SECRET: "x".repeat(43),
    ...overrides,
  };
}

describe("security scan configuration", () => {
  it("enables only exact HTTPS origins without retaining AI credentials in app config", () => {
    const config = loadConfig(environment({
      SECURITY_SCAN_ALLOWED_ORIGINS: "https://school.example,https://review.example",
      ANTHROPIC_API_KEY: "request-only-key-must-not-be-read",
      ANTHROPIC_MODEL: "claude-opus-5",
    }));

    expect(config.securityScan).toEqual({
      allowedOrigins: new Set(["https://school.example", "https://review.example"]),
      dynamicTargetsEnabled: false,
      timeoutMs: 5_000,
    });
    expect(JSON.stringify(config)).not.toContain("request-only-key-must-not-be-read");
  });

  it("stays disabled without an operator-owned allowlist", () => {
    expect(loadConfig(environment()).securityScan).toBeUndefined();
  });

  it("enables dynamic URL input only with an explicit true value", () => {
    expect(loadConfig(environment({ SECURITY_SCAN_DYNAMIC_TARGETS_ENABLED: "false" })).securityScan)
      .toBeUndefined();
    expect(loadConfig(environment({ SECURITY_SCAN_DYNAMIC_TARGETS_ENABLED: "true" })).securityScan)
      .toMatchObject({
        allowedOrigins: new Set(),
        dynamicTargetsEnabled: true,
        timeoutMs: 5_000,
      });
  });

  it("rejects insecure or path-bearing targets at startup", () => {
    expect(() => loadConfig(environment({ SECURITY_SCAN_ALLOWED_ORIGINS: "http://school.example" })))
      .toThrow(/must contain HTTPS origins/);
    expect(() => loadConfig(environment({ SECURITY_SCAN_ALLOWED_ORIGINS: "https://school.example/path" })))
      .toThrow(/contains an invalid origin/);
    expect(() => loadConfig(environment({ SECURITY_SCAN_ALLOWED_ORIGINS: "https://127.0.0.1" })))
      .toThrow(/using domain names/);
    expect(() => loadConfig(environment({ SECURITY_SCAN_ALLOWED_ORIGINS: "https://[::1]" })))
      .toThrow(/using domain names/);
  });
});
