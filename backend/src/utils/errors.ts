/**
 * errors.ts — the application's error vocabulary.
 *
 * Services throw AppError; the central error handler turns it into the
 * `{ success: false, error: { code, message, fields? } }` envelope. Anything that
 * is not an AppError is treated as a 500 and its message is never shown.
 */
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "VALIDATION_ERROR"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  VALIDATION_ERROR: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: ContentfulStatusCode;
  readonly fields?: Record<string, string>;

  constructor(code: ErrorCode, message: string, options: { fields?: Record<string, string>; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.fields = options.fields;
  }
}

export const badRequest = (message: string) => new AppError("BAD_REQUEST", message);
export const unauthorized = (message = "Please sign in to continue.") => new AppError("UNAUTHORIZED", message);
export const forbidden = (message = "You do not have permission to perform this action.") =>
  new AppError("FORBIDDEN", message);
export const notFound = (what = "Record") => new AppError("NOT_FOUND", `${what} not found.`);
export const conflict = (message: string) => new AppError("CONFLICT", message);
export const invalid = (message: string, fields?: Record<string, string>) =>
  new AppError("VALIDATION_ERROR", message, { fields });

/** Walks `cause` links to the innermost error (Drizzle wraps driver errors). */
export function rootCause(err: unknown): unknown {
  let current = err;
  for (let i = 0; i < 10; i++) {
    const next = (current as { cause?: unknown } | null)?.cause;
    if (!next) break;
    current = next;
  }
  return current;
}

/** True when a MariaDB unique constraint rejected the write (ER_DUP_ENTRY). */
export function isDuplicateKey(err: unknown): boolean {
  let current: unknown = err;
  for (let i = 0; i < 10 && current; i++) {
    if ((current as { code?: string }).code === "ER_DUP_ENTRY") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
