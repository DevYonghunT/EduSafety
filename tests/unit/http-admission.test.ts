import { ConcurrencyGate, FixedWindowRateLimiter } from "../../src/http/admission-control.js";
import { isTrustedProxyAddress } from "../../src/http/client-address.js";

describe("bounded HTTP admission primitives", () => {
  it("bounds limiter memory and emits a deterministic retry interval", () => {
    let currentTime = 0;
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 5_000,
      maxKeys: 2,
      now: () => currentTime,
    });
    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("a")).toEqual({ allowed: false, retryAfterSeconds: 5 });
    expect(limiter.consume("b").allowed).toBe(true);
    expect(limiter.consume("c").allowed).toBe(true);
    expect(limiter.size).toBe(2);
    currentTime = 5_001;
    expect(limiter.consume("c").allowed).toBe(true);
  });

  it("releases concurrency exactly once", () => {
    const gate = new ConcurrencyGate(1);
    const release = gate.tryAcquire();
    expect(release).not.toBeNull();
    expect(gate.tryAcquire()).toBeNull();
    release?.();
    release?.();
    expect(gate.active).toBe(0);
    expect(gate.tryAcquire()).not.toBeNull();
  });

  it("trusts only local and private reverse-proxy peers", () => {
    expect(isTrustedProxyAddress("127.0.0.1")).toBe(true);
    expect(isTrustedProxyAddress("::ffff:10.0.0.2")).toBe(true);
    expect(isTrustedProxyAddress("fd00::1")).toBe(true);
    expect(isTrustedProxyAddress("203.0.113.9")).toBe(false);
    expect(isTrustedProxyAddress("2001:db8::1")).toBe(false);
  });
});
