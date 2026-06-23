import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only run tests that use vitest (not bun:test)
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "src/lib/actions.test.ts",
      "src/lib/chunk-buffer.test.ts",
      "src/lib/keyboard.test.ts",
    ],
  },
});
