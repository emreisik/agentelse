import { describe } from "vitest";

// Vitest replaces DATABASE_URL with a non-routable sentinel unless a
// validated TEST_DATABASE_URL is present. Skipping at the suite boundary also
// guarantees beforeAll/afterAll hooks cannot touch Prisma in that state.
export const describeIntegration = describe.skipIf(
  process.env.AGENTELSE_INTEGRATION_TESTS_ENABLED !== "1",
);
