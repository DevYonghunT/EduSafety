import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { z, ZodError } from "zod";
import { AdminAuth } from "./auth/admin-auth.js";
import { StaticAnalysisService } from "./analysis/service.js";
import { AttestationSigner } from "./certification/attestation.js";
import { SAFETY_BLOCKERS } from "./certification/catalog.js";
import {
  BadgeIssueService,
  NoActivePolicyError,
  type CertificationSigner,
} from "./certification/issue-service.js";
import { PolicyService, PolicyValidationError } from "./certification/policy-service.js";
import { BadgeVerificationService, type VerificationResult } from "./certification/verification-service.js";
import type { AppConfig } from "./config.js";
import type { CertificationRepository } from "./db/repository.js";
import { GitHubCollectionError, type RepositorySourceProvider } from "./github/client.js";
import { ConcurrencyGate, FixedWindowRateLimiter } from "./http/admission-control.js";
import { accountRateLimitKey, isTrustedProxyAddress, requestClientKey } from "./http/client-address.js";
import { renderShowcaseSvg } from "./http/svg.js";

const issueSchema = z.strictObject({
  repositoryUrl: z.string().min(1).max(300),
  commitSha: z.string().regex(/^[0-9a-fA-F]{40}$/),
});
const loginSchema = z.strictObject({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(1024),
});
const policySchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  criterionIds: z.array(z.string().min(1).max(100)).max(100),
});
const emptySchema = z.strictObject({});
const revokeSchema = z.strictObject({
  reason: z.enum([
    "ISSUED_IN_ERROR",
    "POLICY_REPLACED",
    "REPOSITORY_UNAVAILABLE",
    "SECURITY_REVIEW",
    "OTHER",
  ]),
});
const uidSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export interface AppDependencies {
  readonly config: AppConfig;
  readonly repository: CertificationRepository;
  readonly sourceProvider: RepositorySourceProvider;
  readonly now?: () => Date;
  readonly signer?: CertificationSigner;
  readonly securityLimits?: Partial<AppSecurityLimits>;
  readonly authenticateAdmin?: (username: string, password: string) => Promise<boolean>;
}

export interface AppSecurityLimits {
  readonly issueMaxConcurrent: number;
  readonly issueMaxRequestsPerIp: number;
  readonly issueWindowMs: number;
  readonly loginMaxConcurrent: number;
  readonly loginMaxAttemptsPerIp: number;
  readonly loginMaxAttemptsPerAccount: number;
  readonly loginWindowMs: number;
  readonly maxTrackedKeys: number;
}

const DEFAULT_SECURITY_LIMITS: AppSecurityLimits = {
  issueMaxConcurrent: 4,
  issueMaxRequestsPerIp: 6,
  issueWindowMs: 60_000,
  loginMaxConcurrent: 2,
  loginMaxAttemptsPerIp: 10,
  loginMaxAttemptsPerAccount: 5,
  loginWindowMs: 15 * 60_000,
  maxTrackedKeys: 4_096,
};

function publicBadge(result: VerificationResult) {
  const { badge } = result;
  return {
    uid: badge.proof.uid,
    status: result.status,
    reason: result.reason,
    integrityValid: result.integrityValid,
    repository: badge.report.repository,
    commitSha: badge.report.commitSha,
    policy: {
      policyId: badge.report.policy.policyId,
      name: badge.report.policy.name,
      policyVersion: badge.report.policy.policyVersion,
      policyHash: badge.report.policy.policyHash,
      rulesetVersion: badge.report.policy.rulesetVersion,
    },
    criteria: badge.report.criteriaResults.map(({ criterionId, criterionVersion, result, summary }) => ({
      criterionId,
      criterionVersion,
      result,
      summary,
    })),
    safetyBlockers: badge.report.safetyBlockers,
    attester: badge.proof.attester,
    issuedAt: badge.proof.issuedAt,
    expiresAt: badge.proof.expiresAt,
    revokedAt: badge.revokedAt,
    revocationReason: badge.revocationReason,
    currentHead: result.currentHead,
    headMatches: result.headMatches,
    proof: {
      domain: badge.proof.domain,
      types: badge.proof.types,
      primaryType: badge.proof.primaryType,
      message: badge.proof.message,
      signature: badge.proof.signature,
      uid: badge.proof.uid,
      schemaUid: badge.proof.message.schema,
      attester: badge.proof.attester,
      canonicalPayload: badge.proof.canonicalPayload,
      statement: badge.proof.payload,
      reportSnapshot: badge.report,
    },
  };
}

function mapGithubError(error: GitHubCollectionError): { status: number; code: string } {
  switch (error.code) {
    case "INVALID_INPUT":
      return { status: 422, code: "GITHUB_INPUT_INVALID" };
    case "NOT_FOUND":
    case "PRIVATE_REPOSITORY":
      return { status: 404, code: "REPOSITORY_OR_COMMIT_NOT_FOUND" };
    case "RATE_LIMITED":
      return { status: 503, code: "GITHUB_RATE_LIMITED" };
    case "TEMPORARY_FAILURE":
      return { status: 503, code: "GITHUB_UNAVAILABLE" };
    case "EXACT_COMMIT_MISMATCH":
    case "INVALID_RESPONSE":
      return { status: 502, code: "GITHUB_INTEGRITY_ERROR" };
  }
}

function parseBody<T>(schema: z.ZodType<T>, request: Request): T {
  return schema.parse(request.body);
}

function csrfCookieToken(request: Request): string | null {
  const match = /(?:^|;\s*)edusafety_csrf=([^;]+)/.exec(request.headers.cookie ?? "");
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function appendVary(response: Response, value: string): void {
  response.appendHeader("Vary", value);
}

function originRejected(response: Response): void {
  response.status(403).json({ error: { code: "ORIGIN_NOT_ALLOWED", message: "허용되지 않은 origin입니다." } });
}

function requireAdminSameOrigin(applicationOrigin: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const origin = request.get("origin");
    if (origin) {
      appendVary(response, "Origin");
      if (origin !== applicationOrigin) {
        originRejected(response);
        return;
      }
    }
    if (request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }
    next();
  };
}

function allowPublicBadgeCors(applicationOrigin: string, allowedOrigins: ReadonlySet<string>) {
  const methods = new Set(["GET", "POST"]);
  const headers = new Set(["content-type"]);
  return (request: Request, response: Response, next: NextFunction): void => {
    const origin = request.get("origin");
    const crossOrigin = origin !== undefined && origin !== applicationOrigin;
    if (origin) appendVary(response, "Origin");
    if (crossOrigin && !allowedOrigins.has(origin)) {
      originRejected(response);
      return;
    }

    if (request.method === "OPTIONS") {
      const requestedMethod = request.get("access-control-request-method")?.toUpperCase();
      const requestedHeaders = (request.get("access-control-request-headers") ?? "")
        .split(",")
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean);
      if (
        (requestedMethod !== undefined && !methods.has(requestedMethod)) ||
        requestedHeaders.some((header) => !headers.has(header))
      ) {
        response.status(403).json({
          error: { code: "CORS_PREFLIGHT_NOT_ALLOWED", message: "허용되지 않은 CORS 사전 요청입니다." },
        });
        return;
      }
      if (crossOrigin) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Access-Control-Allow-Headers", "Content-Type");
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        response.setHeader("Access-Control-Max-Age", "600");
        appendVary(response, "Access-Control-Request-Method");
        appendVary(response, "Access-Control-Request-Headers");
      }
      response.sendStatus(204);
      return;
    }

    if (crossOrigin) response.setHeader("Access-Control-Allow-Origin", origin);
    next();
  };
}

function rateLimited(
  response: Response,
  retryAfterSeconds: number,
  code: "ADMIN_LOGIN_RATE_LIMITED" | "ISSUE_RATE_LIMITED" | "ISSUE_CAPACITY_EXCEEDED",
  message: string,
): void {
  response.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterSeconds))));
  response.status(429).json({ error: { code, message } });
}

export function createApp(dependencies: AppDependencies): express.Express {
  const { config, repository, sourceProvider } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const auth = new AdminAuth(config, now);
  const authenticateAdmin = dependencies.authenticateAdmin ?? auth.authenticate.bind(auth);
  const analysis = new StaticAnalysisService(sourceProvider, now);
  const signer = dependencies.signer ?? new AttestationSigner(config, { now });
  const issueService = new BadgeIssueService(repository, analysis, signer);
  const verificationService = new BadgeVerificationService(repository, sourceProvider, config, now);
  const policyService = new PolicyService(repository, now);
  const app = express();
  const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
  const clientDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../client-dist");
  const applicationOrigin = new URL(config.publicBaseUrl).origin;
  const securityLimits = { ...DEFAULT_SECURITY_LIMITS, ...dependencies.securityLimits };
  const rateLimitNow = () => now().getTime();
  const issueRateLimiter = new FixedWindowRateLimiter({
    limit: securityLimits.issueMaxRequestsPerIp,
    windowMs: securityLimits.issueWindowMs,
    maxKeys: securityLimits.maxTrackedKeys,
    now: rateLimitNow,
  });
  const loginIpLimiter = new FixedWindowRateLimiter({
    limit: securityLimits.loginMaxAttemptsPerIp,
    windowMs: securityLimits.loginWindowMs,
    maxKeys: securityLimits.maxTrackedKeys,
    now: rateLimitNow,
  });
  const loginAccountLimiter = new FixedWindowRateLimiter({
    limit: securityLimits.loginMaxAttemptsPerAccount,
    windowMs: securityLimits.loginWindowMs,
    maxKeys: securityLimits.maxTrackedKeys,
    now: rateLimitNow,
  });
  const loginConcurrency = new ConcurrencyGate(securityLimits.loginMaxConcurrent);
  const issueConcurrency = new ConcurrencyGate(securityLimits.issueMaxConcurrent);

  app.disable("x-powered-by");
  app.set("trust proxy", isTrustedProxyAddress);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          connectSrc: ["'self'", "https://api.github.com", "https://raw.githubusercontent.com", "https://api.anthropic.com"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          imgSrc: ["'self'", "data:"],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
        },
      },
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
  app.use("/api/admin", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use("/api/admin", requireAdminSameOrigin(applicationOrigin));
  app.use("/api/badges", allowPublicBadgeCors(applicationOrigin, config.allowedOrigins));
  app.use("/api", express.json({ limit: "16kb", strict: true }));

  app.get("/health", (_request, response) => response.json({ status: "ok" }));
  app.post("/api/admin/session", async (request, response) => {
    const credentials = parseBody(loginSchema, request);
    const ipKey = requestClientKey(request);
    const accountKey = accountRateLimitKey(credentials.username);
    const ipAdmission = loginIpLimiter.consume(ipKey);
    const accountAdmission = loginAccountLimiter.consume(accountKey);
    if (!ipAdmission.allowed || !accountAdmission.allowed) {
      rateLimited(
        response,
        Math.max(ipAdmission.retryAfterSeconds, accountAdmission.retryAfterSeconds),
        "ADMIN_LOGIN_RATE_LIMITED",
        "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      );
      return;
    }
    const release = loginConcurrency.tryAcquire();
    if (!release) {
      rateLimited(
        response,
        1,
        "ADMIN_LOGIN_RATE_LIMITED",
        "로그인 처리 용량이 가득 찼습니다. 잠시 후 다시 시도해 주세요.",
      );
      return;
    }
    let authenticated: boolean;
    try {
      authenticated = await authenticateAdmin(credentials.username, credentials.password);
    } finally {
      release();
    }
    if (!authenticated) {
      response.status(401).json({ error: { code: "ADMIN_CREDENTIALS_INVALID", message: "로그인 정보가 올바르지 않습니다." } });
      return;
    }
    loginIpLimiter.reset(ipKey);
    loginAccountLimiter.reset(accountKey);
    auth.startSession(response);
    response.json({ administrator: { id: config.admin.id, role: "admin" } });
  });
  app.get("/api/admin/session", auth.requireAdmin, (_request, response) => {
    response.json({
      administrator: { id: response.locals.adminId as string, role: "admin" },
      csrfToken: csrfCookieToken(_request),
    });
  });
  app.delete("/api/admin/session", auth.requireAdmin, auth.requireCsrf, (_request, response) => {
    auth.endSession(response);
    response.sendStatus(204);
  });

  app.get("/api/admin/certification/criteria", auth.requireAdmin, async (_request, response) => {
    const [criteria, active] = await Promise.all([repository.listCriteria(), repository.getActivePolicy()]);
    const selected = new Set(active?.snapshot.criteria.map((criterion) => criterion.criterionId) ?? []);
    response.json({
      criteria: criteria.map((criterion) => ({ ...criterion, includedInActivePolicy: selected.has(criterion.criterionId) })),
      safetyBlockers: SAFETY_BLOCKERS.map((blocker) => ({ ...blocker, locked: true })),
    });
  });
  app.get("/api/admin/certification/policies", auth.requireAdmin, async (_request, response) => {
    response.json({ policies: await repository.listPolicies() });
  });
  app.get("/api/admin/certification/policies/active", auth.requireAdmin, async (_request, response) => {
    const active = await repository.getActivePolicy();
    if (!active) {
      response.status(404).json({ error: { code: "NO_ACTIVE_POLICY", message: "활성 정책이 없습니다." } });
      return;
    }
    response.json({ policy: active });
  });
  app.post(
    "/api/admin/certification/policies",
    auth.requireAdmin,
    auth.requireCsrf,
    async (request, response) => {
      const body = parseBody(policySchema, request);
      const policy = await policyService.createDraft({
        ...body,
        administratorId: response.locals.adminId as string,
      });
      response.status(201).json({ policy });
    },
  );
  app.put(
    "/api/admin/certification/policies/:id",
    auth.requireAdmin,
    auth.requireCsrf,
    async (request, response) => {
      const body = parseBody(policySchema, request);
      const policy = await policyService.updateDraft({
        policyId: z.string().uuid().parse(request.params.id),
        ...body,
        administratorId: response.locals.adminId as string,
      });
      response.json({ policy });
    },
  );
  app.post(
    "/api/admin/certification/policies/:id/publish",
    auth.requireAdmin,
    auth.requireCsrf,
    async (request, response) => {
      parseBody(emptySchema, request);
      const policy = await policyService.publish(
        z.string().uuid().parse(request.params.id),
        response.locals.adminId as string,
      );
      response.json({ policy });
    },
  );
  app.get("/api/admin/certification/badges", auth.requireAdmin, async (_request, response) => {
    const badges = await repository.listBadges(100);
    const verified = await Promise.all(badges.map((badge) => verificationService.verify(badge)));
    response.json({ badges: verified.map(publicBadge) });
  });
  app.post(
    "/api/admin/certification/badges/:uid/revoke",
    auth.requireAdmin,
    auth.requireCsrf,
    async (request, response) => {
      const uid = uidSchema.parse(request.params.uid).toLowerCase();
      const body = parseBody(revokeSchema, request);
      const result = await repository.revokeBadge({
        uid,
        administratorId: response.locals.adminId as string,
        reason: body.reason,
        revokedAt: now().toISOString(),
      });
      if (!result) {
        response.status(404).json({ error: { code: "BADGE_NOT_FOUND", message: "인증 UID를 찾을 수 없습니다." } });
        return;
      }
      response.json({ badge: publicBadge(await verificationService.verify(result.badge)), alreadyRevoked: !result.created });
    },
  );

  app.post("/api/badges/issue", async (request, response) => {
    const body = parseBody(issueSchema, request);
    const admission = issueRateLimiter.consume(requestClientKey(request));
    if (!admission.allowed) {
      rateLimited(
        response,
        admission.retryAfterSeconds,
        "ISSUE_RATE_LIMITED",
        "인증 발급 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      );
      return;
    }
    const release = issueConcurrency.tryAcquire();
    if (!release) {
      rateLimited(response, 1, "ISSUE_CAPACITY_EXCEEDED", "인증 분석 처리 용량이 가득 찼습니다. 잠시 후 다시 시도해 주세요.");
      return;
    }
    try {
      const result = await issueService.issue(body.repositoryUrl, body.commitSha);
      if (result.outcome === "NOT_ISSUED") {
        response.status(200).json({
          outcome: result.outcome,
          decision: "FAIL",
          analysisId: result.analysisId,
          reportHash: result.reportHash,
          policy: result.report.policy,
          criteria: result.report.criteriaResults,
          safetyBlockers: result.report.safetyBlockers,
        });
        return;
      }
      const verified = await verificationService.verify(result.badge);
      response.status(result.existing ? 200 : 201).json({
        outcome: "ISSUED",
        existing: result.existing,
        badge: publicBadge(verified),
        verificationUrl: `${config.publicBaseUrl}/verify/${result.badge.proof.uid}`,
        svgUrl: `${config.publicBaseUrl}/api/badges/${result.badge.proof.uid}.svg?variant=showcase`,
      });
    } finally {
      release();
    }
  });
  app.use("/api/badges/:uid", (request, response, next) => {
    if (request.method === "GET") response.locals.publicVerificationRequest = true;
    next();
  });
  app.get("/api/badges/:uid.svg", async (request, response) => {
    z.strictObject({ variant: z.literal("showcase").optional() }).parse(request.query);
    const uid = uidSchema.parse(request.params.uid).toLowerCase();
    const result = await verificationService.getAndVerify(uid);
    if (!result) {
      response.status(404).type("text/plain").send("Badge not found");
      return;
    }
    response.setHeader("Cache-Control", "public, max-age=60, must-revalidate");
    response.type("image/svg+xml").send(renderShowcaseSvg(result));
  });
  app.get("/api/badges/:uid", async (request, response) => {
    const uid = uidSchema.parse(request.params.uid).toLowerCase();
    const result = await verificationService.getAndVerify(uid);
    if (!result) {
      response.status(404).json({ error: { code: "BADGE_NOT_FOUND", message: "인증 UID를 찾을 수 없습니다." } });
      return;
    }
    response.json({ badge: publicBadge(result) });
  });

  app.get("/admin/certification", auth.requireAdminPage, (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.sendFile(path.join(publicDirectory, "admin-certification.html"));
  });
  app.get("/admin-certification.html", auth.requireAdminPage, (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.sendFile(path.join(publicDirectory, "admin-certification.html"));
  });
  app.get("/admin/login", (_request, response) => response.sendFile(path.join(publicDirectory, "admin-login.html")));
  app.get("/verify/:uid", (_request, response) => response.sendFile(path.join(publicDirectory, "verify.html")));
  app.get("/demo", (_request, response) => response.sendFile(path.join(publicDirectory, "demo.html")));
  const staticOptions = { index: false, etag: true, maxAge: config.nodeEnv === "production" ? "1h" : 0 } as const;
  app.use(express.static(publicDirectory, staticOptions));
  app.use(express.static(clientDirectory, { ...staticOptions, index: "index.html" }));

  app.use((_request, response) => {
    response.status(404).json({ error: { code: "NOT_FOUND", message: "요청한 경로를 찾을 수 없습니다." } });
  });

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (response.headersSent) return;
    if ((error as { type?: string }).type === "entity.too.large") {
      response.status(413).json({ error: { code: "REQUEST_TOO_LARGE", message: "요청 본문이 너무 큽니다." } });
      return;
    }
    if (error instanceof ZodError || (error instanceof SyntaxError && "body" in error)) {
      response.status(400).json({ error: { code: "REQUEST_SCHEMA_INVALID", message: "요청 형식이 올바르지 않습니다." } });
      return;
    }
    if (error instanceof PolicyValidationError) {
      const status = error.code === "POLICY_NOT_FOUND" ? 404 : error.code === "POLICY_IMMUTABLE" ? 409 : 422;
      response.status(status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof NoActivePolicyError) {
      response.status(409).json({ error: { code: "NO_ACTIVE_POLICY", message: error.message } });
      return;
    }
    if (error instanceof GitHubCollectionError) {
      const mapped = mapGithubError(error);
      response.status(mapped.status).json({ error: { code: mapped.code, message: error.message } });
      return;
    }
    if (response.locals.publicVerificationRequest === true) {
      response.status(503).json({
        status: "UNVERIFIED",
        error: { code: "VERIFICATION_DATA_UNAVAILABLE", message: "검증 데이터를 일시적으로 확인할 수 없습니다." },
      });
      return;
    }
    response.status(503).json({ error: { code: "SERVICE_UNAVAILABLE", message: "요청을 안전하게 처리할 수 없습니다." } });
  };
  app.use(errorHandler);

  return app;
}
