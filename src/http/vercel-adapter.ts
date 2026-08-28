import type { IncomingMessage, ServerResponse } from "node:http";
import type { Express, Request, Response } from "express";

export const VERCEL_PATH_QUERY = "__edusafety_path";
export const VERCEL_ROUTE_QUERY = "__edusafety_route";

const ALLOWED_SERVER_PATHS = [
  /^\/api(?:\/|$)/,
  /^\/health$/,
  /^\/admin\/certification$/,
  /^\/admin-certification(?:\.html)?$/,
] as const;

function allowedServerPath(pathname: string): boolean {
  return ALLOWED_SERVER_PATHS.some((pattern) => pattern.test(pathname));
}

export function restoreVercelRequestUrl(request: Pick<IncomingMessage, "url">): boolean {
  const rewritten = new URL(request.url ?? "/", "http://edusafety.internal");
  const forwardedPath = rewritten.searchParams.get(VERCEL_PATH_QUERY);
  if (forwardedPath === null) return false;

  const restored = new URL(forwardedPath, "http://edusafety.internal");
  if (
    restored.origin !== "http://edusafety.internal"
    || restored.search !== ""
    || restored.hash !== ""
    || !allowedServerPath(restored.pathname)
  ) return false;

  rewritten.searchParams.delete(VERCEL_PATH_QUERY);
  rewritten.searchParams.delete(VERCEL_ROUTE_QUERY);
  const query = rewritten.searchParams.toString();
  request.url = `${restored.pathname}${query === "" ? "" : `?${query}`}`;
  return true;
}

export function createVercelExpressHandler(getApplication: () => Promise<Express>) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!restoreVercelRequestUrl(request)) {
      writeJson(response, 404, { error: { code: "NOT_FOUND", message: "요청한 경로를 찾을 수 없습니다." } });
      return;
    }
    try {
      const application = await getApplication();
      application(request as Request, response as Response);
    } catch {
      writeJson(response, 503, {
        error: { code: "SERVER_BOOTSTRAP_FAILED", message: "인증 서버 설정 또는 데이터베이스 연결을 확인해 주세요." },
      });
    }
  };
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}
