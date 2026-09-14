/**
 * error-handler.ts — the single exit point for failures.
 *
 * Guarantees:
 *   1. the body is always `{ success: false, error: { code, message, fields? } }`
 *   2. internal messages and stack traces never reach a client
 *   3. every 5xx is logged with its root cause and request id
 */
import type { ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import type { AppEnv } from "../types.ts";
import { AppError, isDuplicateKey, rootCause, type ErrorCode } from "../utils/errors.ts";
import { zodFields } from "../utils/http.ts";
import { logger } from "../utils/logger.ts";

function normalise(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new AppError("VALIDATION_ERROR", "Some fields are invalid. Please review and try again.", {
      fields: zodFields(err),
    });
  }
  if (err instanceof HTTPException) {
    const byStatus: Partial<Record<number, ErrorCode>> = {
      400: "BAD_REQUEST",
      401: "UNAUTHORIZED",
      403: "FORBIDDEN",
      404: "NOT_FOUND",
      409: "CONFLICT",
      413: "PAYLOAD_TOO_LARGE",
      429: "RATE_LIMITED",
    };
    const code = byStatus[err.status];
    if (code) return new AppError(code, err.message || "The request could not be processed.");
  }
  if (isDuplicateKey(err)) {
    // Services check uniqueness first; this catches the race where two requests
    // pass that check at the same moment and the constraint decides.
    return new AppError("CONFLICT", "A record with the same reference already exists.", { cause: err });
  }
  return new AppError("INTERNAL_ERROR", "Something went wrong on our side. Please try again.", { cause: err });
}

export const onError: ErrorHandler<AppEnv> = (err, c) => {
  const appErr = normalise(err);
  const log = c.get("log") ?? logger;

  if (appErr.status >= 500) {
    log.error("unhandled error", {
      method: c.req.method,
      path: c.req.path,
      cause: rootCause(appErr.cause ?? err),
      err: err instanceof Error ? err : undefined,
    });
  } else {
    log.debug("request rejected", { code: appErr.code, status: appErr.status, path: c.req.path, fields: appErr.fields });
  }

  return c.json(
    {
      success: false as const,
      error: {
        code: appErr.code,
        message: appErr.message,
        ...(appErr.fields ? { fields: appErr.fields } : {}),
        requestId: c.get("requestId"),
      },
    },
    appErr.status,
  );
};

export const onNotFound: NotFoundHandler<AppEnv> = (c) =>
  c.json(
    { success: false as const, error: { code: "NOT_FOUND", message: "The requested resource does not exist." } },
    404,
  );
