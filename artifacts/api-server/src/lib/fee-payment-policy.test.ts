import assert from "node:assert/strict";
import test from "node:test";
import { canParentPayInvoice, isMockPaymentEnvironment } from "./fee-payment-policy.ts";

test("mock payments are enabled only in development and test", () => {
  assert.equal(isMockPaymentEnvironment("development"), true);
  assert.equal(isMockPaymentEnvironment("test"), true);
  assert.equal(isMockPaymentEnvironment("production"), false);
  assert.equal(isMockPaymentEnvironment(undefined), false);
});

test("parents can pay only when permission is enabled and the invoice is unpaid", () => {
  assert.equal(canParentPayInvoice(true, "unpaid", "development"), true);
  assert.equal(canParentPayInvoice(false, "unpaid", "development"), false);
  assert.equal(canParentPayInvoice(true, "paid", "development"), false);
  assert.equal(canParentPayInvoice(true, "void", "development"), false);
  assert.equal(canParentPayInvoice(true, "unpaid", "production"), false);
});
