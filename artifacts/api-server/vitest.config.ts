import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./vitest.globalSetup.ts",
    env: {
      SESSION_SECRET:
        process.env.SESSION_SECRET ||
        "test-only-mogulforge-session-secret-never-use-in-production",
      APP_ORIGIN: process.env.APP_ORIGIN || "http://localhost:3001",
      OBJECT_STORAGE_PROVIDER:
        process.env.OBJECT_STORAGE_PROVIDER || "postgres",
    },
    // Confirmation/reminder tests send real email when the Gmail connector
    // is configured in the workspace; those network sends can exceed the 5s
    // default and flake.
    testTimeout: 20_000,
  },
});
