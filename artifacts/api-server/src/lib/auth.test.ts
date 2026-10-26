import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAccessToken,
  hashPassword,
  verifyAccessToken,
  verifyPassword,
} from "./auth.ts";

const user = {
  id: "a8d0d0d0-3c3a-4f78-9c86-000000000001",
  orgId: "b7e0e0e0-3c3a-4f78-9c86-000000000001",
  name: "Demo Teacher",
  email: "teacher@demo.edu",
  roles: ["teacher" as const],
  mustChangePassword: false,
};

test("accepts a valid signed access token", () => {
  const token = createAccessToken(user, 1_800_000_000);
  assert.deepEqual(verifyAccessToken(token, 1_800_000_100), user);
});

test("rejects a token whose payload was changed", () => {
  const token = createAccessToken(user, 1_800_000_000);
  const [header, payload, signature] = token.split(".");
  const changedPayload = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")), roles: ["org_admin"] }),
  ).toString("base64url");
  assert.equal(verifyAccessToken(`${header}.${changedPayload}.${signature}`, 1_800_000_100), null);
});

test("rejects expired tokens", () => {
  const token = createAccessToken(user, 1_800_000_000);
  assert.equal(verifyAccessToken(token, 1_800_001_000), null);
});

test("hashes passwords and rejects a different password", async () => {
  const encoded = await hashPassword("Passw0rd!");
  assert.equal(await verifyPassword("Passw0rd!", encoded), true);
  assert.equal(await verifyPassword("not-the-password", encoded), false);
});

test("rejects password hashes with unsafe work factors", async () => {
  assert.equal(
    await verifyPassword("Passw0rd!", "$scrypt$1048576$8$1$c2FsdA$a2V5"),
    false,
  );
});
