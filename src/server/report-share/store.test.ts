import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: oluşturmada yalnız sha256 özeti saklanır, gizli
// parça yalnız dönen belirteçtedir; gün değeri ve 50'lik sınır denetlenir;
// liste tek sorgu, rapor başına en çok 5; iptal projeye kapsamlıdır; resolve
// bilinmeyen/yanlış gizli parça/iptal/süresi dolmuş için AYNI sonucu verir;
// görüntüleme sayacı dakikada bir; silme yolları bayrağa bağlı değildir.

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  count: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
  record: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    reportShare: {
      create: mocks.create,
      count: mocks.count,
      findMany: mocks.findMany,
      findFirst: mocks.findFirst,
      findUnique: mocks.findUnique,
      updateMany: mocks.updateMany,
      deleteMany: mocks.deleteMany,
    },
  },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.record },
}));

import {
  generateShareSecret,
  hashShareSecret,
  parseShareToken,
} from "@/lib/report-share/token";
import type { BrandingSnapshot } from "@/lib/report-share/types";
import { ReportShares } from "./store";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const DAY = 86_400_000;
const ID = "clshare0123456789abcdefg";
const BRANDING: BrandingSnapshot = {
  displayName: "Acme",
  accent: "blue",
  footer: null,
  logoAssetId: null,
};

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws1",
    projectId: "p1",
    kind: "SEARCH" as const,
    reportId: "rep1",
    days: 30,
    userId: "u1",
    branding: BRANDING,
    now: NOW,
    ...overrides,
  };
}

function shareRow(secret: string, overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    workspaceId: "ws1",
    projectId: "p1",
    kind: "SEARCH",
    reportId: "rep1",
    tokenHash: hashShareSecret(secret),
    branding: BRANDING,
    expiresAt: new Date(NOW.getTime() + 5 * DAY),
    revokedAt: null,
    createdByUserId: "u1",
    viewCount: 0,
    lastViewedAt: null,
    createdAt: new Date(NOW.getTime() - DAY),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.count.mockResolvedValue(0);
  mocks.create.mockResolvedValue({ id: ID });
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.deleteMany.mockResolvedValue({ count: 1 });
  mocks.record.mockResolvedValue({});
});

describe("ReportShares.create", () => {
  it("stores only the hash and returns the token once", async () => {
    const result = await ReportShares.create(createInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = parseShareToken(result.token);
    expect(parsed?.id).toBe(ID);
    const data = mocks.create.mock.calls[0]?.[0].data;
    expect(data.tokenHash).toBe(hashShareSecret(parsed!.secret));
    expect(JSON.stringify(data)).not.toContain(parsed!.secret);
    expect(data.kind).toBe("SEARCH");
    expect(data.expiresAt).toEqual(new Date(NOW.getTime() + 30 * DAY));
    expect(result.expiresAt).toEqual(new Date(NOW.getTime() + 30 * DAY));
    // Denetim kimlik ve tür taşır; belirteç ya da gizli parça yok.
    const audit = mocks.record.mock.calls[0]?.[0];
    expect(audit.action).toBe("report_share.created");
    expect(audit.metadata).toEqual({ kind: "SEARCH", shareId: ID });
    expect(JSON.stringify(audit)).not.toContain(parsed!.secret);
  });

  it("copies the branding snapshot", async () => {
    await ReportShares.create(createInput());
    expect(mocks.create.mock.calls[0]?.[0].data.branding).toEqual(BRANDING);
  });

  it("refuses a days value outside 7/30/90", async () => {
    for (const days of [0, 1, 14, 365, Number.NaN]) {
      expect(await ReportShares.create(createInput({ days }))).toEqual({
        ok: false,
        code: "INVALID_DAYS",
      });
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses the 51st active share of a project", async () => {
    mocks.count.mockResolvedValue(50);
    expect(await ReportShares.create(createInput())).toEqual({
      ok: false,
      code: "LIMIT",
    });
    expect(mocks.create).not.toHaveBeenCalled();
    const where = mocks.count.mock.calls[0]?.[0].where;
    expect(where).toMatchObject({ projectId: "p1", revokedAt: null });
    mocks.count.mockResolvedValue(49);
    expect((await ReportShares.create(createInput())).ok).toBe(true);
  });

  it("still returns the link when the audit write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.record.mockRejectedValue(new Error("db down"));
    expect((await ReportShares.create(createInput())).ok).toBe(true);
  });
});

describe("ReportShares.listForProject", () => {
  it("makes no query without report ids", async () => {
    expect(await ReportShares.listForProject("p1", "SEARCH", [])).toEqual({});
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("groups by report, caps at 5 per report with one query and sets status", async () => {
    const rows = [];
    for (let index = 0; index < 7; index += 1) {
      rows.push(
        shareRow("s", {
          id: `a${index}`,
          reportId: "r1",
          createdAt: new Date(NOW.getTime() - index * 1000),
        }),
      );
    }
    rows.push(
      shareRow("s", {
        id: "b0",
        reportId: "r2",
        revokedAt: new Date(NOW.getTime() - 1000),
      }),
      shareRow("s", {
        id: "b1",
        reportId: "r2",
        expiresAt: new Date(NOW.getTime() - 1000),
      }),
    );
    mocks.findMany.mockResolvedValue(rows);
    const result = await ReportShares.listForProject(
      "p1",
      "SEARCH",
      ["r1", "r2"],
      NOW,
    );
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(result.r1).toHaveLength(5);
    expect(result.r1?.[0]?.status).toBe("ACTIVE");
    expect(result.r2?.map((item) => item.status)).toEqual([
      "REVOKED",
      "EXPIRED",
    ]);
    expect(JSON.stringify(result)).not.toContain("tokenHash");
  });
});

describe("ReportShares.revoke", () => {
  it("is scoped to the project", async () => {
    mocks.findFirst.mockResolvedValue({
      id: ID,
      kind: "SEARCH",
      workspaceId: "ws1",
    });
    expect(
      await ReportShares.revoke({
        projectId: "p1",
        shareId: ID,
        userId: "u1",
        now: NOW,
      }),
    ).toBe(true);
    expect(mocks.findFirst.mock.calls[0]?.[0].where).toMatchObject({
      id: ID,
      projectId: "p1",
      revokedAt: null,
    });
    expect(mocks.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: ID, projectId: "p1", revokedAt: null },
      data: { revokedAt: NOW },
    });
    expect(mocks.record.mock.calls[0]?.[0].action).toBe("report_share.revoked");
  });

  it("returns false for a share of another project or an already revoked one", async () => {
    mocks.findFirst.mockResolvedValue(null);
    expect(
      await ReportShares.revoke({ projectId: "other", shareId: ID, userId: "u1" }),
    ).toBe(false);
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("returns false when the update lost the race", async () => {
    mocks.findFirst.mockResolvedValue({
      id: ID,
      kind: "SEARCH",
      workspaceId: "ws1",
    });
    mocks.updateMany.mockResolvedValue({ count: 0 });
    expect(
      await ReportShares.revoke({ projectId: "p1", shareId: ID, userId: "u1" }),
    ).toBe(false);
    expect(mocks.record).not.toHaveBeenCalled();
  });
});

describe("ReportShares.resolve", () => {
  const secret = generateShareSecret();
  const token = `${ID}.${secret}`;

  it("resolves a valid token and touches the counter", async () => {
    mocks.findUnique.mockResolvedValue(shareRow(secret));
    const result = await ReportShares.resolve(token, NOW);
    expect(result.ok).toBe(true);
    expect(mocks.findUnique.mock.calls[0]?.[0]).toEqual({ where: { id: ID } });
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany.mock.calls[0]?.[0]).toMatchObject({
      data: { viewCount: { increment: 1 }, lastViewedAt: NOW },
    });
  });

  it("throttles the view counter to once per minute through the where clause", async () => {
    mocks.findUnique.mockResolvedValue(shareRow(secret));
    await ReportShares.resolve(token, NOW);
    const where = mocks.updateMany.mock.calls[0]?.[0].where;
    expect(where.OR).toEqual([
      { lastViewedAt: null },
      { lastViewedAt: { lt: new Date(NOW.getTime() - 60_000) } },
    ]);
  });

  it("returns the identical failure for every reason", async () => {
    const failures: unknown[] = [];
    // yanlış gizli parça
    mocks.findUnique.mockResolvedValue(shareRow(secret));
    failures.push(await ReportShares.resolve(`${ID}.${generateShareSecret()}`, NOW));
    // satır yok
    mocks.findUnique.mockResolvedValue(null);
    failures.push(await ReportShares.resolve(token, NOW));
    // iptal
    mocks.findUnique.mockResolvedValue(
      shareRow(secret, { revokedAt: new Date(NOW.getTime() - 1000) }),
    );
    failures.push(await ReportShares.resolve(token, NOW));
    // süresi dolmuş
    mocks.findUnique.mockResolvedValue(
      shareRow(secret, { expiresAt: new Date(NOW.getTime() - 1) }),
    );
    failures.push(await ReportShares.resolve(token, NOW));
    // bozuk tür
    mocks.findUnique.mockResolvedValue(shareRow(secret, { kind: "OTHER" }));
    failures.push(await ReportShares.resolve(token, NOW));
    // bozuk belirteç
    failures.push(await ReportShares.resolve("nonsense", NOW));
    for (const failure of failures) expect(failure).toEqual({ ok: false });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("does not look up the row for a malformed token", async () => {
    await ReportShares.resolve("a.b", NOW);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("still resolves when the counter write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.findUnique.mockResolvedValue(shareRow(secret));
    mocks.updateMany.mockRejectedValue(new Error("db"));
    expect((await ReportShares.resolve(token, NOW)).ok).toBe(true);
  });
});

describe("deletion helpers", () => {
  it("deleteForReports chunks by 500 and is not flag-gated", async () => {
    vi.stubEnv("GSC_AGENCY", "false");
    vi.stubEnv("GA_AGENCY", "false");
    const ids = Array.from({ length: 1201 }, (_, index) => `r${index}`);
    mocks.deleteMany.mockResolvedValue({ count: 2 });
    expect(await ReportShares.deleteForReports("WEBSITE", ids)).toBe(6);
    expect(mocks.deleteMany).toHaveBeenCalledTimes(3);
    const sizes = mocks.deleteMany.mock.calls.map(
      (call) => call[0].where.reportId.in.length,
    );
    expect(sizes).toEqual([500, 500, 201]);
    expect(mocks.deleteMany.mock.calls[0]?.[0].where.kind).toBe("WEBSITE");
    vi.unstubAllEnvs();
  });

  it("deleteForReports does nothing for an empty list", async () => {
    expect(await ReportShares.deleteForReports("SEARCH", [])).toBe(0);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("deleteForProject deletes by kind and project even with the flags off", async () => {
    vi.stubEnv("GSC_AGENCY", "false");
    vi.stubEnv("GA_AGENCY", "false");
    mocks.deleteMany.mockResolvedValue({ count: 4 });
    expect(await ReportShares.deleteForProject("SEARCH", "p1")).toBe(4);
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { kind: "SEARCH", projectId: "p1" },
    });
    vi.unstubAllEnvs();
  });
});
