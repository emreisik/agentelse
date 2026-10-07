import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import type { BigQueryClient } from "@/server/integrations/google/bigquery";

// Bu dosyanın kanıtladığı (GA-F8 kurulum doğrulaması, sahte istemciyle): bayrak kapalı,
// yapılandırılmamış, bağ yok; veri kümesi analytics_<mülk kimliği> dışındaysa İSTEMCİ
// ÇAĞRISINDAN ÖNCE reddedilir; son 4 günde tablo yoksa no_export_tables; üç kuru
// çalıştırmanın TOPLAMI sınırı aşarsa bytes_limit; not_shared iletisi servis hesabı
// e-postasını içerir; her istemci çağrısı tek gcpProjectId'yi projectId olarak kullanır;
// başarıda kaynak OK kaydedilir ve denetim yazılır.

const mocks = vi.hoisted(() => ({
  linkFindFirst: vi.fn(),
  sourceFindUnique: vi.fn(),
  sourceUpsert: vi.fn(),
  record: vi.fn(),
  registerMock: vi.fn(),
  mockMode: vi.fn(() => false),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gaPropertyLink: { findFirst: mocks.linkFindFirst },
    gaBigQuerySource: {
      findUnique: mocks.sourceFindUnique,
      upsert: mocks.sourceUpsert,
    },
  },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.record },
}));
vi.mock("./mock", () => ({ registerGaBigQueryMock: mocks.registerMock }));
vi.mock("@/server/integrations/google/bigquery", () => {
  class BigQueryError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  return {
    BigQueryError,
    bigQueryClient: vi.fn(),
    bigQueryMockMode: mocks.mockMode,
    isValidGcpProjectId: (value: string) =>
      /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value),
    isValidDatasetId: (value: string) => /^[A-Za-z0-9_]{1,1024}$/.test(value),
  };
});

const { BigQueryError } = await import("@/server/integrations/google/bigquery");
const { verifyAndSaveBigQuerySource } = await import("./verify");

const NOW = new Date("2026-10-07T10:00:00Z");
const SA = "reader@agentelse.iam.gserviceaccount.com";

const link = {
  id: "link1",
  workspaceId: "ws1",
  projectId: "proj1",
  propertyId: "424242",
  keyEvents: [{ eventName: "purchase" }],
  isPrimary: true,
  isSecondary: false,
};

// Her istemci yöntemi vi.fn olarak tiplenir (.mock / .mockImplementation).
type FakeClient = BigQueryClient & { [K in keyof BigQueryClient]: Mock };

function fakeClient(
  over: Partial<{ [K in keyof BigQueryClient]: Mock }> = {},
): FakeClient {
  const client = {
    configured: vi.fn(() => true),
    serviceAccountEmail: vi.fn(() => SA),
    query: vi.fn(),
    dryRun: vi.fn(async () => ({ bytesProcessed: 50_000_000 })),
    getTable: vi.fn(async () => ({
      numRows: 1,
      sizeBytes: 1,
      location: "EU",
      partitionField: null,
    })),
    getDataset: vi.fn(async () => ({ location: "EU" })),
    ...over,
  };
  return client as unknown as FakeClient;
}

const input = {
  projectId: "proj1",
  linkId: "link1",
  userId: "user1",
  config: { gcpProjectId: "my-company-123456", datasetId: "analytics_424242" },
};
const deps = (client: BigQueryClient) => ({ client, now: () => NOW });

beforeEach(() => {
  vi.stubEnv("GA_AGENCY", "true");
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_BIGQUERY", "true");
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
  mocks.linkFindFirst.mockReset().mockResolvedValue(link);
  mocks.sourceFindUnique.mockReset().mockResolvedValue(null);
  mocks.sourceUpsert.mockReset().mockResolvedValue({ id: "src1" });
  mocks.record.mockReset().mockResolvedValue({});
  mocks.registerMock.mockReset();
  mocks.mockMode.mockReset().mockReturnValue(false);
});
afterEach(() => vi.unstubAllEnvs());

describe("verifyAndSaveBigQuerySource gates", () => {
  it("answers off without touching the client or the database when the flag is off", async () => {
    vi.stubEnv("GA_BIGQUERY", "false");
    const client = fakeClient();
    const result = await verifyAndSaveBigQuerySource(input, deps(client));
    expect(result).toMatchObject({ ok: false, code: "off" });
    expect(client.configured).not.toHaveBeenCalled();
    expect(mocks.linkFindFirst).not.toHaveBeenCalled();
  });

  it("answers not_configured when the server has no service account", async () => {
    const client = fakeClient({ configured: vi.fn(() => false) });
    const result = await verifyAndSaveBigQuerySource(input, deps(client));
    expect(result).toEqual({
      ok: false,
      code: "not_configured",
      message: "BigQuery isn't set up on this Agentelse server yet.",
    });
    expect(client.getDataset).not.toHaveBeenCalled();
  });

  it("answers no_link when the link is not an engine link of the project", async () => {
    mocks.linkFindFirst.mockResolvedValue(null);
    const result = await verifyAndSaveBigQuerySource(input, deps(fakeClient()));
    expect(result).toMatchObject({ ok: false, code: "no_link" });
    const where = mocks.linkFindFirst.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({ id: "link1", projectId: "proj1" });
    expect(where.OR).toEqual([{ isPrimary: true }, { isSecondary: true }]);
  });

  it("registers the ga. mock handler before the first client call in mock mode", async () => {
    mocks.mockMode.mockReturnValue(true);
    const client = fakeClient();
    client.getDataset.mockImplementation(async () => {
      expect(mocks.registerMock).toHaveBeenCalled();
      return { location: "US" };
    });
    await verifyAndSaveBigQuerySource(input, deps(client));
    expect(client.getDataset).toHaveBeenCalled();
  });
});

describe("binding rules", () => {
  it.each(["analytics_999999", "events", "analytics_424242_x"])(
    "refuses dataset %s before any client call",
    async (datasetId) => {
      const client = fakeClient();
      const result = await verifyAndSaveBigQuerySource(
        { ...input, config: { ...input.config, datasetId } },
        deps(client),
      );
      expect(result).toEqual({
        ok: false,
        code: "invalid",
        message: "The export dataset of this property is analytics_424242.",
      });
      expect(client.getDataset).not.toHaveBeenCalled();
      expect(client.getTable).not.toHaveBeenCalled();
      expect(client.dryRun).not.toHaveBeenCalled();
      expect(mocks.sourceUpsert).not.toHaveBeenCalled();
    },
  );

  it("refuses an invalid project id before any client call", async () => {
    const client = fakeClient();
    const result = await verifyAndSaveBigQuerySource(
      { ...input, config: { ...input.config, gcpProjectId: "Bad Project" } },
      deps(client),
    );
    expect(result).toMatchObject({ ok: false, code: "invalid" });
    expect(client.getDataset).not.toHaveBeenCalled();
  });

  it("uses the single gcpProjectId as projectId in every client call and ignores extra fields", async () => {
    const client = fakeClient();
    const result = await verifyAndSaveBigQuerySource(
      {
        ...input,
        config: {
          ...input.config,
          billingProjectId: "victim-project-999999",
        } as typeof input.config,
      },
      deps(client),
    );
    expect(result).toEqual({ ok: true });
    const projects = [
      ...client.getDataset.mock.calls.map((c) => c[0].projectId),
      ...client.getTable.mock.calls.map((c) => c[0].projectId),
      ...client.dryRun.mock.calls.map((c) => c[0].projectId),
    ];
    expect(projects.length).toBe(1 + 1 + 3);
    expect(new Set(projects)).toEqual(new Set(["my-company-123456"]));
    expect(JSON.stringify(client.dryRun.mock.calls)).not.toContain("victim");
    expect(JSON.stringify(mocks.sourceUpsert.mock.calls)).not.toContain("victim");
  });
});

describe("export probing", () => {
  it("answers no_export_tables when none of the last 4 days exists", async () => {
    const client = fakeClient({
      getTable: vi.fn(async () => {
        throw new BigQueryError("NOT_FOUND");
      }),
    });
    const result = await verifyAndSaveBigQuerySource(input, deps(client));
    expect(result).toMatchObject({ ok: false, code: "no_export_tables" });
    const tables = (client.getTable as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0].table,
    );
    expect(tables).toEqual([
      "events_20261006",
      "events_20261005",
      "events_20261004",
      "events_20261003",
    ]);
    expect(client.dryRun).not.toHaveBeenCalled();
  });

  it("keeps probing past a missing day and stops at the first table found", async () => {
    const getTable = vi
      .fn()
      .mockRejectedValueOnce(new BigQueryError("NOT_FOUND"))
      .mockResolvedValueOnce({ numRows: 1, sizeBytes: 1, location: null, partitionField: null });
    const client = fakeClient({ getTable });
    const result = await verifyAndSaveBigQuerySource(input, deps(client));
    expect(result).toEqual({ ok: true });
    expect(getTable).toHaveBeenCalledTimes(2);
  });

  it("maps a non-NOT_FOUND table error through the shared error map", async () => {
    const client = fakeClient({
      getTable: vi.fn(async () => {
        throw new BigQueryError("NO_ACCESS");
      }),
    });
    expect(await verifyAndSaveBigQuerySource(input, deps(client))).toMatchObject({
      ok: false,
      code: "not_shared",
    });
  });
});

describe("cost cap", () => {
  it("dry-runs the three statements and refuses when their SUM exceeds the cap", async () => {
    const client = fakeClient({
      dryRun: vi.fn(async () => ({ bytesProcessed: 700_000_000 })),
    });
    const result = await verifyAndSaveBigQuerySource(input, deps(client));
    expect(result).toMatchObject({ ok: false, code: "bytes_limit" });
    const purposes = (client.dryRun as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0].purpose,
    );
    expect(purposes).toEqual(["ga.daily", "ga.events", "ga.pages"]);
    expect(mocks.sourceUpsert).not.toHaveBeenCalled();
  });

  it("accepts a sum that fits and passes the cap and maxRows to each dry run", async () => {
    const client = fakeClient({
      dryRun: vi.fn(async () => ({ bytesProcessed: 600_000_000 })),
    });
    expect(await verifyAndSaveBigQuerySource(input, deps(client))).toEqual({ ok: true });
    for (const call of (client.dryRun as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0].maxBytesBilled).toBe(2_000_000_000);
      expect(call[0].maxRows).toBeGreaterThan(0);
      expect(call[0].sql).toContain("events_*");
    }
  });
});

describe("errors", () => {
  it("names the service account and both roles for not_shared", async () => {
    const client = fakeClient({
      getDataset: vi.fn(async () => {
        throw new BigQueryError("NO_ACCESS");
      }),
    });
    const result = await verifyAndSaveBigQuerySource(input, deps(client));
    expect(result).toMatchObject({ ok: false, code: "not_shared" });
    if (result.ok) return;
    expect(result.message).toContain(SA);
    expect(result.message).toContain("BigQuery Data Viewer");
    expect(result.message).toContain("BigQuery Job User");
  });

  it("maps other BigQuery errors without leaking their text", async () => {
    const client = fakeClient({
      getDataset: vi.fn(async () => {
        throw new BigQueryError("BILLING_DISABLED");
      }),
    });
    expect(await verifyAndSaveBigQuerySource(input, deps(client))).toMatchObject({
      ok: false,
      code: "billing",
    });
  });

  it("answers unavailable for unexpected errors and never throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = fakeClient({
      getDataset: vi.fn(async () => {
        throw new TypeError("secret detail");
      }),
    });
    const result = await verifyAndSaveBigQuerySource(input, deps(client));
    expect(result).toMatchObject({ ok: false, code: "unavailable" });
    if (!result.ok) expect(result.message).not.toContain("secret");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret detail");
    spy.mockRestore();
  });
});

describe("saving", () => {
  it("saves an OK source due now and audits with ids only", async () => {
    const client = fakeClient();
    expect(await verifyAndSaveBigQuerySource(input, deps(client))).toEqual({ ok: true });
    const call = mocks.sourceUpsert.mock.calls[0]?.[0];
    expect(call.where).toEqual({ linkId: "link1" });
    expect(call.create).toMatchObject({
      workspaceId: "ws1",
      projectId: "proj1",
      linkId: "link1",
      gcpProjectId: "my-company-123456",
      datasetId: "analytics_424242",
      location: "EU",
      status: "OK",
      lastError: null,
      verifiedAt: NOW,
      nextRunAt: NOW,
      createdByUserId: "user1",
    });
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws1",
        projectId: "proj1",
        actorType: "USER",
        actorId: "user1",
        action: "ga_bigquery.source_saved",
        entityType: "GaBigQuerySource",
        entityId: "src1",
      }),
    );
  });

  it("lets the user's location win over the dataset's", async () => {
    const client = fakeClient();
    await verifyAndSaveBigQuerySource(
      { ...input, config: { ...input.config, location: "US" } },
      deps(client),
    );
    expect(mocks.sourceUpsert.mock.calls[0]?.[0].create.location).toBe("US");
    expect(client.dryRun.mock.calls[0]?.[0].location).toBe("US");
  });

  it("resets the read position only when the target changed", async () => {
    mocks.sourceFindUnique.mockResolvedValue({
      id: "src1",
      gcpProjectId: "other-project-123456",
      datasetId: "analytics_424242",
    });
    await verifyAndSaveBigQuerySource(input, deps(fakeClient()));
    expect(mocks.sourceUpsert.mock.calls[0]?.[0].update).toMatchObject({ lastDay: null });

    mocks.sourceUpsert.mockClear();
    mocks.sourceFindUnique.mockResolvedValue({
      id: "src1",
      gcpProjectId: "my-company-123456",
      datasetId: "analytics_424242",
    });
    await verifyAndSaveBigQuerySource(input, deps(fakeClient()));
    expect(mocks.sourceUpsert.mock.calls[0]?.[0].update).not.toHaveProperty("lastDay");
  });
});
