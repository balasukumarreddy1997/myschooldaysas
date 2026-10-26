import { loadRuntimeConfig } from "./lib/config";

const config = loadRuntimeConfig();
const [appModule, loggerModule, dbModule] = await Promise.all([
  import("./app"),
  import("./lib/logger"),
  import("@workspace/db"),
]);
const app = appModule.default;
const { logger } = loggerModule;
const { assertLeastPrivilegeDatabaseRole, pool } = dbModule;
const port = config.PORT;

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
