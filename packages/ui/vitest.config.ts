import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    // components are tested in a simulated browser; pure token checks need nothing special
    environment: "jsdom",
    setupFiles: ["./src/setup-tests.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
