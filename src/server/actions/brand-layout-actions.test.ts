import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const auditRecord = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: auditRecord },
}));
const identityUpsert = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/prisma", () => ({
  prisma: { brandVisualIdentity: { upsert: identityUpsert } },
}));

const { updateLayoutTemplatesAction } = await import("./brand-layout-actions");
const { buildPresetLayouts } = await import("@/lib/layout-templates");
const { DEFAULT_KIT_TEMPLATE } = await import("@/lib/brand-kit");

const layouts = () => buildPresetLayouts(DEFAULT_KIT_TEMPLATE);

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ userId: "u1", email: null });
  requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: "p1",
    defaultBrandId: "brand-1",
  });
});

describe("updateLayoutTemplatesAction", () => {
  it("saves valid layouts for the caller's own brand, and audits it", async () => {
    const result = await updateLayoutTemplatesAction("p1", layouts());

    expect(result).toEqual({ ok: true });
    const call = identityUpsert.mock.calls[0]![0];
    // The brand comes from project access, never from the payload.
    expect(call.where).toEqual({ brandId: "brand-1" });
    expect(call.update.layoutTemplates.defaultId).toBe("classic");
    expect(call.create).toMatchObject({
      workspaceId: "ws-1",
      projectId: "p1",
      brandId: "brand-1",
    });
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: "brand_layouts.updated" }),
    );
  });

  it("rejects out-of-range geometry, unknown ids and junk, writing nothing", async () => {
    const base = layouts();
    const bad = [
      { ...base, items: [{ ...base.items[0], logo: { ...base.items[0]!.logo, sizePercent: 90 } }] },
      { ...base, defaultId: "missing" },
      { ...base, items: [base.items[0], base.items[0]] },
      { version: 2, defaultId: "x", items: [] },
      "layouts",
      null,
    ];
    for (const payload of bad) {
      const result = await updateLayoutTemplatesAction("p1", payload);
      expect(result.ok).toBe(false);
    }
    expect(identityUpsert).not.toHaveBeenCalled();
  });

  it("requires access to the project first", async () => {
    requireProjectAccess.mockRejectedValue(new Error("Project not found"));
    const result = await updateLayoutTemplatesAction("p1", layouts());
    expect(result).toMatchObject({ ok: false, message: "Project not found" });
    expect(identityUpsert).not.toHaveBeenCalled();
  });
});
