import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { parse as parseCookie, serialize as serializeCookie } from "cookie";
import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "../config.js";

const SESSION_COOKIE = "edusafety_admin";
const CSRF_COOKIE = "edusafety_csrf";
const SESSION_SECONDS = 8 * 60 * 60;

interface AdminSession {
  readonly sub: string;
  readonly role: "admin";
  readonly exp: number;
  readonly csrfHash: string;
}

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function createPasswordScrypt(password: string, salt = randomBytes(16)): Promise<string> {
  const hash = await scrypt(password, salt);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPasswordScrypt(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltEncoded, hashEncoded, extra] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltEncoded || !hashEncoded || extra !== undefined) return false;
  try {
    const expected = Buffer.from(hashEncoded, "base64url");
    const actual = await scrypt(password, Buffer.from(saltEncoded, "base64url"));
    return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function csrfHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function signSession(payload: AdminSession, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function readSession(token: string | undefined, secret: string, now: Date): AdminSession | null {
  if (!token) return null;
  const [encoded, providedSignature, extra] = token.split(".");
  if (!encoded || !providedSignature || extra !== undefined) return null;
  const expectedSignature = createHmac("sha256", secret).update(encoded).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(providedSignature, "base64url");
  } catch {
    return null;
  }
  if (provided.byteLength !== expectedSignature.byteLength || !timingSafeEqual(provided, expectedSignature)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as AdminSession;
    if (
      payload.role !== "admin" ||
      typeof payload.sub !== "string" ||
      typeof payload.exp !== "number" ||
      typeof payload.csrfHash !== "string" ||
      payload.exp <= Math.floor(now.getTime() / 1000)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function cookieOptions(config: AppConfig) {
  return {
    path: "/",
    secure: config.nodeEnv === "production",
    sameSite: "strict" as const,
    maxAge: SESSION_SECONDS,
  };
}

export class AdminAuth {
  public constructor(
    private readonly config: AppConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async authenticate(username: string, password: string): Promise<boolean> {
    const usernameMatches = username === this.config.admin.username;
    const passwordMatches = await verifyPasswordScrypt(password, this.config.admin.passwordScrypt);
    return usernameMatches && passwordMatches;
  }

  public startSession(response: Response): { csrfToken: string } {
    const csrfToken = randomBytes(32).toString("base64url");
    const payload: AdminSession = {
      sub: this.config.admin.id,
      role: "admin",
      exp: Math.floor(this.now().getTime() / 1000) + SESSION_SECONDS,
      csrfHash: csrfHash(csrfToken),
    };
    response.append(
      "Set-Cookie",
      serializeCookie(SESSION_COOKIE, signSession(payload, this.config.admin.sessionSecret), {
        ...cookieOptions(this.config),
        httpOnly: true,
      }),
    );
    response.append(
      "Set-Cookie",
      serializeCookie(CSRF_COOKIE, csrfToken, {
        ...cookieOptions(this.config),
        httpOnly: false,
      }),
    );
    return { csrfToken };
  }

  public endSession(response: Response): void {
    response.append(
      "Set-Cookie",
      serializeCookie(SESSION_COOKIE, "", {
        ...cookieOptions(this.config),
        httpOnly: true,
        maxAge: 0,
      }),
    );
    response.append(
      "Set-Cookie",
      serializeCookie(CSRF_COOKIE, "", {
        ...cookieOptions(this.config),
        httpOnly: false,
        maxAge: 0,
      }),
    );
  }

  public requireAdmin = (request: Request, response: Response, next: NextFunction): void => {
    const cookies = parseCookie(request.headers.cookie ?? "");
    const session = readSession(cookies[SESSION_COOKIE], this.config.admin.sessionSecret, this.now());
    if (!session || session.sub !== this.config.admin.id) {
      response.status(401).json({ error: { code: "ADMIN_AUTH_REQUIRED", message: "관리자 인증이 필요합니다." } });
      return;
    }
    response.locals.adminId = session.sub;
    response.locals.adminSession = session;
    next();
  };

  public requireAdminPage = (request: Request, response: Response, next: NextFunction): void => {
    const cookies = parseCookie(request.headers.cookie ?? "");
    const session = readSession(cookies[SESSION_COOKIE], this.config.admin.sessionSecret, this.now());
    if (!session || session.sub !== this.config.admin.id) {
      response.redirect(303, "/admin/login");
      return;
    }
    next();
  };

  public requireCsrf = (request: Request, response: Response, next: NextFunction): void => {
    const cookies = parseCookie(request.headers.cookie ?? "");
    const header = request.get("x-csrf-token");
    const cookieToken = cookies[CSRF_COOKIE];
    const session = response.locals.adminSession as AdminSession | undefined;
    if (
      !header ||
      !cookieToken ||
      header !== cookieToken ||
      !session ||
      csrfHash(header) !== session.csrfHash
    ) {
      response.status(403).json({ error: { code: "CSRF_INVALID", message: "요청 검증 토큰이 올바르지 않습니다." } });
      return;
    }
    next();
  };
}
