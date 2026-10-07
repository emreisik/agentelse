import type { GaHealthRun, GaPropertyLink } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı (GA-F8 uyarı yalıtımı): GA_AGENCY kapalıyken iki
// resolveMissing çağrısı bugünkü argümanlarla atılır ve hiç findMany yoktur;
// açıkken ve projenin başka motor bağları varsa çağrı yalnız onların
// `ga4:<bağ>:` öneklerini excludeDedupePrefixes olarak taşır (iki çağrı
// noktasında da), başka bağ yoksa alan hiç eklenmez.

const db = vi.hoisted(() => ({
  gaPropertyLink: { findMany: vi.fn(), updateMany: vi.fn() },
  gaHealthCheck: { findUnique: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
  gaHealthRun: { updateMany: vi.fn() },
  integrationCredential: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));
const alerts = vi.hoisted(() => ({
  raise: vi.fn(),
  resolveMissing: vi.fn(),
}));
const store = vi.hoisted(() => ({ readDailyTotals: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/server/monitoring/site-alerts", () => ({ SiteAlerts: alerts }));
vi.mock("@/server/website-analytics/store", () => ({
  readDailyTotals: store.readDailyTotals,
}));

const { syncAlerts, evaluateGaRealtime } = await import("./checks");
const { GA_ALERT_KINDS } = await import(
  "@/lib/website-analytics/health/registry"
);

const NOW = new Date("2026-10-12T05:30:00.000Z");
const LINK = {
  id: "link-a",
  workspaceId: "ws-1",
  projectId: "proj-1",
  credentialId: "cred-1",
  propertyId: "111",
  isPrimary: true,
  isSecondary: false,
  timeZone: "UTC",
  health: "OK",
  rateLimitedUntil: null,
  lastDailyDate: "2026-10-11",
  catalog: null,
} as unknown as GaPropertyLink;
const RUN = {
  id: "run-1",
  linkId: "link-a",
  leaseOwner: "owner",
  realtime: null,
  suspectDays: null,
} as unknown as GaHealthRun;

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("NODE_ENV", "test");
  for (const model of Object.values(db)) {
    if (typeof model === "function") model.mockReset();
    else for (const fn of Object.values(model)) fn.mockReset();
  }
  alerts.raise.mockReset();
  alerts.resolveMissing.mockReset();
  store.readDailyTotals.mockReset();
  db.gaPropertyLink.findMany.mockResolvedValue([]);
  db.gaHealthCheck.findUnique.mockResolvedValue(null);
  db.gaHealthCheck.findMany.mockResolvedValue([]);
  db.gaHealthCheck.upsert.mockResolvedValue({});
  db.gaHealthRun.updateMany.mockResolvedValue({ count: 1 });
  db.integrationCredential.findUnique.mockResolvedValue(null);
  db.$transaction.mockImplementation(
    async (callback: (tx: typeof db) => Promise<unknown>) => callback(db),
  );
  alerts.resolveMissing.mockResolvedValue(0);
  store.readDailyTotals.mockResolvedValue([]);
});

type ResolveInput = {
  projectId: string;
  source: string;
  kinds: string[];
  stillOpen: Set<string>;
  excludeDedupePrefixes?: string[];
};

function resolveInputs(): ResolveInput[] {
  return alerts.resolveMissing.mock.calls.map((call) => call[0] as ResolveInput);
}

describe("syncAlerts (project-wide resolve)", () => {
  it("keeps today's exact call and runs no query with GA_AGENCY off", async () => {
    await syncAlerts(LINK, [], new Map(), NOW);
    expect(db.gaPropertyLink.findMany).not.toHaveBeenCalled();
    const [input] = resolveInputs();
    expect(input).toEqual({
      projectId: "proj-1",
      source: "GA4",
      kinds: [...GA_ALERT_KINDS],
      stillOpen: new Set<string>(),
    });
    expect(input).not.toHaveProperty("excludeDedupePrefixes");
  });

  it("excludes exactly the other engine links' prefixes with GA_AGENCY on", async () => {
    vi.stubEnv("GA_AGENCY", "true");
    db.gaPropertyLink.findMany.mockResolvedValue([{ id: "link-b" }, { id: "link-c" }]);
    await syncAlerts(LINK, [], new Map(), NOW);
    expect(db.gaPropertyLink.findMany).toHaveBeenCalledTimes(1);
    expect(db.gaPropertyLink.findMany).toHaveBeenCalledWith({
      where: {
        projectId: "proj-1",
        id: { not: "link-a" },
        OR: [{ isPrimary: true }, { isSecondary: true }],
      },
      select: { id: true },
    });
    expect(resolveInputs()[0]?.excludeDedupePrefixes).toEqual([
      "ga4:link-b:",
      "ga4:link-c:",
    ]);
  });

  it("adds no exclusion when the project has no other engine link", async () => {
    vi.stubEnv("GA_AGENCY", "true");
    await syncAlerts(LINK, [], new Map(), NOW);
    expect(resolveInputs()[0]).not.toHaveProperty("excludeDedupePrefixes");
  });
});

describe("evaluateGaRealtime (single-key resolve)", () => {
  it("keeps today's call shape with GA_AGENCY off", async () => {
    await evaluateGaRealtime(LINK, RUN, NOW);
    expect(db.gaPropertyLink.findMany).not.toHaveBeenCalled();
    const [input] = resolveInputs();
    expect(input?.projectId).toBe("proj-1");
    expect(input?.source).toBe("GA4");
    expect(input?.kinds).toHaveLength(1);
    expect(input).not.toHaveProperty("excludeDedupePrefixes");
  });

  it("excludes the other engine links' prefixes with GA_AGENCY on", async () => {
    vi.stubEnv("GA_AGENCY", "true");
    db.gaPropertyLink.findMany.mockResolvedValue([{ id: "link-b" }]);
    await evaluateGaRealtime(LINK, RUN, NOW);
    expect(resolveInputs()[0]?.excludeDedupePrefixes).toEqual(["ga4:link-b:"]);
  });
});
