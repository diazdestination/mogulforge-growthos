import { defineConfig } from "vitest/config";

/** Pure unit tests that intentionally do not import or require PostgreSQL. */
export default defineConfig({
  test: {
    include: ["src/lib/**/*.test.ts"],
    env: {
      SESSION_SECRET: "test-only-mogulforge-session-secret-never-use-in-production",
    },
  },
});

