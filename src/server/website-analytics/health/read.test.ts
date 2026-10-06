import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: bayrak kapalıyken sıradaki adım okuyucusu hiç
// sorgu yapmadan null döner; birincil bağın açık CRITICAL uyarısı MH5'in
// önüne geçer, başka bağın uyarısı yok sayılır; GA bağlı değilken alan adı
// olsa da olmasa da not_connected döner; Website paneli eksik kontrolleri
// UNKNOWN "not_checked" ile doldurur ve uyarı kimliğini dedupeKey'den eşler.

const mocks = vi.hoisted(() => ({
  projectFindUnique: vi.fn(),
  credentialFindUnique: vi.fn(),
  checkFindMany: vi.fn(),
  checkFindUnique: vi.fn(),
  runFindUnique: vi.fn(),
  primaryGaLink: vi.fn(),
  listOpen: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findUnique: mocks.projectFindUnique },
    integrationCredential: { findUnique: mocks.credentialFindUnique },
    gaHealthCheck: {
      findMany: mocks.checkFindMany,
      findUnique: mocks.checkFindUnique,
    },
    gaHealthRun: { findUnique: mocks.runFindUnique },
  },
}));
vi.mock("@/server/website-analytics/store", () => ({
  primaryGaLink: mocks.primaryGaLink,
}));
vi.mock("@/server/monitoring/site-alerts", () => ({
  SiteAlerts: { listOpen: mocks.listOpen },
}));
vi.mock("@/server/observability/heartbeat", () => ({
  Heartbeat: { read: vi.fn() },
}));

const { loadMeasurementHealth, loadWebsiteJourneyFacts } =
  await import("./read");

const LINK = {
  id: "link-1",
  projectId: "proj-1",
  propertyId: "424242",
  timeZone: "Europe/Istanbul",
  healthScore: 35,
};
const NOW = new Date("2026-10-06T14:00:00.000Z");

function alert(
  id: string,
  dedupeKey: string,
  severity: "INFO" | "WARN" | "CRITICAL",
  title: string,
) {
  return {
    id,
    source: "GA4",
    kind: `GA_${dedupeKey.split(":")[2]}`,
    severity,
    title,
    detail: null,
    lastSeenAt: NOW,
    dedupeKey,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_HEALTH", "true");
  vi.stubEnv("GA_WEBSITE_PAGE", "true");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.projectFindUnique.mockResolvedValue({ domain: "acme.com" });
  mocks.credentialFindUnique.mockResolvedValue({ status: "ACTIVE" });
  mocks.primaryGaLink.mockResolvedValue(LINK);
  mocks.listOpen.mockResolvedValue([]);
  mocks.checkFindUnique.mockResolvedValue(null);
  mocks.checkFindMany.mockResolvedValue([]);
  mocks.runFindUnique.mockResolvedValue(null);
});

describe("loadWebsiteJourneyFacts", () => {
  it("returns null without a query when GA_HEALTH is off", async () => {
    vi.stubEnv("GA_HEALTH", "");
    expect(await loadWebsiteJourneyFacts("proj-off")).toBeNull();
    expect(mocks.projectFindUnique).not.toHaveBeenCalled();
    expect(mocks.primaryGaLink).not.toHaveBeenCalled();
    expect(mocks.credentialFindUnique).not.toHaveBeenCalled();
  });

  it("prefers a critical alert of the primary link over MH5", async () => {
    mocks.listOpen.mockResolvedValue([
      alert(
        "a-1",
        "ga4:link-1:MH1",
        "CRITICAL",
        "Google Analytics stopped receiving data",
      ),
    ]);
    mocks.checkFindUnique.mockResolvedValue({
      status: "WARN",
      evidence: { reason: "no_key_events" },
    });
    const facts = await loadWebsiteJourneyFacts("proj-critical");
    expect(facts).toEqual({
      analytics: "connected",
      hasDomain: true,
      fix: {
        checkKey: "MH1",
        title: "Google Analytics stopped receiving data",
        href: "/projects/proj-critical/site#measurement-health",
        critical: true,
      },
    });
    expect(mocks.listOpen).toHaveBeenCalledWith("proj-critical", ["GA4"], 10);
    expect(mocks.checkFindUnique).not.toHaveBeenCalled();
  });

  it("ignores an alert of another link and falls back to MH5", async () => {
    mocks.listOpen.mockResolvedValue([
      alert(
        "a-2",
        "ga4:old-link:MH1",
        "CRITICAL",
        "Google Analytics stopped receiving data",
      ),
    ]);
    mocks.checkFindUnique.mockResolvedValue({
      status: "WARN",
      evidence: { reason: "only_purchase" },
    });
    const facts = await loadWebsiteJourneyFacts("proj-other-link");
    expect(facts?.fix).toEqual({
      checkKey: "MH5",
      title: "Fix tracking: only purchases are tracked as key events.",
      href: "/projects/proj-other-link/site#measurement-health",
      critical: false,
    });
  });

  it("has no fix when MH5 passes and no critical alert is open", async () => {
    mocks.listOpen.mockResolvedValue([
      alert(
        "a-3",
        "ga4:link-1:MH7",
        "WARN",
        "Many visits have no channel (Unassigned)",
      ),
    ]);
    mocks.checkFindUnique.mockResolvedValue({
      status: "PASS",
      evidence: { reason: "ok" },
    });
    const facts = await loadWebsiteJourneyFacts("proj-clean");
    expect(facts).toEqual({
      analytics: "connected",
      hasDomain: true,
      fix: null,
    });
  });

  it("reports not_connected with a domain", async () => {
    mocks.credentialFindUnique.mockResolvedValue(null);
    mocks.primaryGaLink.mockResolvedValue(null);
    const facts = await loadWebsiteJourneyFacts("proj-nc-domain");
    expect(facts).toEqual({
      analytics: "not_connected",
      hasDomain: true,
      fix: null,
    });
    expect(mocks.listOpen).not.toHaveBeenCalled();
  });

  it("reports not_connected without a domain", async () => {
    mocks.projectFindUnique.mockResolvedValue({ domain: null });
    mocks.credentialFindUnique.mockResolvedValue({ status: "REVOKED" });
    const facts = await loadWebsiteJourneyFacts("proj-nc-plain");
    expect(facts).toEqual({
      analytics: "not_connected",
      hasDomain: false,
      fix: null,
    });
  });

  it("counts an expired credential as connected", async () => {
    mocks.credentialFindUnique.mockResolvedValue({ status: "EXPIRED" });
    const facts = await loadWebsiteJourneyFacts("proj-expired");
    expect(facts?.analytics).toBe("connected");
  });
});

describe("loadMeasurementHealth", () => {
  it("returns null without a query when GA_HEALTH is off", async () => {
    vi.stubEnv("GA_HEALTH", "");
    expect(await loadMeasurementHealth("proj-1", NOW)).toBeNull();
    expect(mocks.primaryGaLink).not.toHaveBeenCalled();
  });

  it("fills unchecked rows as UNKNOWN and maps alert ids", async () => {
    const checkedAt = new Date("2026-10-06T13:00:00.000Z");
    mocks.checkFindMany.mockResolvedValue([
      {
        checkKey: "MH1",
        status: "FAIL",
        severity: "CRITICAL",
        evidence: { reason: "stopped", mode: "day", synthetic: true },
        firstFailedAt: checkedAt,
        lastCheckedAt: checkedAt,
      },
      {
        checkKey: "MH2",
        status: "PASS",
        severity: "INFO",
        evidence: { reason: "ok" },
        firstFailedAt: null,
        lastCheckedAt: checkedAt,
      },
    ]);
    mocks.runFindUnique.mockResolvedValue({
      evaluatedAt: checkedAt,
      recheckRequestedAt: new Date(NOW.getTime() - 3 * 60_000),
      siteCheckedAt: null,
      suspectDays: { "2026-10-05": ["MH1"], "2026-01-01": ["MH1"] },
    });
    mocks.listOpen.mockResolvedValue([
      alert(
        "alert-mh1",
        "ga4:link-1:MH1",
        "CRITICAL",
        "Google Analytics stopped receiving data",
      ),
      alert(
        "alert-old",
        "ga4:old-link:MH7",
        "WARN",
        "Many visits have no channel (Unassigned)",
      ),
    ]);

    const health = await loadMeasurementHealth("proj-1", NOW);
    expect(health).not.toBeNull();
    if (!health) return;
    expect(mocks.listOpen).toHaveBeenCalledWith("proj-1", ["GA4"], 50);
    expect(health.checks).toHaveLength(25);
    expect(health.checks[0]).toMatchObject({
      key: "MH1",
      status: "FAIL",
      severity: "CRITICAL",
      alertId: "alert-mh1",
      title: "Google Analytics stopped receiving data",
      firstFailedAt: checkedAt.toISOString(),
      evidence: { reason: "stopped", mode: "day", synthetic: true },
    });
    const mh3 = health.checks.find((check) => check.key === "MH3");
    expect(mh3).toMatchObject({
      status: "UNKNOWN",
      severity: "WARN",
      alertId: null,
      evidence: { reason: "not_checked" },
    });
    // Başka bağın uyarısı bu bağın kontrolüne eşlenmez.
    expect(
      health.checks.find((check) => check.key === "MH7")?.alertId,
    ).toBeNull();
    expect(health.summary.score).toBe(35);
    expect(health.suspectDays).toEqual(["2026-10-05"]);
    expect(health.recheckAvailableAt).toBe(
      new Date(NOW.getTime() + 7 * 60_000).toISOString(),
    );
    expect(health.timeZone).toBe("Europe/Istanbul");
    expect(health.propertyId).toBe("424242");
  });
});
