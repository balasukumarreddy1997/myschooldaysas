import type { FastifyInstance } from "fastify";

/** Apply before registering routes, including webhook and websocket routes. */
export function installFeatureAvailability(app: FastifyInstance, env: NodeJS.ProcessEnv = process.env): void {
  app.addHook("onRequest", async (request, reply) => {
    const path = request.routeOptions.url ?? request.url.split("?")[0] ?? "";
    const liveDisabled = env.ENABLE_LIVE_CLASSES === "false" &&
      (path.startsWith("/api/live/") || path.startsWith("/api/board/boards/"));
    const paymentsDisabled = env.ENABLE_ONLINE_PAYMENTS === "false" &&
      /^\/api\/fees\/invoices\/[^/]+\/pay$/.test(path);
    if (liveDisabled || paymentsDisabled) {
      return reply.code(503).send({
        error: {
          code: "FEATURE_DISABLED",
          message: liveDisabled
            ? "Live classes are temporarily unavailable in this release."
            : "Online payments are temporarily unavailable. Contact the school about fee payments.",
          requestId: request.id,
        },
      });
    }
  });
}
