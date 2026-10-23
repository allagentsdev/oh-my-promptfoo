import { defineConfig } from "vitest/config";
import { testEntries } from "./tests/global-setup.ts";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    // Provider and workspace tests drive real subprocesses and filesystem locks.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      OH_MY_PROMPTFOO_TEST_ENTRIES: testEntries,
      // Child processes load TypeScript through tsx; keep its transform cache out of the
      // temporary directories that tests assert are left clean.
      TSX_DISABLE_CACHE: "1",
    },
  },
});
