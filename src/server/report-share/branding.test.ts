import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: satır yoksa varsayılan Workspace adıyla gelir;
// kayıt logoyu aynı workspace'in LOGO türünde png/jpeg/webp varlığı olarak
// doğrular (SVG yok) ve denetim yazar; logo seçenekleri en çok 12 ve aynı
// süzgeçle gelir.

const mocks = vi.hoisted(() => ({
  brandingFindUnique: vi.fn(),
  brandingUpsert: vi.fn(),
  workspaceFindUnique: vi.fn(),
  assetFindFirst: vi.fn(),
  assetFindMany: vi.fn(),
  record: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    reportBranding: {
      findUnique: mocks.brandingFindUnique,
      upsert: mocks.brandingUpsert,
    },
    workspace: { findUnique: mocks.workspaceFindUnique },
    asset: {
      findFirst: mocks.assetFindFirst,
      findMany: mocks.assetFindMany,
    },
  },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.record },
}));

import { ReportBrandings } from "./branding";

const VALUE = {
  displayName: "Acme",
  accent: "green" as const,
  footer: "Hi",
  logoAssetId: "logo1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.brandingUpsert.mockResolvedValue({ id: "b1" });
  mocks.record.mockResolvedValue({});
});

describe("ReportBrandings.get", () => {
  it("returns the stored branding", async () => {
    mocks.brandingFindUnique.mockResolvedValue({
      displayName: "Acme",
      accent: "violet",
      footer: null,
      logoAssetId: "logo1",
    });
    expect(await ReportBrandings.get("ws1")).toEqual({
      displayName: "Acme",
      accent: "violet",
      footer: null,
      logoAssetId: "logo1",
    });
    expect(mocks.workspaceFindUnique).not.toHaveBeenCalled();
  });

  it("defaults to the workspace name when there is no row", async () => {
    mocks.brandingFindUnique.mockResolvedValue(null);
    mocks.workspaceFindUnique.mockResolvedValue({ name: "My Agency" });
    expect(await ReportBrandings.get("ws1")).toEqual({
      displayName: "My Agency",
      accent: "slate",
      footer: null,
      logoAssetId: null,
    });
  });
});

describe("ReportBrandings.save", () => {
  it("accepts only a LOGO asset of the same workspace with a safe mime type", async () => {
    mocks.assetFindFirst.mockResolvedValue({ id: "logo1" });
    expect(
      await ReportBrandings.save({ workspaceId: "ws1", userId: "u1", value: VALUE }),
    ).toEqual({ ok: true });
    const where = mocks.assetFindFirst.mock.calls[0]?.[0].where;
    expect(where).toMatchObject({ id: "logo1", workspaceId: "ws1", type: "LOGO" });
    expect(where.mimeType.in).toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(where.mimeType.in).not.toContain("image/svg+xml");
    expect(mocks.brandingUpsert.mock.calls[0]?.[0].where).toEqual({
      workspaceId: "ws1",
    });
    const audit = mocks.record.mock.calls[0]?.[0];
    expect(audit).toMatchObject({
      action: "report_branding.saved",
      entityType: "ReportBranding",
      entityId: "b1",
      workspaceId: "ws1",
    });
  });

  it("refuses a logo that is not eligible and writes nothing", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);
    const result = await ReportBrandings.save({
      workspaceId: "ws1",
      userId: "u1",
      value: VALUE,
    });
    expect(result.ok).toBe(false);
    expect(mocks.brandingUpsert).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("skips the asset check without a logo", async () => {
    await ReportBrandings.save({
      workspaceId: "ws1",
      userId: "u1",
      value: { ...VALUE, logoAssetId: null },
    });
    expect(mocks.assetFindFirst).not.toHaveBeenCalled();
    expect(mocks.brandingUpsert).toHaveBeenCalledTimes(1);
  });
});

describe("ReportBrandings.logoOptions", () => {
  it("lists at most 12 newest eligible logos of the workspace", async () => {
    mocks.assetFindMany.mockResolvedValue([{ id: "a", filename: "a.png" }]);
    expect(await ReportBrandings.logoOptions("ws1")).toEqual([
      { id: "a", filename: "a.png" },
    ]);
    const args = mocks.assetFindMany.mock.calls[0]?.[0];
    expect(args.take).toBe(12);
    expect(args.where).toMatchObject({ workspaceId: "ws1", type: "LOGO" });
    expect(args.where.mimeType.in).not.toContain("image/svg+xml");
  });
});
