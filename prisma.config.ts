import { defineConfig } from "prisma/config";

// Prisma config files opt out of Prisma's automatic .env loading, so we load
// it ourselves (Node 20.6+ built-in — no dotenv dependency needed).
process.loadEnvFile(".env");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
});
