import { describe, expect, it } from "vitest";

import { configureTestDatabase } from "../../vitest.database";

const DEV_URL = "postgresql://user:secret@db.example.com/agentelse";
const TEST_URL = "postgresql://user:secret@db.example.com/agentelse_test";
type MutableEnvironment = Record<string, string | undefined>;

describe("Vitest database safety", () => {
  it("disables database access instead of falling back to the app database", () => {
    const environment: MutableEnvironment = { DATABASE_URL: DEV_URL };

    expect(configureTestDatabase(environment)).toEqual({
      enabled: false,
      reason: "TEST_DATABASE_URL is not configured",
    });
    expect(environment.DATABASE_URL).toContain("127.0.0.1:1");
    expect(environment.DATABASE_URL).not.toBe(DEV_URL);
    expect(environment.AGENTELSE_INTEGRATION_TESTS_ENABLED).toBe("0");
  });

  it("maps a dedicated test database to Prisma runtime URLs", () => {
    const environment: MutableEnvironment = {
      DATABASE_URL: DEV_URL,
      TEST_DATABASE_URL: TEST_URL,
    };

    expect(configureTestDatabase(environment)).toEqual({ enabled: true });
    expect(environment.DATABASE_URL).toBe(TEST_URL);
    expect(environment.DIRECT_URL).toBe(TEST_URL);
    expect(environment.AGENTELSE_INTEGRATION_TESTS_ENABLED).toBe("1");
  });

  it("rejects the application database even with different URL parameters", () => {
    const environment: MutableEnvironment = {
      DATABASE_URL: `${TEST_URL}?pgbouncer=true`,
      TEST_DATABASE_URL: `${TEST_URL}?connection_limit=1`,
    };

    expect(() => configureTestDatabase(environment)).toThrow(
      "resolves to the application database",
    );
  });

  it("rejects an unmarked target unless isolation is explicitly asserted", () => {
    const unmarkedUrl = "postgresql://user:secret@isolated.example.com/app";

    expect(() =>
      configureTestDatabase({ TEST_DATABASE_URL: unmarkedUrl }),
    ).toThrow('must contain "test"');

    const environment: MutableEnvironment = {
      TEST_DATABASE_URL: unmarkedUrl,
      AGENTELSE_ALLOW_UNMARKED_TEST_DATABASE: "1",
    };
    expect(configureTestDatabase(environment)).toEqual({ enabled: true });
  });

  it("can require integration configuration in CI", () => {
    expect(() =>
      configureTestDatabase({ AGENTELSE_REQUIRE_TEST_DATABASE: "1" }),
    ).toThrow("TEST_DATABASE_URL is required");
  });
});
