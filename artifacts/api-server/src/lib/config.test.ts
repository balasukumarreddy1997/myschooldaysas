import test from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeConfig } from "./config.ts";

test("development config requires a valid port but allows unconfigured integrations", () => {
  const config = loadRuntimeConfig({ NODE_ENV: "development", PORT: "8080" });
  assert.equal(config.PORT, 8080);
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
