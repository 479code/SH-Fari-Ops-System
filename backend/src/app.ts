/**
 * app.ts — assembles the Hono application.
 *
 * /api/v1/*  JSON API (CORS, body limit, rate limit, origin guard, no-store)
 * /*         the static HTML frontend, served from FRONTEND_DIR on the same
 *            origin so the session cookie can stay SameSite=Strict.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { resolve } from "node:path";
import { env } from "./config/env.ts";
import { pingDb } from "./db/client.ts";
import { onError, onNotFound } from "./middleware/error-handler.ts";
import { rateLimit } from "./middleware/rate-limit.ts";
import { requestContext } from "./middleware/request-context.ts";
import { apiCors, headers, noStore, originGuard } from "./middleware/security.ts";
import { authRoutes } from "./routes/auth.routes.ts";
import { cashRoutes, debtorRoutes, expenseRoutes } from "./routes/finance.routes.ts";
import { auditRoutes, dashboardRoutes, exceptionRoutes, lookupRoutes, reportRoutes, searchRoutes } from "./routes/insights.routes.ts";
import { dsrRoutes, gitRoutes, receiptRoutes, rttRoutes, stockRoutes } from "./routes/operations.routes.ts";
import {
  bankRoutes,
  narrationRoutes,
  productRoutes,
  pumpRoutes,
  roleRoutes,
  settingsRoutes,
  stationRoutes,
  tankRoutes,
  userRoutes,
} from "./routes/setup.routes.ts";
import type { AppEnv } from "./types.ts";
import { AppError } from "./utils/errors.ts";

export function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", requestContext);
  app.use("*", headers);
  app.onError(onError);

  const api = new Hono<AppEnv>();
  api.onError(onError);
  api.use("*", apiCors);
  api.use("*", noStore);
  api.use(
    "*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: () => {
        throw new AppError("PAYLOAD_TOO_LARGE", "Request body is too large.");
      },
    }),
  );
  api.use("*", rateLimit({ windowMs: 60_000, max: env.API_RATE_LIMIT_PER_MINUTE, keyPrefix: "api" }));
  api.use("*", originGuard);

  api.get("/health", async (c) => {
    const database = await pingDb();
    return c.json({ success: database, data: { status: database ? "ok" : "degraded", database: database ? "up" : "down" } }, database ? 200 : 503);
  });

  api.route("/auth", authRoutes);
  api.route("/lookups", lookupRoutes);
  api.route("/search", searchRoutes);
  api.route("/dashboard", dashboardRoutes);
  api.route("/exceptions", exceptionRoutes);

  api.route("/receipts", receiptRoutes);
  api.route("/git-orders", gitRoutes);
  api.route("/dsr", dsrRoutes);
  api.route("/rtt", rttRoutes);
  api.route("/stock", stockRoutes);

  api.route("/cash", cashRoutes);
  api.route("/debtors", debtorRoutes);
  api.route("/expenses", expenseRoutes);

  api.route("/reports", reportRoutes);
  api.route("/audit", auditRoutes);

  api.route("/stations", stationRoutes);
  api.route("/tanks", tankRoutes);
  api.route("/pumps", pumpRoutes);
  api.route("/products", productRoutes);
  api.route("/narrations", narrationRoutes);
  api.route("/banks", bankRoutes);
  api.route("/users", userRoutes);
  api.route("/roles", roleRoutes);
  api.route("/settings", settingsRoutes);

  api.notFound(onNotFound);
  app.route("/api/v1", api);
  // Unmatched /api paths must not fall through to the static handler.
  app.all("/api/*", onNotFound);

  if (env.FRONTEND_DIR) {
    const root = resolve(import.meta.dir, "..", env.FRONTEND_DIR);
    app.use(
      "/*",
      serveStatic({
        root,
        onFound: (path, c) => {
          // HTML must revalidate so a deploy is picked up; assets can be cached briefly.
          c.header("Cache-Control", path.endsWith(".html") ? "no-cache" : "public, max-age=300");
        },
      }),
    );
  }
  app.notFound(onNotFound);
  return app;
}
