import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const configuredBaseUrl = process.env.CAMPUS_LIVE_BASE_URL;
const developmentDomain = process.env.REPLIT_DEV_DOMAIN;
const baseURL = configuredBaseUrl
  ?? (developmentDomain ? `https://${developmentDomain}` : "http://127.0.0.1:19557");
const systemChromium = "/repl/tools/bin/chromium";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ?? (existsSync(systemChromium) ? systemChromium : undefined);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      args: ["--no-sandbox"],
      ...(executablePath ? { executablePath } : {}),
    },
    trace: "retain-on-failure",
  },
});
