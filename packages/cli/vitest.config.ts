import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // openTestWorkspace() opens an in-memory lix, registers schemas, and
    // seeds objects + attributes; each test typically takes 0.5-2s. On
    // GitHub's slower runners that exceeds the 5s vitest default — bump
    // to 30s so CI doesn't flake on disk-bound startup.
    testTimeout: 30_000,
  },
});
