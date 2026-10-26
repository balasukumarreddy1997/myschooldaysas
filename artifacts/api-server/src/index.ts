import { loadRuntimeConfig } from "./lib/config";
import Fastify from "fastify";
import fastifyExpress from "@fastify/express";

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

const server = Fastify({
  bodyLimit: 1024 * 1024,
  connectionTimeout: 10_000,
  requestTimeout: 30_000,
  logger: false,
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Graceful shutdown started");
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  try {
    await server.close();
    await pool.end();
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "Graceful shutdown failed");
    process.exit(1);
  }
}

try {
  await server.register(fastifyExpress);
  server.use(app);
  await assertLeastPrivilegeDatabaseRole(pool);
  await server.listen({ port, host: "0.0.0.0" });
  server.server.headersTimeout = 10_000;
  logger.info({ port, runtime: "fastify", expressCompatibility: true }, "Server listening");
} catch (error) {
  logger.error({ err: error }, "API server startup failed");
  await pool.end();
  process.exit(1);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
