import test from "node:test";
import assert from "node:assert/strict";
import {
  canManageUser,
  generateTemporaryPassword,
  isValidNewPassword,
  needsPasswordRehash,
} from "./identity-security.ts";

test("temporary passwords are long, URL-safe random values", () => {
  const first = generateTemporaryPassword();
  const second = generateTemporaryPassword();
  assert.ok(first.length >= 12);
  assert.match(first, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(first, second);
});

test("password changes require at least 12 characters", () => {
  assert.equal(isValidNewPassword("shortpass1"), false);
  assert.equal(isValidNewPassword("a-stronger-password"), true);
  assert.equal(isValidNewPassword("x".repeat(257)), false);
});

test("administrator reset rights cannot cross a higher role boundary", () => {
  assert.equal(canManageUser(["campus_admin"], ["org_admin"]), false);
  assert.equal(canManageUser(["campus_admin"], ["super_admin"]), false);
  assert.equal(canManageUser(["org_admin"], ["campus_admin"]), true);
  assert.equal(canManageUser(["org_admin"], ["org_admin"]), true);
  assert.equal(canManageUser(["super_admin"], ["super_admin"]), true);
  assert.equal(canManageUser(["teacher"], ["student"]), false);
});

test("legacy password hashes are upgraded after successful verification", () => {
  assert.equal(needsPasswordRehash("$scrypt$16384$8$1$c2FsdA$a2V5"), true);
  assert.equal(needsPasswordRehash("$scrypt$131072$8$1$c2FsdA$a2V5"), false);
});
