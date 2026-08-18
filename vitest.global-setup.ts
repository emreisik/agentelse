// Keep the default unit-test command useful without a local PostgreSQL server,
// while making the skipped integration coverage explicit in its output. CI
// sets HUBCONNECT_REQUIRE_TEST_DATABASE=1, so it cannot silently take this path.
export default function globalSetup(): void {
  if (process.env.HUBCONNECT_INTEGRATION_TESTS_ENABLED !== "1") {
    console.warn(
      "TEST_DATABASE_URL is not configured; database integration tests are skipped.",
    );
  }
}
