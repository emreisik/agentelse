import { existsSync } from "node:fs";
import path from "node:path";

import { defineConfig } from "vitest/config";

import { configureTestDatabase } from "./vitest.database";

// Node 20.6+ built-in — no dotenv dependency needed (same approach as
// prisma.config.ts, since Prisma's config-file mode stopped auto-loading it).
for (const envFile of [".env", ".env.test"]) {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

configureTestDatabase(process.env);

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    globalSetup: ["./vitest.global-setup.ts"],
    // Integration suites pump shared outbox/worker tables. Serial files keep
    // one suite from consuming another suite's fixture events.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
