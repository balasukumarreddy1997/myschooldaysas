import app from "./app";
import { logger } from "./lib/logger";
import { assertLeastPrivilegeDatabaseRole, pool } from "@workspace/db";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

function assertProdConfig(): void {
  if (process.env.NODE_ENV !== "production") return;
  const required = [
    "DATABASE_URL",
    "JWT_SECRET",
    "INTERNAL_API_KEY",
    "REDIS_URL",
    "LIVEKIT_PUBLIC_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_WEBHOOK_SECRET",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Production configuration is incomplete: ${missing.join(", ")}`);
  }
  for (const key of ["JWT_SECRET", "INTERNAL_API_KEY"]) {
    const value = process.env[key] ?? "";
    if (value.length < 32 || /development|change.?me|example/i.test(value)) {
      throw new Error(`${key} must be a real value of at least 32 characters in production.`);
    }
  }
}

assertProdConfig();

const server = app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  try {
    await assertLeastPrivilegeDatabaseRole(pool);
    logger.info({ port }, "Server listening");
  } catch (error) {
    logger.error({ err: error }, "Database role verification failed");
    server.close(() => process.exit(1));
  }
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Graceful shutdown started");
  server.close(async (error) => {
    if (error) logger.error({ err: error }, "HTTP server close failed");
    await pool.end();
    process.exit(error ? 1 : 0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
