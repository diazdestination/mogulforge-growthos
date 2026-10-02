import path from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Standalone vitest config keeps unit tests independent of dev-server settings.
// env vars that are irrelevant for unit tests.
export default defineConfig({
  plugins: [react()],
  // Vitest 4 runs on Vite 8, whose import-analysis step expects TSX to be
  // lowered by Oxc. The app's tsconfig intentionally preserves JSX for the
  // production Vite 7 pipeline, so make the test transform explicit here.
  oxc: {
    jsx: {
      runtime: 'automatic',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // The default 5s per-test timeout flakes when the suite runs alongside
    // other validation commands under CPU contention.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
