import { expect, test } from "@playwright/test";

// Run against a web production build with both NEXT_PUBLIC_ENABLE_* flags false.
// Authentication/data are intentionally mocked; these are UI-switch checks.
test.skip(process.env.CORE_ONLY_UI_TESTS !== "1", "Requires an explicitly core-only web build.");

test("core-only release hides live actions and explains direct classroom links", async ({ page }) => {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const body = path === "/api/identity/me"
      ? { id: "fixture-admin", name: "School Administrator", email: "admin@fixture.invalid", roles: ["campus_admin"], mustChangePassword: false }
      : { userName: "School Administrator", metrics: [], upcomingSessions: [], recentActivity: [] };
    await route.fulfill({ json: body });
  });
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: /Good to see you/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Live classes", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Explore live classes" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Explore learning" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open timetable" })).toBeVisible();
  await page.goto("/live/sessions");
  await expect(page.getByRole("heading", { name: "Live classes are coming later" })).toBeVisible();
  await expect(page.getByTestId("button-schedule-session")).toHaveCount(0);
  await page.goto("/classroom/fixture");
  await expect(page.getByRole("heading", { name: "Live classes are coming later" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("link", { name: "Back to dashboard" })).toBeVisible();
});

test("core-only parent fee view suppresses payment even if invoice advertises eligibility", async ({ page }) => {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { required: false, reviewedAt: null };
    if (path === "/api/identity/me") body = {
      id: "fixture-parent", name: "Parent", email: "parent@fixture.invalid", roles: ["parent"], mustChangePassword: false,
    };
    if (path === "/api/fees/my-invoices") body = {
      total: 1,
      items: [{ id: "fixture-invoice", studentName: "Student", invoiceNumber: "INV-FIXTURE",
        academicYear: "2026-2027", period: "Term 1", description: "Tuition", amountPaise: 10000,
        dueDate: "2026-12-01", status: "unpaid", canPay: true, receiptNumber: null }],
    };
    await route.fulfill({ json: body });
  });
  await page.goto("/fees");
  await expect(page.getByRole("heading", { name: "Fees and receipts" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tuition" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pay now" })).toHaveCount(0);
  await expect(page.getByText("Online payments are unavailable. Contact the school.", { exact: true })).toBeVisible();
});
