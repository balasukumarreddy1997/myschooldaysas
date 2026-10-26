import express, { type Express } from "express";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()");
  next();
});
app.use(express.json({ limit: "1mb" }));

app.use("/api", router);

app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(error);
  const candidate = error as { status?: number; statusCode?: number; code?: string; message?: string };
  const status = candidate.status ?? candidate.statusCode ?? 500;
  const safeStatus = status >= 400 && status < 500 ? status : 500;
  const code = safeStatus === 500 ? "INTERNAL_ERROR" : candidate.code ?? "REQUEST_FAILED";
  const message =
    safeStatus === 500
      ? "An unexpected error occurred."
      : candidate.message ?? "The request could not be completed.";
  if (safeStatus === 500) logger.error({ err: error, requestId: req.id }, "Request failed");
  res.status(safeStatus).json({ error: { code, message, requestId: req.id } });
});

export default app;
