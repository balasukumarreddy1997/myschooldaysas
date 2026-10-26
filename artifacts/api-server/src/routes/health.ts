import { Router, type IRouter } from "express";
import { createConnection } from "node:net";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

function checkRedis(): Promise<void> {
  const rawUrl = process.env.REDIS_URL;
  if (!rawUrl) return Promise.reject(new Error("REDIS_URL is not configured."));

  let redisUrl: URL;
  try {
    redisUrl = new URL(rawUrl);
  } catch {
    return Promise.reject(new Error("REDIS_URL is invalid."));
  }
  if (redisUrl.protocol !== "redis:") return Promise.reject(new Error("Only redis:// URLs are supported by the readiness probe."));

  return new Promise((resolve, reject) => {
    const socket = createConnection({
      host: redisUrl.hostname,
      port: Number(redisUrl.port || 6379),
    });
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy(new Error("Redis readiness check timed out."));
    }, 1_000);

    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };

    socket.once("connect", () => {
      const password = decodeURIComponent(redisUrl.password);
      if (password) {
        const username = decodeURIComponent(redisUrl.username);
        const args = username
          ? ["AUTH", username, password]
          : ["AUTH", password];
        socket.write(`*${args.length}\r\n${args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join("")}`);
      }
      socket.write("*1\r\n$4\r\nPING\r\n");
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.includes("-ERR") || response.includes("-WRONGPASS")) {
        finish(new Error("Redis readiness check was rejected."));
      } else if (response.includes("+PONG")) {
        finish();
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("timeout", () => finish(new Error("Redis readiness check timed out.")));
  });
}

router.get("/ready", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    await checkRedis();
    res.json({ status: "ready" });
  } catch {
    res.status(503).json({ status: "not_ready" });
  }
});

export default router;
