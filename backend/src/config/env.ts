/**
 * env.ts — the only module that reads process.env.
 *
 * Everything else imports `env` from here, so one file documents the whole
 * configuration surface and `.env.example` can be kept honest against it.
 * Validation runs at import time: a misconfigured service fails at boot with a
 * readable list instead of on the first request that touches the bad value.
 */
import { z } from "zod";

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : /^(1|true|yes|on)$/i.test(v)));

const int = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const secret = (name: string) =>
  z
    .string({ error: `${name} is required — generate one with \`openssl rand -base64 48\`` })
    .min(32, `${name} must be at least 32 characters — generate one with \`openssl rand -base64 48\``);

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const schema = z.object({
  // --- Runtime --------------------------------------------------------------
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(3000, 1, 65535),
  HOST: z.string().default("127.0.0.1"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  /** Business dates (DSR day, month-to-date) are evaluated in this zone. */
  BUSINESS_TIMEZONE: z.string().default("Africa/Lagos").refine(isValidTimeZone, "must be a valid IANA time zone"),

  // --- Database -------------------------------------------------------------
  DATABASE_HOST: z.string().min(1).default("127.0.0.1"),
  DATABASE_PORT: int(3306, 1, 65535),
  DATABASE_NAME: z.string({ error: "DATABASE_NAME is required" }).min(1),
  DATABASE_USER: z.string({ error: "DATABASE_USER is required" }).min(1),
  DATABASE_PASSWORD: z.string().default(""),
  DATABASE_POOL_SIZE: int(10, 1, 200),

  // --- Auth -----------------------------------------------------------------
  /** Keys the HMAC used to store password-reset tokens. */
  AUTH_SECRET: secret("AUTH_SECRET"),
  /** Keys the HMAC used to store session tokens, so a DB leak cannot mint sessions. */
  SESSION_SECRET: secret("SESSION_SECRET"),
  SESSION_IDLE_MINUTES: int(60, 5, 24 * 60),
  SESSION_ABSOLUTE_HOURS: int(12, 1, 24 * 7),
  LOGIN_MAX_ATTEMPTS: int(5, 1, 50),
  LOGIN_LOCKOUT_MINUTES: int(15, 1, 24 * 60),
  PASSWORD_RESET_TTL_MINUTES: int(60, 5, 7 * 24 * 60),

  // --- HTTP -----------------------------------------------------------------
  /** Comma-separated list of browser origins allowed to call the API with credentials. */
  CORS_ORIGIN: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim().replace(/\/$/, ""))
        .filter(Boolean),
    ),
  /** Directory of the static frontend, relative to the backend folder. Empty disables static serving. */
  FRONTEND_DIR: z.string().default("../frontend"),
  /** Honour X-Forwarded-For for client IPs. Enable only behind a trusted reverse proxy. */
  TRUST_PROXY: bool(false),
  API_RATE_LIMIT_PER_MINUTE: int(600, 10, 100_000),
  LOGIN_RATE_LIMIT_PER_MINUTE: int(10, 1, 100_000),

  // --- Seeding (used only by `bun run db:seed`) -------------------------------
  SEED_ADMIN_USERNAME: z.string().min(3).default("admin"),
  SEED_ADMIN_PASSWORD: z.string().optional(),
  SEED_ADMIN_NAME: z.string().default("System Administrator"),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    // The logger depends on env, so this one message goes straight to stderr.
    console.error(`Invalid environment configuration:\n${lines.join("\n")}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = load();
export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
