import assert from "node:assert/strict";
import test from "node:test";
import { createFixedWindowRateLimiter } from "./admission-policy.ts";

test("public enquiry limiter rejects excess requests until its window resets", () => {
  let now = 1_000;
  const allow = createFixedWindowRateLimiter(2, 60_000, () => now);

  assert.equal(allow("198.51.100.7"), true);
  assert.equal(allow("198.51.100.7"), true);
  assert.equal(allow("198.51.100.7"), false);
  now += 60_000;
  assert.equal(allow("198.51.100.7"), true);
});

test("public enquiry limiter keeps independent client buckets", () => {
  const allow = createFixedWindowRateLimiter(1, 60_000, () => 1_000);

  assert.equal(allow("198.51.100.7"), true);
  assert.equal(allow("198.51.100.7"), false);
  assert.equal(allow("203.0.113.4"), true);
});
