/**
 * http.ts — response envelopes and request parsing.
 *
 * Every successful response is `{ success: true, data, message?, pagination? }`.
 * Input is parsed through Zod here so a route handler only ever sees typed,
 * validated values; unknown keys are stripped, which is what prevents mass
 * assignment of fields like `status` or `verifiedBy`.
 */
import type { Context } from "hono";
import type { z } from "zod";
import { AppError } from "./errors.ts";

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function ok<T>(c: Context, data: T, message?: string, status: 200 | 201 = 200) {
  return c.json({ success: true as const, data, ...(message ? { message } : {}) }, status);
}

export function created<T>(c: Context, data: T, message?: string) {
  return ok(c, data, message, 201);
}

export function paged<T>(c: Context, result: { rows: T[]; pagination: PaginationMeta }, extra?: Record<string, unknown>) {
  return c.json({ success: true as const, data: result.rows, pagination: result.pagination, ...(extra ?? {}) });
}

export function paginationMeta(page: number, limit: number, total: number): PaginationMeta {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

export function zodFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".") || "_";
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError("VALIDATION_ERROR", "Some fields are invalid. Please review and try again.", {
      fields: zodFields(result.error),
    });
  }
  return result.data;
}

export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/json")) {
    throw new AppError("BAD_REQUEST", "Request body must be JSON (Content-Type: application/json).");
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new AppError("BAD_REQUEST", "Request body is not valid JSON.");
  }
  return parse(schema, body);
}

export function readQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  return parse(schema, c.req.query());
}

/** Route ids are positive integers; anything else cannot exist, so it is a 404. */
export function readId(c: Context, name = "id"): number {
  const raw = c.req.param(name);
  const id = Number(raw);
  if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0 || id > 4_294_967_295) {
    throw new AppError("NOT_FOUND", "Record not found.");
  }
  return id;
}
