import { beforeEach, describe, expect, it, vi } from "vitest";

import fixture from "@/lib/website-analytics/funnel/__fixtures__/funnel-response.json";
import { GoogleApiError } from "@/server/integrations/google/errors";

// Bu dosyanın kanıtladığı (GA-F8 huni çalıştırma kapıları): bayrak -> huni+bağ
// -> sağlık eşlemesi -> 10 dk hız sınırı -> kota yöneticisi -> günlük sınır
// (ÖNCE ARTIR, SONRA DENETLE; aşılırsa telafi) -> token -> Google. Sayaç Google
// çağrısından ÖNCE artar; yeni UTC günde sıfırlanır; başarı sonucu saklar,
// RATE_LIMIT mülkün bütün bağlarını bloklar, Google iletisi hiçbir yere
// yazılmaz. 20 gerçek çalıştırma geçer, 21.si daily_limit olur.

type Funnel = {
  id: string;
  projectId: string;
  linkId: string;
  isOpen: boolean;
  periodDays: number;
  steps: unknown;
  lastResult: unknown;
  lastRunAt: Date | null;
  runDay: string | null;
  runsToday: number;
  lastError: string | null;
};
type Link = Record<string, unknown> & {
  id: string;
  propertyId: string;
  projectId: string;
};

const state = vi.hoisted(() => ({
  funnels: [] as Funnel[],
  links: [] as Link[],
  credential: { id: "cred-1", status: "ACTIVE", encryptedSecret: "x" } as {
    id: string;
    status: string;
    encryptedSecret: string;
  } | null,
  writes: [] as unknown[],
  runReport: vi.fn(),
  getToken: vi.fn(),
  flush: vi.fn(),
}));

type Where = Record<string, unknown>;

function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR") {
      return (expected as Where[]).some((clause) => matches(row, clause));
    }
    const actual = row[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      const op = expected as { not?: unknown; gt?: number };
      if ("not" in op) return actual !== null && actual !== op.not;
      if ("gt" in op) return Number(actual) > (op.gt ?? 0);
    }
    return actual === expected;
  });
}

function apply(row: Record<string, unknown>, data: Record<string, unknown>) {
  state.writes.push(data);
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const op = value as { increment?: number; decrement?: number };
      if (op.increment !== undefined) {
        row[key] = Number(row[key] ?? 0) + op.increment;
        continue;
      }
      if (op.decrement !== undefined) {
        row[key] = Number(row[key] ?? 0) - op.decrement;
        continue;
      }
    }
    row[key] = value;
  }
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gaFunnel: {
      findFirst: async ({ where }: { where: Where }) =>
        state.funnels.find((row) => matches(row, where)) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = state.funnels.find((item) => item.id === where.id);
        if (row) apply(row, data);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Where;
        data: Record<string, unknown>;
      }) => {
        const rows = state.funnels.filter((row) => matches(row, where));
        for (const row of rows) apply(row, data);
        return { count: rows.length };
      },
      aggregate: async ({ where }: { where: Where }) => ({
        _sum: {
          runsToday: state.funnels
            .filter((row) => matches(row, where))
            .reduce((sum, row) => sum + row.runsToday, 0),
        },
      }),
    },
    gaPropertyLink: {
      findFirst: async ({ where }: { where: Where }) =>
        state.links.find((row) => matches(row, where)) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: Where;
        data: Record<string, unknown>;
      }) => {
        const rows = state.links.filter((row) => matches(row, where));
        for (const row of rows) apply(row, data);
        return { count: rows.length };
      },
    },
    integrationCredential: {
      findUnique: async () => state.credential,
    },
  },
}));

vi.mock("@/server/integrations/google-analytics/funnel-api", () => {
  class FunnelUnavailableError extends Error {}
  return { FunnelUnavailableError, runGaFunnelReport: state.runReport };
});
vi.mock("@/server/integrations/google-token", () => ({
  getFreshGoogleAccessToken: state.getToken,
}));
vi.mock("@/server/website-analytics/api-counters", () => ({
  flushGaApiCounters: state.flush,
  recordGaApiOutcome: vi.fn(),
}));
// parseQuota paylaşılan düzenlemeyle (S-QUOTA) dışa aktarılır; yoksa yedeği.
vi.mock("@/lib/website-analytics/response", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/website-analytics/response")>();
  const real = (actual as { parseQuota?: unknown }).parseQuota;
  return {
    ...actual,
    parseQuota:
      real ??
      ((raw: Record<string, { consumed?: number; remaining?: number }>) =>
        raw?.tokensPerDay
          ? {
              tokensPerDay: {
                consumed: raw.tokensPerDay.consumed ?? 0,
                remaining: raw.tokensPerDay.remaining ?? 0,
              },
            }
          : null),
  };
});

const { runFunnel } = await import("./run");
const { FunnelUnavailableError } = await import(
  "@/server/integrations/google-analytics/funnel-api"
);

const NOW = new Date("2026-10-06T12:00:00.000Z");
const TODAY = "2026-10-06";
const STEPS = [
  { name: "Visit", kind: "event", value: "page_view" },
  { name: "Started a form", kind: "event", value: "form_start" },
  { name: "Lead", kind: "event", value: "generate_lead" },
];

function funnel(id: string, overrides: Partial<Funnel> = {}): Funnel {
  return {
    id,
    projectId: "p1",
    linkId: "link-1",
    isOpen: false,
    periodDays: 28,
    steps: STEPS,
    lastResult: null,
    lastRunAt: null,
    runDay: null,
    runsToday: 0,
    lastError: null,
    ...overrides,
  };
}

function link(overrides: Partial<Link> = {}): Link {
  return {
    id: "link-1",
    projectId: "p1",
    propertyId: "123",
    credentialId: "cred-1",
    health: "OK",
    timeZone: "UTC",
    isPrimary: true,
    isSecondary: false,
    lastQuota: null,
    rateLimitedUntil: null,
    ...overrides,
  };
}

const run = (funnelId = "f1", now = NOW) =>
  runFunnel({ projectId: "p1", funnelId, now });

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_AGENCY", "true");
  vi.stubEnv("GA_FUNNEL", "true");
  vi.stubEnv("GA_FUNNEL_ALPHA", "true");
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "live");
  vi.stubEnv("NODE_ENV", "test");
  state.funnels = [funnel("f1")];
  state.links = [link()];
  state.credential = { id: "cred-1", status: "ACTIVE", encryptedSecret: "x" };
  state.writes = [];
  state.runReport.mockReset();
  state.runReport.mockResolvedValue(fixture);
  state.getToken.mockReset();
  state.getToken.mockResolvedValue("real-token");
  state.flush.mockReset();
  state.flush.mockResolvedValue(undefined);
});

describe("gates before any counter changes", () => {
  it("returns off when the flag is off, touching nothing", async () => {
    vi.stubEnv("GA_FUNNEL", "");
    expect(await run()).toBe("off");
    expect(state.writes).toEqual([]);
    expect(state.runReport).not.toHaveBeenCalled();
  });

  it("returns not_found for a missing funnel, a missing link and a retired link", async () => {
    expect(await run("nope")).toBe("not_found");
    state.links = [];
    expect(await run()).toBe("not_found");
    state.links = [link({ isPrimary: false, isSecondary: false })];
    expect(await run()).toBe("not_found");
    expect(state.runReport).not.toHaveBeenCalled();
  });

  it("maps link health: AUTH to auth, other bad values to failed, OK and UNKNOWN run", async () => {
    state.links = [link({ health: "AUTH" })];
    expect(await run()).toBe("auth");
    for (const health of ["DEGRADED", "GONE", "NEEDS_PERMISSION"]) {
      state.links = [link({ health })];
      expect(await run()).toBe("failed");
    }
    expect(state.runReport).not.toHaveBeenCalled();
    for (const [index, health] of ["OK", "UNKNOWN"].entries()) {
      state.links = [link({ health })];
      state.funnels = [funnel("f1")];
      expect(await run("f1", new Date(NOW.getTime() + index * 1000))).toBe("ok");
    }
  });

  it("throttles a funnel that ran less than 10 minutes ago", async () => {
    state.funnels = [
      funnel("f1", {
        lastRunAt: new Date(NOW.getTime() - 5 * 60_000),
        runDay: TODAY,
        runsToday: 3,
      }),
    ];
    expect(await run()).toBe("throttled");
    expect(state.funnels[0]?.runsToday).toBe(3);
    expect(state.runReport).not.toHaveBeenCalled();
  });

  it("defers to the quota governor and the property block", async () => {
    state.links = [
      link({ rateLimitedUntil: new Date(NOW.getTime() + 60_000) }),
    ];
    expect(await run()).toBe("quota");
    state.links = [
      link({
        lastQuota: {
          at: NOW.toISOString(),
          quota: { tokensPerDay: { consumed: 199_000, remaining: 1_000 } },
        },
      }),
    ];
    expect(await run()).toBe("quota");
    expect(state.funnels[0]?.runsToday).toBe(0);
    expect(state.runReport).not.toHaveBeenCalled();
  });
});

describe("daily limit: increment, then check", () => {
  it("increments the counter before the Google call", async () => {
    let seen: { runsToday: number; runDay: string | null } | null = null;
    state.runReport.mockImplementation(async () => {
      const row = state.funnels[0];
      seen = { runsToday: row?.runsToday ?? -1, runDay: row?.runDay ?? null };
      return fixture;
    });
    expect(await run()).toBe("ok");
    expect(seen).toEqual({ runsToday: 1, runDay: TODAY });
  });

  it("starts a new count on a new UTC day", async () => {
    state.funnels = [funnel("f1", { runDay: "2026-10-05", runsToday: 7 })];
    expect(await run()).toBe("ok");
    expect(state.funnels[0]).toMatchObject({ runDay: TODAY, runsToday: 1 });
  });

  it("evaluates the limit after the increment and compensates a rejected run", async () => {
    const previous = new Date(NOW.getTime() - 3 * 3_600_000);
    state.funnels = [
      funnel("f1", { runDay: TODAY, runsToday: 3, lastRunAt: previous }),
      funnel("f2", { runDay: TODAY, runsToday: 17 }),
    ];
    // 3 + 17 = 20: bu çalıştırma 21. olur.
    expect(await run()).toBe("daily_limit");
    expect(state.funnels[0]).toMatchObject({ runsToday: 3, lastRunAt: previous });
    expect(state.runReport).not.toHaveBeenCalled();
  });

  it("counts only today's counters", async () => {
    state.funnels = [
      funnel("f1"),
      funnel("f2", { runDay: "2026-10-05", runsToday: 20 }),
    ];
    expect(await run()).toBe("ok");
  });

  it("lets 20 real runs across 2 funnels pass and refuses the 21st", async () => {
    state.funnels = [funnel("f1"), funnel("f2")];
    let now = new Date("2026-10-06T00:30:00.000Z");
    for (let index = 0; index < 20; index += 1) {
      const id = index % 2 === 0 ? "f1" : "f2";
      expect(await run(id, now)).toBe("ok");
      now = new Date(now.getTime() + 11 * 60_000);
    }
    expect(state.funnels.map((row) => row.runsToday)).toEqual([10, 10]);
    expect(await run("f1", now)).toBe("daily_limit");
    expect(state.funnels.map((row) => row.runsToday)).toEqual([10, 10]);
    expect(state.runReport).toHaveBeenCalledTimes(20);
  });
});

describe("the Google call", () => {
  it("stores the result, clears the error and writes the quota to every link of the property", async () => {
    state.links = [link(), link({ id: "link-2", projectId: "p2" })];
    state.funnels = [funnel("f1", { lastError: "RATE_LIMIT" })];
    expect(await run()).toBe("ok");
    const row = state.funnels[0];
    expect(row?.lastError).toBeNull();
    expect(row?.lastResult).toMatchObject({
      through: "2026-10-05",
      steps: [{ name: "Visit", users: 1200 }, { users: 300 }, { users: 120 }],
    });
    for (const item of state.links) {
      expect(item.lastQuota).toMatchObject({ at: NOW.toISOString() });
    }
    expect(state.flush).toHaveBeenCalled();
  });

  it("asks for the last periodDays complete days in the property's time zone", async () => {
    state.links = [link({ timeZone: "Pacific/Auckland" })];
    state.funnels = [funnel("f1", { periodDays: 7 })];
    // Auckland'da 2026-10-07 01:00 (UTC 12:00 ve +13): dün 2026-10-06.
    await run();
    const body = state.runReport.mock.calls[0]?.[2] as {
      dateRanges: { startDate: string; endDate: string }[];
    };
    expect(body.dateRanges).toEqual([
      { startDate: "2026-09-30", endDate: "2026-10-06" },
    ]);
    expect(state.runReport.mock.calls[0]?.[0]).toBe("real-token");
    expect(state.runReport.mock.calls[0]?.[1]).toBe("123");
  });

  it("returns unavailable and gives the run back when the kill switch is off", async () => {
    const previous = new Date(NOW.getTime() - 3 * 3_600_000);
    state.funnels = [funnel("f1", { lastRunAt: previous, runDay: TODAY, runsToday: 2 })];
    state.runReport.mockRejectedValue(new FunnelUnavailableError());
    expect(await run()).toBe("unavailable");
    expect(state.funnels[0]).toMatchObject({ runsToday: 2, lastRunAt: previous });
  });

  it("returns auth without a Google call when the credential is not active", async () => {
    state.credential = { id: "cred-1", status: "EXPIRED", encryptedSecret: "x" };
    expect(await run()).toBe("auth");
    expect(state.funnels[0]?.runsToday).toBe(0);
    expect(state.runReport).not.toHaveBeenCalled();
  });

  it("maps a Google AUTH error to auth", async () => {
    state.runReport.mockRejectedValue(
      new GoogleApiError("expired", "invalid_grant"),
    );
    expect(await run()).toBe("auth");
    expect(state.funnels[0]?.lastError).toBe("AUTH");
  });

  it("blocks the whole property on RATE_LIMIT and stores no Google message", async () => {
    state.links = [link(), link({ id: "link-2", projectId: "p2" })];
    state.runReport.mockRejectedValue(
      new GoogleApiError("secret customer detail", "RESOURCE_EXHAUSTED", {
        httpStatus: 429,
        retryAfterMs: 120_000,
      }),
    );
    expect(await run()).toBe("quota");
    for (const item of state.links) {
      expect(item.rateLimitedUntil).toEqual(new Date(NOW.getTime() + 120_000));
    }
    expect(state.funnels[0]?.lastError).toBe("RATE_LIMIT");
    expect(JSON.stringify([state.funnels, state.links, state.writes])).not.toContain(
      "secret customer detail",
    );
  });

  it("blocks until the next quota day on QUOTA_DAILY", async () => {
    state.runReport.mockRejectedValue(
      new GoogleApiError("per day exhausted", "RESOURCE_EXHAUSTED", {
        httpStatus: 429,
      }),
    );
    expect(await run()).toBe("quota");
    const until = state.links[0]?.rateLimitedUntil as Date;
    expect(until.getTime()).toBeGreaterThan(NOW.getTime());
    expect(state.funnels[0]?.lastError).toBe("QUOTA_DAILY");
  });

  it("returns failed with only the error class for other errors", async () => {
    state.runReport.mockRejectedValue(new Error("boom with details"));
    expect(await run()).toBe("failed");
    expect(state.funnels[0]?.lastError).toBe("UNKNOWN");
    expect(state.funnels[0]?.runsToday).toBe(1);
  });

  it("returns failed on an unreadable response", async () => {
    state.runReport.mockResolvedValue({ nothing: true });
    expect(await run()).toBe("failed");
    expect(state.funnels[0]?.lastError).toBe("BAD_RESPONSE");
  });

  it("uses a placeholder token and no credential lookup in mock mode", async () => {
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
    state.credential = null;
    expect(await run()).toBe("ok");
    expect(state.getToken).not.toHaveBeenCalled();
    expect(state.runReport.mock.calls[0]?.[0]).toBe("mock-access-token");
  });
});
