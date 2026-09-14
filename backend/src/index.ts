/** index.ts — process entry point: HTTP server, scheduler and graceful shutdown. */
import { createApp } from "./app.ts";
import { env } from "./config/env.ts";
import { closeDb, pingDb } from "./db/client.ts";
import { startScheduler, stopScheduler } from "./jobs/scheduler.ts";
import { logger } from "./utils/logger.ts";

const app = createApp();

const server = Bun.serve({
  port: env.PORT,
  hostname: env.HOST,
  fetch: app.fetch,
});

logger.info("server started", { url: `http://${env.HOST}:${env.PORT}`, env: env.NODE_ENV, database: env.DATABASE_NAME });

if (!(await pingDb())) {
  logger.warn("database is not reachable yet — API calls will fail until it is available");
}
startScheduler();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });
  stopScheduler();
  await server.stop();
  await closeDb();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
