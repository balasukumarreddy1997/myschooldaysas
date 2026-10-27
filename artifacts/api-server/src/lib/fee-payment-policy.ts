export type FeeInvoicePaymentStatus = "unpaid" | "paid" | "void";

export function isMockPaymentEnvironment(nodeEnv: string | undefined): boolean {
  return nodeEnv === "development" || nodeEnv === "test";
}

export function canParentPayInvoice(
  canPayFees: boolean,
  status: FeeInvoicePaymentStatus,
  nodeEnv: string | undefined,
): boolean {
  return canPayFees && status === "unpaid" && isMockPaymentEnvironment(nodeEnv);
}
