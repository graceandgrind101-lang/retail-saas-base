import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // route files import "@/lib/...", the same alias tsconfig.json gives Next
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // the tests share one freshly migrated database
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // the project's own files only: never the Next build output or dependencies
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
