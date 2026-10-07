import type { GscBqSource, GscSiteLink } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BigQueryError,
  type BigQueryClient,
  type BqCell,
  type BqQueryRequest,
  type BqQueryResult,
} from "@/server/integrations/google/bigquery";

// Bu dosyanın kanıtladığı: sahiplik ilk adımdır ve hiçbir BigQuery çağrısından
// önce denetlenir; her adım hatası zinciri durdurur (kalanı skipped) ve doğru
// hata koduyla biter; yalnız bağın kendi mülkü sorgulanır; maliyet tahmini ve
// mutabakat uyarı verir; başarıda VERIFIED yazılır; hız sınırı çalışır.

const prisma = vi.hoisted(() => ({
  gscSiteLink: { findFirst: vi.fn() },
  gscBqSource: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  gscDailyTotal: { findMany: vi.fn() },
  integrationCredential: { findUnique: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma }));
const record = vi.hoisted(() => vi.fn());
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record },
}));

const { verifyBqSource } = await import("./verify");

const NOW = new Date("2026-10-07T19:00:00Z"); // PT günü 2026-10-07
const GIB = 1024 ** 3;

const link = {
  id: "link-1",
  workspaceId: "ws-1",
  projectId: "proj-1",
  siteUrl: "sc-domain:example.com",
  isMock: false,
  isPrimary: true,
  isSecondary: false,
  permissionLevel: "siteOwner",
  lastFinalDate: "2026-10-04",
} as unknown as GscSiteLink;

function sourceRow(over: Partial<GscBqSource> = {}): GscBqSource {
  return {
    id: "src-1",
    projectId: "proj-1",
    siteUrl: "sc-domain:example.com",
    isMock: false,
    status: "DRAFT",
    bqProjectId: "my-cloud-proj",
    dataset: "searchconsole",
    location: null,
    maxBytesPerQuery: BigInt(10 * GIB),
    monthlyBudgetBytes: BigInt(300 * GIB),
    ...over,
  } as unknown as GscBqSource;
}

type Script = {
  configured?: boolean;
  dataset?: BigQueryError;
  table?: BigQueryError;
  logError?: BigQueryError;
  probeError?: BigQueryError;
  logRows?: BqCell[][];
  siteRows?: BqCell[][];
  dryBytes?: number;
  bqClicks?: number;
  bqImpressions?: number;
};

function makeClient(script: Script = {}) {
  const requests: BqQueryRequest[] = [];
  const calls: string[] = [];
  const result = (rows: BqCell[][]): BqQueryResult => ({
    columns: [],
    rows,
    totalRows: rows.length,
    truncated: false,
    bytesProcessed: 1_000_000,
    bytesBilled: 10_485_760,
    cacheHit: false,
  });
  const client: BigQueryClient = {
    configured: () => script.configured ?? true,
    serviceAccountEmail: () => "sa@example.com",
    async getDataset() {
      calls.push("getDataset");
      if (script.dataset) throw script.dataset;
      return { location: "EU" };
    },
    async getTable() {
      calls.push("getTable");
      if (script.table) throw script.table;
      return { numRows: 1, sizeBytes: 1, location: "EU", partitionField: "data_date" };
    },
    async dryRun(request) {
      calls.push("dryRun");
      requests.push(request);
      return { bytesProcessed: script.dryBytes ?? 2_400_000_000 };
    },
    async query(request) {
      calls.push(request.purpose);
      requests.push(request);
      switch (request.purpose) {
        case "gsc.coverage.log":
          if (script.logError) throw script.logError;
          return result(
            script.logRows ?? [
              ["SEARCHDATA_SITE_IMPRESSION", "2026-06-09", "2026-10-04", 118],
              ["SEARCHDATA_URL_IMPRESSION", "2026-06-09", "2026-10-04", 118],
            ],
          );
        case "gsc.coverage.table":
          if (script.probeError) throw script.probeError;
          return result([["2026-06-09", "2026-10-04", 118]]);
        case "gsc.sites":
          return result(script.siteRows ?? [["sc-domain:example.com", 500, 9000]]);
        case "gsc.reconcile.days": {
          const rows: BqCell[][] = [];
          for (let day = 21; day <= 30; day += 1) {
            rows.push([`2026-09-${day}`, script.bqClicks ?? 100, script.bqImpressions ?? 1000]);
          }
          for (let day = 1; day <= 4; day += 1) {
            rows.push([`2026-10-0${day}`, script.bqClicks ?? 100, script.bqImpressions ?? 1000]);
          }
          return result(rows);
        }
        default:
          return result([]);
      }
    },
  };
  return { client, calls, requests };
}

function apiDays(): { date: Date; clicks: number; impressions: number }[] {
  const days: string[] = [];
  for (let day = 21; day <= 30; day += 1) days.push(`2026-09-${day}`);
  for (let day = 1; day <= 4; day += 1) days.push(`2026-10-0${day}`);
  return days.map((day) => ({
    date: new Date(`${day}T00:00:00.000Z`),
    clicks: 100,
    impressions: 1000,
  }));
}

let linkCounter = 0;
async function verify(script: Script = {}, over: { link?: Partial<GscSiteLink>; source?: Partial<GscBqSource> } = {}) {
  linkCounter += 1;
  const linkId = `link-${linkCounter}`;
  prisma.gscSiteLink.findFirst.mockResolvedValue({ ...link, id: linkId, ...over.link });
  prisma.gscBqSource.findUnique.mockResolvedValue(sourceRow(over.source));
  const fake = makeClient(script);
  const result = await verifyBqSource({
    projectId: "proj-1",
    linkId,
    userId: "user-1",
    now: NOW,
    client: fake.client,
  });
  return { result, ...fake, linkId };
}

// Sonucu yazan çağrı koşullu updateMany'dir (hedef değişmediyse yazar).
const savedData = () => prisma.gscBqSource.updateMany.mock.calls[0]![0].data as Record<string, unknown>;
const stateOf = (result: { steps: { key: string; state: string }[] }, key: string) =>
  result.steps.find((step) => step.key === key)?.state;

beforeEach(() => {
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("GSC_AGENCY", "true");
  vi.stubEnv("GSC_BIGQUERY", "true");
  vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
  vi.stubEnv("GSC_SYNC_DEV_PROJECTS", "");
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
  for (const mock of [
    prisma.gscSiteLink.findFirst,
    prisma.gscBqSource.findUnique,
    prisma.gscBqSource.update,
    prisma.gscBqSource.updateMany,
    prisma.gscDailyTotal.findMany,
    prisma.integrationCredential.findUnique,
    record,
  ]) {
    mock.mockReset();
  }
  prisma.gscBqSource.update.mockResolvedValue({});
  prisma.gscBqSource.updateMany.mockResolvedValue({ count: 1 });
  prisma.gscDailyTotal.findMany.mockResolvedValue(apiDays());
  prisma.integrationCredential.findUnique.mockResolvedValue({ status: "ACTIVE" });
  record.mockResolvedValue({});
});

describe("success", () => {
  it("passes every step, saves coverage, location and the site literal, and sets VERIFIED", async () => {
    const { result } = await verify();
    expect(result.ok).toBe(true);
    expect(result.errorCode).toBeNull();
    expect(result.steps.map((step) => step.key)).toEqual([
      "ownership",
      "service_account",
      "dataset",
      "tables",
      "site_match",
      "export_data",
      "cost_estimate",
      "reconcile",
    ]);
    expect(result.steps.every((step) => step.state === "ok")).toBe(true);
    expect(result.steps.find((s) => s.key === "cost_estimate")?.detail).toBe(
      "about 2.4 GB per weekly import",
    );
    const data = savedData();
    expect(data).toMatchObject({
      status: "VERIFIED",
      lastError: null,
      location: "EU",
      exportStart: "2026-06-09",
      exportedThrough: "2026-10-04",
      bqSiteUrl: "sc-domain:example.com",
      consecutiveFailures: 0,
      reconcile: { days: 14, clicksDiffPct: 0, impressionsDiffPct: 0 },
    });
    expect(data.lastVerifiedAt).toEqual(NOW);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "gsc_bigquery.verified",
        metadata: { linkId: expect.any(String), ok: true },
      }),
    );
  });

  it("keeps an ACTIVE source ACTIVE", async () => {
    await verify({}, { source: { status: "ACTIVE" } });
    expect(savedData().status).toBe("ACTIVE");
  });

  it("adds the billed bytes of the verification queries to the usage", async () => {
    await verify();
    expect(prisma.gscBqSource.update).toHaveBeenCalledTimes(1);
    const usage = prisma.gscBqSource.update.mock.calls[0]![0].data;
    expect(usage.queriesMonth).toEqual({ increment: 3 });
  });

  it("caps verification queries at min(per-query cap, 1 GiB)", async () => {
    const { requests } = await verify();
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.maxBytesBilled).toBe(GIB);
    }
    const small = await verify({}, { source: { maxBytesPerQuery: BigInt(5 * 1024 ** 2) } });
    for (const request of small.requests) {
      expect(request.maxBytesBilled).toBe(10 * 1024 ** 2);
    }
  });
});

describe("ownership", () => {
  it("refuses when the Search Console credential is no longer active or the link health is bad", async () => {
    prisma.integrationCredential.findUnique.mockResolvedValue({ status: "EXPIRED" });
    const expired = await verify();
    expect(expired.result.errorCode).toBe("NOT_OWNER");
    expect(expired.calls).toEqual([]);
    prisma.integrationCredential.findUnique.mockResolvedValue({ status: "ACTIVE" });
    const health = await verify({}, { link: { health: "AUTH" } });
    expect(health.result.errorCode).toBe("NOT_OWNER");
    expect(health.calls).toEqual([]);
  });

  it("refuses a non-owner before any BigQuery call", async () => {
    const { result, calls } = await verify({}, { link: { permissionLevel: "siteFullUser" } });
    expect(calls).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("NOT_OWNER");
    expect(stateOf(result, "ownership")).toBe("fail");
    expect(result.steps.slice(1).every((step) => step.state === "skipped")).toBe(true);
    expect(savedData()).toMatchObject({ status: "ERROR", lastError: "NOT_OWNER" });
  });

  it("refuses a link without a permission level", async () => {
    const { result, calls } = await verify({}, { link: { permissionLevel: null } });
    expect(calls).toEqual([]);
    expect(result.errorCode).toBe("NOT_OWNER");
  });
});

describe("failing steps stop the chain", () => {
  it("service account not configured", async () => {
    const { result, calls } = await verify({ configured: false });
    expect(result.errorCode).toBe("NOT_CONFIGURED");
    expect(stateOf(result, "service_account")).toBe("fail");
    expect(calls).toEqual([]);
  });

  it("NO_ACCESS on the dataset", async () => {
    const { result, calls } = await verify({ dataset: new BigQueryError("NO_ACCESS") });
    expect(result.errorCode).toBe("NO_ACCESS");
    expect(stateOf(result, "dataset")).toBe("fail");
    expect(stateOf(result, "tables")).toBe("skipped");
    expect(calls).toEqual(["getDataset"]);
    expect(result.steps.find((s) => s.key === "dataset")?.detail).toContain("BigQuery Data Viewer");
    expect(savedData()).toMatchObject({ status: "ERROR", lastError: "NO_ACCESS" });
  });

  it("NOT_FOUND on a table is reported as NO_ACCESS before the site match", async () => {
    const { result } = await verify({ table: new BigQueryError("NOT_FOUND") });
    expect(result.errorCode).toBe("NO_ACCESS");
    expect(stateOf(result, "dataset")).toBe("ok");
    expect(stateOf(result, "tables")).toBe("fail");
    expect(stateOf(result, "export_data")).toBe("skipped");
  });

  it("an empty ExportLog falls through to the table probes", async () => {
    const { result, calls } = await verify({ logRows: [] });
    expect(result.ok).toBe(true);
    expect(calls.filter((call) => call === "gsc.coverage.table")).toHaveLength(2);
  });

  it("NO_EXPORT_DATA with an empty log and empty probes", async () => {
    const empty: BqQueryResult = {
      columns: [],
      rows: [[null, null, 0]],
      totalRows: 1,
      truncated: false,
      bytesProcessed: 0,
      bytesBilled: 0,
      cacheHit: false,
    };
    linkCounter += 1;
    const linkId = `link-empty-${linkCounter}`;
    prisma.gscSiteLink.findFirst.mockResolvedValue({ ...link, id: linkId });
    prisma.gscBqSource.findUnique.mockResolvedValue(sourceRow());
    const fake = makeClient();
    const client: BigQueryClient = {
      ...fake.client,
      query: async (request) =>
        request.purpose === "gsc.sites" ? fake.client.query(request) : empty,
    };
    const result = await verifyBqSource({
      projectId: "proj-1",
      linkId,
      userId: "user-1",
      now: NOW,
      client,
    });
    expect(result.errorCode).toBe("NO_EXPORT_DATA");
    expect(stateOf(result, "export_data")).toBe("fail");
    expect(stateOf(result, "site_match")).toBe("ok");
    expect(result.steps.find((s) => s.key === "export_data")?.detail).toContain(
      "within 48 hours",
    );
  });

  it("falls back to the table probes when ExportLog is missing", async () => {
    const { result, calls } = await verify({ logError: new BigQueryError("NOT_FOUND") });
    expect(result.ok).toBe(true);
    expect(calls.filter((call) => call === "gsc.coverage.table")).toHaveLength(2);
  });

  it("does not fall back on an access error", async () => {
    const { result, calls } = await verify({ logError: new BigQueryError("NO_ACCESS") });
    expect(result.errorCode).toBe("NO_ACCESS");
    expect(stateOf(result, "export_data")).toBe("fail");
    expect(calls).not.toContain("gsc.coverage.table");
  });

  it("an unknown column surfaces as INVALID_QUERY and ERROR, never a crash", async () => {
    const { result } = await verify({
      logError: new BigQueryError("INVALID_QUERY"),
      probeError: new BigQueryError("INVALID_QUERY"),
    });
    expect(result.errorCode).toBe("INVALID_QUERY");
    expect(stateOf(result, "export_data")).toBe("fail");
    expect(savedData()).toMatchObject({ status: "ERROR", lastError: "INVALID_QUERY" });
  });
});

describe("site match (confused deputy)", () => {
  it("a dataset without the own property ends as SITE_MISMATCH and nothing else is read", async () => {
    const { result, calls, requests } = await verify({ siteRows: [] });
    expect(result.errorCode).toBe("SITE_MISMATCH");
    expect(stateOf(result, "site_match")).toBe("fail");
    // Eşleşmeyen veri kümesi hakkında hiçbir şey okunmaz ya da gösterilmez.
    expect(stateOf(result, "dataset")).toBe("skipped");
    expect(stateOf(result, "tables")).toBe("skipped");
    expect(stateOf(result, "export_data")).toBe("skipped");
    expect(calls).not.toContain("gsc.coverage.log");
    expect(calls).not.toContain("gsc.coverage.table");
    expect(stateOf(result, "cost_estimate")).toBe("skipped");
    expect(stateOf(result, "reconcile")).toBe("skipped");
    expect(calls).not.toContain("dryRun");
    expect(calls).not.toContain("gsc.reconcile.days");
    // Hiçbir sorgu başka bir mülkü adlandırmaz ya da listelemez.
    for (const request of requests) {
      for (const param of request.params) {
        if (param.name === "site" || param.name === "site_url") {
          expect(String(param.value).toLowerCase()).toBe("sc-domain:example.com");
        }
      }
    }
    const save = savedData();
    expect(save.bqSiteUrl).toBeUndefined();
    expect(save.exportStart).toBeUndefined();
    expect(save).toMatchObject({ status: "ERROR", lastError: "SITE_MISMATCH" });
  });

  it("only the rows of the own property count even when other rows are returned", async () => {
    const { result } = await verify({
      siteRows: [
        ["sc-domain:other.com", 99999, 99999],
        ["sc-domain:example.com", 5, 50],
      ],
    });
    expect(result.ok).toBe(true);
    expect(savedData().bqSiteUrl).toBe("sc-domain:example.com");
  });

  it("a foreign-only result is a mismatch", async () => {
    const { result } = await verify({ siteRows: [["sc-domain:other.com", 99999, 99999]] });
    expect(result.errorCode).toBe("SITE_MISMATCH");
  });
});

describe("target changed during verification", () => {
  it("writes nothing and reports a generic failure when the source was repointed", async () => {
    prisma.gscBqSource.updateMany.mockResolvedValue({ count: 0 });
    const { result } = await verify();
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("INVALID_REQUEST");
    expect(prisma.gscBqSource.update).not.toHaveBeenCalled();
    expect(prisma.gscBqSource.updateMany).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
  });

  it("pins the write to the verified project and dataset", async () => {
    await verify();
    const where = prisma.gscBqSource.updateMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({ id: expect.any(String), bqProjectId: expect.any(String), dataset: expect.any(String) });
  });
});

describe("warnings", () => {
  it("warns when the weekly estimate is above the cap", async () => {
    const { result } = await verify({ dryBytes: 20 * GIB });
    expect(result.ok).toBe(true);
    const step = result.steps.find((s) => s.key === "cost_estimate");
    expect(step?.state).toBe("warn");
    expect(step?.detail).toContain("raise the cap");
  });

  it("warns and stores the difference when the totals differ by more than 3%", async () => {
    const { result } = await verify({ bqClicks: 110 });
    expect(result.ok).toBe(true);
    expect(stateOf(result, "reconcile")).toBe("warn");
    expect(savedData().reconcile).toMatchObject({ days: 14, clicksDiffPct: 10, impressionsDiffPct: 0 });
  });

  it("rounds the difference to one decimal", async () => {
    await verify({ bqClicks: 101.234 });
    expect((savedData().reconcile as { clicksDiffPct: number }).clicksDiffPct).toBe(1.2);
  });

  it("skips the reconcile when there is no overlap with the API yet", async () => {
    const { result } = await verify({}, { link: { lastFinalDate: null } });
    expect(result.ok).toBe(true);
    expect(stateOf(result, "reconcile")).toBe("skipped");
    expect(savedData().reconcile).toBeUndefined();
  });
});

describe("guards", () => {
  it("is rate limited to 5 verifications per 10 minutes per link", async () => {
    linkCounter += 1;
    const linkId = `link-rate-${linkCounter}`;
    prisma.gscSiteLink.findFirst.mockResolvedValue({ ...link, id: linkId });
    prisma.gscBqSource.findUnique.mockResolvedValue(sourceRow());
    const run = () =>
      verifyBqSource({
        projectId: "proj-1",
        linkId,
        userId: "user-1",
        now: NOW,
        client: makeClient().client,
      });
    for (let i = 0; i < 5; i += 1) expect((await run()).errorCode).not.toBe("RATE_LIMIT");
    prisma.gscSiteLink.findFirst.mockClear();
    const blocked = await run();
    expect(blocked.ok).toBe(false);
    expect(blocked.errorCode).toBe("RATE_LIMIT");
    expect(blocked.steps.every((step) => step.state === "skipped")).toBe(true);
    expect(prisma.gscSiteLink.findFirst).not.toHaveBeenCalled();
  });

  it("does nothing when the flag is off", async () => {
    vi.stubEnv("GSC_BIGQUERY", "");
    const { result } = await verify();
    expect(result.ok).toBe(false);
    expect(prisma.gscSiteLink.findFirst).not.toHaveBeenCalled();
  });

  it("refuses an unknown link or a missing source without writing", async () => {
    linkCounter += 1;
    prisma.gscSiteLink.findFirst.mockResolvedValue(null);
    const none = await verifyBqSource({
      projectId: "proj-1",
      linkId: `x-${linkCounter}`,
      userId: "u",
      now: NOW,
      client: makeClient().client,
    });
    expect(none.ok).toBe(false);
    expect(prisma.gscBqSource.update).not.toHaveBeenCalled();
    prisma.gscSiteLink.findFirst.mockResolvedValue({ ...link, id: `y-${linkCounter}` });
    prisma.gscBqSource.findUnique.mockResolvedValue(null);
    const missing = await verifyBqSource({
      projectId: "proj-1",
      linkId: `y-${linkCounter}`,
      userId: "u",
      now: NOW,
      client: makeClient().client,
    });
    expect(missing.ok).toBe(false);
    expect(prisma.gscBqSource.update).not.toHaveBeenCalled();
  });
});
