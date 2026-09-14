/**
 * logger.ts — structured, one-JSON-object-per-line logging.
 *
 * Secrets are redacted by key name before anything is serialised, so passing a
 * request body or a user row to the logger can never leak a password, token or
 * hash into log storage.
 */
import { env, isProduction } from "../config/env.ts";

type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const RANK: Record<Level | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const REDACT_KEY = /pass(word)?|token|secret|cookie|authorization|hash|session_?id/i;

function sanitise(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(isProduction ? {} : { stack: value.stack }),
      ...(value.cause ? { cause: sanitise(value.cause, depth + 1) } : {}),
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return value;
  if (depth > 5) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitise(v, depth + 1));
  const out: Fields = {};
  for (const [k, v] of Object.entries(value as Fields)) {
    out[k] = REDACT_KEY.test(k) ? "[redacted]" : sanitise(v, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(bindings: Fields): Logger;
}

function create(bindings: Fields): Logger {
  const write = (level: Level, msg: string, fields?: Fields) => {
    if (RANK[level] < RANK[env.LOG_LEVEL]) return;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      msg,
      ...(sanitise(bindings) as Fields),
      ...(fields ? (sanitise(fields) as Fields) : {}),
    });
    if (level === "error" || level === "warn") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (extra) => create({ ...bindings, ...extra }),
  };
}

export const logger = create({ service: "shfari-api" });
