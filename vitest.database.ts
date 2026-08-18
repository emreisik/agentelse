const DISABLED_DATABASE_URL =
  "postgresql://hubconnect_test_disabled:disabled@127.0.0.1:1/hubconnect_test_disabled";

const TEST_MARKER = /(^|[^a-z0-9])test(?:s|ing)?([^a-z0-9]|$)/i;

type TestDatabaseState =
  | { enabled: true }
  | { enabled: false; reason: "TEST_DATABASE_URL is not configured" };

type TestEnvironment = Record<string, string | undefined>;

function parsePostgresUrl(value: string, variableName: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL URL.`);
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${variableName} must use postgres:// or postgresql://.`);
  }
  if (!parsed.hostname || !parsed.pathname.replaceAll("/", "")) {
    throw new Error(`${variableName} must include a host and database name.`);
  }

  return parsed;
}

function normalizedTarget(url: URL): string {
  // Neon uses `<endpoint>-pooler...` for pooled connections and
  // `<endpoint>...` for direct connections. Treat those as one target when
  // checking that a test URL does not resolve to the application's database.
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^([^.]+)-pooler(?=\.)/, "$1");
  const port = url.port || "5432";
  const database = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, ""));
  const schema = url.searchParams.get("schema")?.toLowerCase() || "public";
  return `${hostname}:${port}/${database.toLowerCase()}?schema=${schema}`;
}

function hasTestMarker(url: URL): boolean {
  const database = decodeURIComponent(url.pathname);
  const schema = url.searchParams.get("schema") ?? "";
  return TEST_MARKER.test(`${url.hostname}/${database}/${schema}`);
}

/**
 * Makes Prisma safe for Vitest before any application module is imported.
 *
 * With no TEST_DATABASE_URL, DATABASE_URL is replaced by an unreachable local
 * sentinel so an accidentally unguarded test can never fall through to the
 * development database loaded from .env. A configured test target must be
 * visibly test-only and different from both application connection URLs.
 */
export function configureTestDatabase(
  environment: TestEnvironment,
): TestDatabaseState {
  const applicationUrls = [environment.DATABASE_URL, environment.DIRECT_URL]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const testDatabaseUrl = environment.TEST_DATABASE_URL?.trim();
  const testDirectUrl = environment.TEST_DIRECT_URL?.trim();

  environment.HUBCONNECT_INTEGRATION_TESTS_ENABLED = "0";
  environment.DATABASE_URL = DISABLED_DATABASE_URL;
  delete environment.DIRECT_URL;

  if (!testDatabaseUrl) {
    if (environment.HUBCONNECT_REQUIRE_TEST_DATABASE === "1") {
      throw new Error(
        "TEST_DATABASE_URL is required when HUBCONNECT_REQUIRE_TEST_DATABASE=1.",
      );
    }
    return { enabled: false, reason: "TEST_DATABASE_URL is not configured" };
  }

  const testTargets = [
    {
      name: "TEST_DATABASE_URL",
      parsed: parsePostgresUrl(testDatabaseUrl, "TEST_DATABASE_URL"),
    },
    ...(testDirectUrl
      ? [
          {
            name: "TEST_DIRECT_URL",
            parsed: parsePostgresUrl(testDirectUrl, "TEST_DIRECT_URL"),
          },
        ]
      : []),
  ];
  const applicationTargets = applicationUrls.map((value) =>
    normalizedTarget(parsePostgresUrl(value, "DATABASE_URL/DIRECT_URL")),
  );

  for (const target of testTargets) {
    if (applicationTargets.includes(normalizedTarget(target.parsed))) {
      throw new Error(
        `${target.name} resolves to the application database. Use a separate test database.`,
      );
    }
    if (
      environment.HUBCONNECT_ALLOW_UNMARKED_TEST_DATABASE !== "1" &&
      !hasTestMarker(target.parsed)
    ) {
      throw new Error(
        `${target.name} must contain "test" in its host, database name, or schema. ` +
          "Set HUBCONNECT_ALLOW_UNMARKED_TEST_DATABASE=1 only for an intentionally isolated target.",
      );
    }
  }

  environment.DATABASE_URL = testDatabaseUrl;
  environment.DIRECT_URL = testDirectUrl || testDatabaseUrl;
  environment.HUBCONNECT_INTEGRATION_TESTS_ENABLED = "1";

  return { enabled: true };
}
