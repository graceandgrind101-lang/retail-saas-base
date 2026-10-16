import { defineConfig, devices } from "@playwright/test";

// Real-browser checks (`pnpm --filter @retail/web e2e`). The app is built and started the way it runs
// in production; the component gallery is switched on for it with ENABLE_UI_GALLERY.
const PORT = 3113;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [
    { name: "phone", use: { ...devices["Pixel 7"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: `next start -p ${PORT}`,
    url: `http://localhost:${PORT}/ui`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      ENABLE_UI_GALLERY: "1",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-0123456789-abcdefghij",
      NEXT_PUBLIC_APP_URL: `http://localhost:${PORT}`,
      DATABASE_URL: "postgres://retail_app:x@127.0.0.1:54322/postgres",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789-ABCDEFGHIJ",
      SESSION_SECRET: "k3Jf9aQ2xLm7ZpR1tVb8nWc4yHd6sGu0",
      PIN_PEPPER: "Qw8eRt5yUi2oPa7sDf4gHj1kLz9xCv3b",
      DEVICE_TOKEN_PEPPER: "Zx6cVb3nMq8wEr1tYu4iOp7aSd2fGh5j",
      REFERENCE_PEPPER: "Lk9jHg6fDs3aPo0iUy7tRe4wQz1xCv8n",
      SUPABASE_JWT_SECRET: "test-jwt-secret-0123456789-abcdefghijklmnop",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
