import { expect, test, type Page } from "@playwright/test";

const organization = process.env.DASHBOARD_E2E_ORG ?? "demo";
const seededPassword = process.env.DASHBOARD_E2E_PASSWORD ?? "Passw0rd!";
const desktop = { width: 1440, height: 1000 };
const mobile = { width: 390, height: 844 };

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByTestId("input-organization").fill(organization);
  await page.getByTestId("input-email").fill(email);
  await page.getByTestId("input-password").fill(seededPassword);
  await page.getByTestId("button-submit-login").click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: /Good to see you/ })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
  }));
  expect(dimensions.page, "dashboard should not scroll horizontally").toBeLessThanOrEqual(dimensions.viewport);
}

async function expectDashboardData(page: Page) {
  const metricCards = page.locator(".dashboard-metric");
  await expect(metricCards).toHaveCount(4);
  for (const card of await metricCards.all()) {
    await expect(card.locator(".dashboard-metric-top > span")).not.toBeEmpty();
    await expect(card.locator(".dashboard-metric-value")).not.toBeEmpty();
  }

  const sessions = page.locator(".dashboard-sessions");
  await expect(sessions.getByRole("heading", { name: "Coming up" })).toBeVisible();
  await expect(sessions.locator(".dashboard-session")).not.toHaveCount(0);

  const activity = page.locator(".dashboard-activity");
  await expect(activity.getByRole("heading", { name: "Recent activity" })).toBeVisible();
  if (await activity.locator(".dashboard-activity-item").count()) {
    await expect(activity.locator(".dashboard-activity-item").first()).toBeVisible();
  } else {
    await expect(activity.getByText("No recent updates to show.")).toBeVisible();
  }
}

async function expectAdminInsights(page: Page) {
  const insights = page.getByTestId("dashboard-admin-insights");
  await expect(insights).toBeVisible();
  await expect(insights.getByRole("heading", { name: "Today’s register" })).toBeVisible();
  await expect(insights.getByRole("heading", { name: "Collection overview" })).toBeVisible();
  await expect(insights.getByText("Collected", { exact: true })).toBeVisible();
  await expect(insights.getByText("Outstanding", { exact: true })).toBeVisible();
  await expect(insights.getByText("Overdue invoices", { exact: true })).toBeVisible();
  await expect(insights.getByRole("img", { name: "Monthly fee collections" })).toBeVisible();
  await expect(insights.getByRole("link", { name: /Review fees/ })).toHaveAttribute("href", "/fees");
}

test("administrator dashboard data, navigation, and theme controls fit desktop and mobile", async ({ page }) => {
  await signIn(page, process.env.DASHBOARD_E2E_ADMIN_EMAIL ?? "admin@demo.edu");

  await page.setViewportSize(desktop);
  await expectDashboardData(page);
  await expectAdminInsights(page);
  await expectNoHorizontalOverflow(page);
  await expect(page.getByTestId("link-nav-admissions")).toBeVisible();
  const feesLink = page.getByTestId("link-nav-fees");
  await feesLink.scrollIntoViewIfNeeded();
  await expect(feesLink).toBeInViewport();
  await expect(page.getByTestId("link-nav-privacy-&-consent")).toHaveCount(0);

  const desktopMetricsColumns = await page.locator(".dashboard-metrics").evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(" ").length,
  );
  expect(desktopMetricsColumns).toBe(4);

  const themeButton = page.getByTestId("button-theme");
  await expect(themeButton).toBeVisible();
  await themeButton.click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await themeButton.click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);

  await page.getByRole("link", { name: /Explore live classes/ }).click();
  await expect(page).toHaveURL(/\/live\/sessions$/);
  await page.getByTestId("link-nav-overview").click();
  await page.getByRole("link", { name: /Browse smartboards/ }).click();
  await expect(page).toHaveURL(/\/boards\/templates$/);

  await page.getByTestId("link-nav-overview").click();
  await page.setViewportSize(mobile);
  await expectDashboardData(page);
  await expectAdminInsights(page);
  await expectNoHorizontalOverflow(page);
  const mobileMetricsColumns = await page.locator(".dashboard-metrics").evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(" ").length,
  );
  expect(mobileMetricsColumns).toBe(2);

  await page.getByTestId("button-open-navigation").click();
  await expect(page.getByTestId("link-nav-admissions")).toBeVisible();
  await feesLink.scrollIntoViewIfNeeded();
  await expect(feesLink).toBeInViewport();
  await expect(page.getByTestId("button-theme")).toBeVisible();

  await page.getByTestId("link-nav-overview").click();
  await page.getByRole("link", { name: /Explore live classes/ }).click();
  await expect(page).toHaveURL(/\/live\/sessions$/);
  await page.getByTestId("button-open-navigation").click();
  await page.getByTestId("link-nav-overview").click();
  await page.getByRole("link", { name: /Browse smartboards/ }).click();
  await expect(page).toHaveURL(/\/boards\/templates$/);
});

test("teacher navigation stays role-aware and theme control remains reachable on mobile", async ({ page }) => {
  await signIn(page, process.env.DASHBOARD_E2E_TEACHER_EMAIL ?? "teacher@demo.edu");
  await page.setViewportSize(desktop);
  await expectDashboardData(page);
  await expect(page.getByTestId("dashboard-admin-insights")).toHaveCount(0);
  await expect(page.getByTestId("link-nav-students")).toBeVisible();
  await expect(page.getByTestId("link-nav-admissions")).toHaveCount(0);
  await expect(page.getByTestId("link-nav-fees")).toHaveCount(0);
  await expect(page.getByTestId("link-nav-privacy-&-consent")).toHaveCount(0);

  await page.setViewportSize(mobile);
  await expectNoHorizontalOverflow(page);
  await page.getByTestId("button-open-navigation").click();
  await expect(page.getByTestId("button-theme")).toBeVisible();
  await expect(page.getByTestId("link-nav-live-classes")).toBeVisible();
  await expect(page.getByTestId("link-nav-admissions")).toHaveCount(0);
});

test("student accounts cannot open the student directory", async ({ page }) => {
  await signIn(page, "student1@demo.edu");
  await expect(page.getByTestId("link-nav-students")).toHaveCount(0);

  // Keep the in-memory auth token while exercising a client-side deep link.
  await page.evaluate(() => {
    window.history.pushState({}, "", "/admin/students");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(/\/admin\/students$/);
  await expect(page.getByRole("heading", { name: "404 Page Not Found" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Student roster" })).toHaveCount(0);
  await expect(page.locator("[data-testid^='student-row-']")).toHaveCount(0);
});
