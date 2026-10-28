import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { installFeatureAvailability } from "./feature-availability.ts";

test("disabled live routes, webhook and websocket handshakes reject before handlers", async () => {
  const app = Fastify();
  installFeatureAvailability(app, { ENABLE_LIVE_CLASSES: "false", ENABLE_ONLINE_PAYMENTS: "false" });
  let calls = 0;
  const paths = ["/api/live/sessions", "/api/live/livekit/webhook", "/api/board/boards/123/ws",
    "/api/board/boards/123/ticket", "/api/fees/invoices/123/pay"];
  for (const path of paths) app.route({ method: ["GET", "POST"], url: path, handler: () => { calls++; return {}; } });
  app.get("/api/fees/invoices", () => ({ items: [], total: 0 }));
  app.get("/api/board/templates", () => ({ items: [], total: 0 }));
  for (const path of paths) {
    const response = await app.inject({ method: "POST", url: path });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, "FEATURE_DISABLED");
  }
  assert.equal(calls, 0, "disabled handlers must never execute");
  assert.equal((await app.inject("/api/fees/invoices")).statusCode, 200);
  assert.equal((await app.inject("/api/board/templates")).statusCode, 200);
  await app.close();
});

test("feature guards preserve existing enabled routes", async () => {
  const app = Fastify();
  installFeatureAvailability(app, { ENABLE_LIVE_CLASSES: "true" });
  app.get("/api/live/sessions", () => ({ items: [], total: 0 }));
  assert.equal((await app.inject("/api/live/sessions")).statusCode, 200);
  await app.close();
});
