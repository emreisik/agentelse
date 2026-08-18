import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Prisma config files opt out of Prisma's automatic .env loading, so we load
// it ourselves (Node 20.6+ built-in — no dotenv dependency needed). Only
// local dev has a .env file; production platforms (Railway, etc.) inject env
// vars straight into process.env, so a missing file there is expected, not
// an error — loadEnvFile throws ENOENT if called unconditionally.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
});
