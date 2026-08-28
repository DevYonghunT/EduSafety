import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { Request } from "express";

function normalizeAddress(address: string): string {
  const withoutZone = address.toLowerCase().split("%", 1)[0] ?? address.toLowerCase();
  return withoutZone.startsWith("::ffff:") ? withoutZone.slice(7) : withoutZone;
}

function isTrustedIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const first = octets[0]!;
  const second = octets[1]!;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

/**
 * Trust only directly connected loopback, link-local, or private reverse proxies.
 * Public peers cannot select their identity with X-Forwarded-For.
 */
export function isTrustedProxyAddress(address: string): boolean {
  const normalized = normalizeAddress(address);
  const version = isIP(normalized);
  if (version === 4) return isTrustedIpv4(normalized);
  if (version !== 6) return false;
  if (normalized === "::1") return true;
  const first = Number.parseInt(normalized.split(":", 1)[0] ?? "", 16);
  return Number.isFinite(first) && ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80);
}

export function requestClientKey(request: Request): string {
  const address = normalizeAddress(request.ip || request.socket.remoteAddress || "unknown");
  return createHash("sha256").update("client-ip\0").update(address).digest("base64url");
}

export function accountRateLimitKey(username: string): string {
  const normalized = username.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  return createHash("sha256").update("admin-account\0").update(normalized).digest("base64url");
}
