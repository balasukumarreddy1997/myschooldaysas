// Run from the repository root after building the API:
// set -a; . ./.env; set +a; node --test scripts/tests/core-only-startup.mjs
// Uses the local campus_app DB for read-only startup/readiness checks.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

test("production-mode core API starts without optional providers", { timeout: 25000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "Load the local .env before running this check.");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: "18081",
    ENABLE_LIVE_CLASSES: "false",
    ENABLE_ONLINE_PAYMENTS: "false",
    ENABLE_REDIS: "false",
    JWT_SECRET: "isolated-test-fixture-jwt-over-thirty-two-characters",
    INTERNAL_API_KEY: "isolated-test-fixture-internal-over-thirty-two-characters",
  };
  for (const name of Object.keys(env)) {
    if (/^(LIVEKIT_|RAZORPAY_|REDIS_URL$)/.test(name)) delete env[name];
  }
  const child = spawn(process.execPath, ["artifacts/api-server/dist/index.mjs"], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  // Do not print runtime output or environment values.
  child.stdout.resume();
  child.stderr.resume();
  t.after(async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise(resolve => child.once("exit", resolve)),
      delay(3000).then(() => { if (child.exitCode === null) child.kill("SIGKILL"); }),
    ]);
  });
  const base = "http://127.0.0.1:18081";
  let started = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) assert.fail(`API exited before listening (code ${child.exitCode}).`);
    try {
      started = (await fetch(`${base}/api/healthz`)).status === 200;
      if (started) break;
    } catch { /* Wait only for the isolated child to bind its test port. */ }
    await delay(100);
  }
  assert.ok(started, "API must start without optional-provider configuration.");
  assert.equal((await fetch(`${base}/api/ready`)).status, 200);
  assert.equal((await fetch(`${base}/api/live/sessions`)).status, 503);
  assert.equal((await fetch(`${base}/api/live/livekit/webhook`, { method: "POST" })).status, 503);
  assert.equal((await fetch(`${base}/api/board/boards/test/ws`)).status, 503);
  assert.equal((await fetch(`${base}/api/fees/invoices/test/pay`, { method: "POST" })).status, 503);
  assert.equal((await fetch(`${base}/api/fees/invoices`)).status, 401, "Core fee routes must retain authentication.");
});
