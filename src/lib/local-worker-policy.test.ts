import { describe, expect, it } from "vitest";

import {
  isLocalDatabaseUrl,
  metaWorkExcludedHere,
  shouldStartLocalWorker,
  shouldStartProductionWorker,
} from "./local-worker-policy";

describe("local worker startup policy", () => {
  it("starts only in the Node.js development runtime with explicit opt-in", () => {
    expect(
      shouldStartLocalWorker({
        NEXT_RUNTIME: "nodejs",
        NODE_ENV: "development",
        ENABLE_LOCAL_WORKER: "true",
      }),
    ).toBe(true);
  });

  it.each([
    {
      NEXT_RUNTIME: "edge",
      NODE_ENV: "development",
      ENABLE_LOCAL_WORKER: "true",
    },
    {
      NEXT_RUNTIME: "nodejs",
      NODE_ENV: "production",
      ENABLE_LOCAL_WORKER: "true",
    },
    // The default (no ENABLE_LOCAL_WORKER at all) must NOT start it — this is
    // the whole point of the opt-in flip, and the exact case that let a
    // stale local dev process silently process real production jobs.
    { NEXT_RUNTIME: "nodejs", NODE_ENV: "development" },
    {
      NEXT_RUNTIME: "nodejs",
      NODE_ENV: "development",
      ENABLE_LOCAL_WORKER: "false",
    },
  ])("does not start for %o", (env) => {
    expect(shouldStartLocalWorker(env)).toBe(false);
  });
});

describe("production in-process worker policy", () => {
  it("starts only in the Node.js production runtime with explicit opt-in", () => {
    expect(
      shouldStartProductionWorker({
        NEXT_RUNTIME: "nodejs",
        NODE_ENV: "production",
        ENABLE_INPROCESS_WORKER: "true",
      }),
    ).toBe(true);
  });

  it.each([
    { NEXT_RUNTIME: "nodejs", NODE_ENV: "production" },
    {
      NEXT_RUNTIME: "edge",
      NODE_ENV: "production",
      ENABLE_INPROCESS_WORKER: "true",
    },
    // The dev flag must never start a worker in production, and vice versa.
    {
      NEXT_RUNTIME: "nodejs",
      NODE_ENV: "production",
      ENABLE_LOCAL_WORKER: "true",
    },
    {
      NEXT_RUNTIME: "nodejs",
      NODE_ENV: "development",
      ENABLE_INPROCESS_WORKER: "true",
    },
  ])("does not start for %o", (env) => {
    expect(shouldStartProductionWorker(env)).toBe(false);
  });
});

describe("Meta work in local development (F0b, K19)", () => {
  it("treats localhost and a Unix socket as a disposable local database", () => {
    expect(
      isLocalDatabaseUrl("postgresql://postgres@localhost:5432/agentelse_test"),
    ).toBe(true);
    expect(
      isLocalDatabaseUrl(
        "postgresql://postgres@localhost/agentelse_test?host=/private/tmp/pg/sock",
      ),
    ).toBe(true);
    expect(
      isLocalDatabaseUrl(
        "postgresql://u:p@ep-cool-name-pooler.eu-central-1.aws.neon.tech/neondb",
      ),
    ).toBe(false);
    expect(isLocalDatabaseUrl(undefined)).toBe(false);
  });

  it("keeps Meta work off a dev process that shares the live database", () => {
    expect(
      metaWorkExcludedHere({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://u:p@ep-x.neon.tech/neondb",
      }),
    ).toBe(true);
    expect(
      metaWorkExcludedHere({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://postgres@127.0.0.1/agentelse_test",
      }),
    ).toBe(false);
    expect(
      metaWorkExcludedHere({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://u:p@ep-x.neon.tech/neondb",
      }),
    ).toBe(false);
  });
});
