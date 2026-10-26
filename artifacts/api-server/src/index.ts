import { loadRuntimeConfig } from "./lib/config";
import Fastify from "fastify";
import websocket from "@fastify/websocket";

const config = loadRuntimeConfig();
const [routesModule, loggerModule, dbModule] = await Promise.all([
  import("./routes"),
  import("./lib/logger"),
  import("@workspace/db"),
]);
const routes = routesModule.default;
const { logger } = loggerModule;
const { assertLeastPrivilegeDatabaseRole, pool } = dbModule;
const port = config.PORT;

const server = Fastify({
  bodyLimit: 1024 * 1024,
  connectionTimeout: 10_000,
  requestTimeout: 30_000,
  logger: false,
});

const requestStartedAt = new WeakMap<object, number>();
server.decorateReply("json", function (this: import("fastify").FastifyReply, payload: unknown) {
  return this.send(payload);
});
server.addHook("onRequest", async (request) => {
  requestStartedAt.set(request, Date.now());
});
server.addHook("onSend", async (_request, reply, payload) => {
  reply
    .header("X-Content-Type-Options", "nosniff")
    .header("Referrer-Policy", "no-referrer")
    .header("X-Frame-Options", "DENY")
    .header("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()");
  return payload;
});
server.addHook("onResponse", async (request, reply) => {
  logger.info(
    {
      req: {
        id: request.id,
        method: request.method,
        url: request.url.split("?")[0],
      },
      res: { statusCode: reply.statusCode },
      responseTime: Date.now() - (requestStartedAt.get(request) ?? Date.now()),
    },
    "request completed",
  );
});
server.setErrorHandler((error, request, reply) => {
  const candidate = error as { status?: number; statusCode?: number; code?: string; message?: string };
  const status = candidate.statusCode ?? candidate.status ?? 500;
  const safeStatus = status >= 400 && status < 500 ? status : 500;
  const code = safeStatus === 500 ? "INTERNAL_ERROR" : candidate.code ?? "REQUEST_FAILED";
  const message =
    safeStatus === 500
      ? "An unexpected error occurred."
      : candidate.message ?? "The request could not be completed.";
  if (safeStatus === 500) logger.error({ err: error, requestId: request.id }, "Request failed");
  return reply.code(safeStatus).send({ error: { code, message, requestId: request.id } });
});
server.setNotFoundHandler((request, reply) =>
  reply.code(404).send({
    error: { code: "NOT_FOUND", message: "Route not found.", requestId: request.id },
  }),
);

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
  await server.register(websocket, { options: { maxPayload: 64 * 1024 } });
  await server.register(routes, { prefix: "/api" });
  await assertLeastPrivilegeDatabaseRole(pool);
  await server.listen({ port, host: "0.0.0.0" });
  server.server.headersTimeout = 10_000;
  logger.info({ port, runtime: "fastify" }, "Server listening");
} catch (error) {
  logger.error({ err: error }, "API server startup failed");
  await pool.end();
  process.exit(1);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
