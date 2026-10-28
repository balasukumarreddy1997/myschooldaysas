import test from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeConfig } from "./config.ts";

test("development config requires a valid port but allows unconfigured integrations", () => {
  const config = loadRuntimeConfig({ NODE_ENV: "development", PORT: "8080" });
  assert.equal(config.PORT, 8080);
});

test("development config treats blank optional LiveKit URLs as unconfigured", () => {
  const config = loadRuntimeConfig({
    NODE_ENV: "development",
    PORT: "8080",
    LIVEKIT_PUBLIC_URL: "",
  });
  assert.equal(config.LIVEKIT_PUBLIC_URL, undefined);
});

test("production config rejects missing required values", () => {
  assert.throws(
    () => loadRuntimeConfig({ NODE_ENV: "production", PORT: "8080" }),
    /DATABASE_URL: Required in production/,
  );
});

test("production config rejects short secrets and development defaults", () => {
  assert.throws(
    () =>
      loadRuntimeConfig({
        NODE_ENV: "production",
        PORT: "8080",
        DATABASE_URL: "postgres://app:secret@db.example.test/campus",
        REDIS_URL: "rediss://cache.example.test",
        LIVEKIT_PUBLIC_URL: "wss://live.example.test",
        LIVEKIT_API_KEY: "live-key-123456",
        LIVEKIT_API_SECRET: "long-livekit-secret-value-which-is-long",
        RAZORPAY_KEY_ID: "razorpay-key-12345",
        RAZORPAY_KEY_SECRET: "long-razorpay-secret-value-which-is-long",
        RAZORPAY_WEBHOOK_SECRET: "long-webhook-secret-value-which-is-long",
        JWT_SECRET: "short",
        INTERNAL_API_KEY: "development-internal-key-not-real",
      }),
    /JWT_SECRET: Must be at least 32 characters in production/,
  );
});

test("production config accepts structurally valid long values", () => {
  const config = loadRuntimeConfig({
    NODE_ENV: "production",
    PORT: "8080",
    DATABASE_URL: "postgres://app:secret@db.example.test/campus",
    REDIS_URL: "rediss://cache.example.test",
    LIVEKIT_PUBLIC_URL: "wss://live.example.test",
    LIVEKIT_API_KEY: "live-key-123456",
    LIVEKIT_API_SECRET: "livekit-secret-value-more-than-thirty-two-characters",
    RAZORPAY_KEY_ID: "razorpay-key-12345",
    RAZORPAY_KEY_SECRET: "razorpay-secret-value-more-than-thirty-two-characters",
    RAZORPAY_WEBHOOK_SECRET: "webhook-secret-value-more-than-thirty-two-characters",
    JWT_SECRET: "jwt-secret-value-more-than-thirty-two-characters",
    INTERNAL_API_KEY: "internal-key-value-more-than-thirty-two-characters",
  });
  assert.equal(config.NODE_ENV, "production");
});

const coreProduction = {
  NODE_ENV: "production",
  PORT: "8080",
  DATABASE_URL: "postgres://localhost/campus",
  JWT_SECRET: "jwt-test-fixture-more-than-thirty-two-characters",
  INTERNAL_API_KEY: "internal-test-fixture-more-than-thirty-two-characters",
  ENABLE_LIVE_CLASSES: "false",
  ENABLE_ONLINE_PAYMENTS: "false",
  ENABLE_REDIS: "false",
};

test("core-only production starts without optional provider credentials", () => {
  const config = loadRuntimeConfig(coreProduction);
  assert.equal(config.ENABLE_LIVE_CLASSES, false);
  assert.equal(config.ENABLE_ONLINE_PAYMENTS, false);
  assert.equal(config.ENABLE_REDIS, false);
});

test("core-only production still rejects missing authentication secrets", () => {
  assert.throws(
    () => loadRuntimeConfig({ ...coreProduction, JWT_SECRET: undefined }),
    /JWT_SECRET: Required in production/,
  );
});

test("re-enabled features still require their production credentials", () => {
  for (const [flag, credential] of [
    ["ENABLE_LIVE_CLASSES", "LIVEKIT_API_SECRET"],
    ["ENABLE_ONLINE_PAYMENTS", "RAZORPAY_KEY_SECRET"],
    ["ENABLE_REDIS", "REDIS_URL"],
  ]) {
    assert.throws(
      () => loadRuntimeConfig({ ...coreProduction, [flag!]: "true" }),
      new RegExp(`${credential}: Required in production`),
    );
  }
});

test("invalid feature switches cannot silently disable security requirements", () => {
  assert.throws(() => loadRuntimeConfig({ ...coreProduction, ENABLE_LIVE_CLASSES: "0" }));
});
