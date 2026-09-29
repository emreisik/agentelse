import sharp from "sharp";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const isRateLimited = vi.fn().mockReturnValue(false);
vi.mock("@/lib/rate-limit", () => ({ isRateLimited }));
const auditRecord = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: auditRecord },
}));

const scanWebsite = vi.fn();
vi.mock("@/server/brand/site-scan/scan", () => ({ scanWebsite }));

const putAsset = vi.fn().mockResolvedValue({ storageKey: "r2://logo.png", filename: "logo.png" });
vi.mock("@/server/storage/asset-storage", () => ({ putAsset }));

const assetCreate = vi.fn().mockResolvedValue({ id: "asset-1" });
const dossierUpsert = vi.fn().mockResolvedValue(undefined);
const identityUpsert = vi.fn().mockResolvedValue(undefined);
const projectUpdate = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    asset: { create: assetCreate },
    brandDossier: { upsert: dossierUpsert },
    brandVisualIdentity: { upsert: identityUpsert },
    project: { update: projectUpdate },
  },
}));

const { applyBrandScanAction, scanBrandWebsiteAction } = await import("./brand-scan-actions");
const { UnsafeUrlError } = await import("@/server/security/safe-fetch");

let pngDataUrl: string;
let lightLogoDataUrl: string;
beforeAll(async () => {
  // A teal (dark / mid-tone) logo -> belongs in the DARK slot.
  const png = await sharp({
    create: { width: 80, height: 40, channels: 4, background: { r: 13, g: 148, b: 136, alpha: 1 } },
  })
    .png()
    .toBuffer();
  pngDataUrl = `data:image/png;base64,${png.toString("base64")}`;

  // A white mark on a transparent background -> belongs in the LIGHT slot.
  const mark = await sharp({
    create: { width: 60, height: 20, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const light = await sharp({
    create: { width: 100, height: 50, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: mark, gravity: "centre" }])
    .png()
    .toBuffer();
  lightLogoDataUrl = `data:image/png;base64,${light.toString("base64")}`;
});

const payload = (overrides: Record<string, unknown> = {}) => ({
  url: "https://www.webhealth.com.tr/hizmetler",
  logoDataUrl: pngDataUrl,
  colors: {
    primary: [{ hex: "#0b1f3a", name: "Navy" }],
    secondary: [{ hex: "#0d9488" }],
    accent: [{ hex: "#2dd4bf" }],
  },
  fonts: ["Inter", "Playfair Display"],
  style: {
    photographyStyle: "PHOTOGRAPHIC",
    styleRefinement: "Soft daylight.",
    moodTags: ["calm"],
    compositionNotes: "Negative space.",
    backgroundTone: "DARK",
    alwaysAvoid: ["stock smiles"],
  },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ userId: "u1", email: null });
  requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: "p1",
    defaultBrandId: "brand-1",
  });
  isRateLimited.mockReturnValue(false);
  assetCreate.mockResolvedValue({ id: "asset-1" });
});

describe("scanBrandWebsiteAction", () => {
  it("returns the scan result without writing anything", async () => {
    scanWebsite.mockResolvedValue({ url: "https://webhealth.com.tr/", logo: null, warnings: [] });
    const result = await scanBrandWebsiteAction("p1", "webhealth.com.tr");
    expect(result.ok).toBe(true);
    expect(scanWebsite).toHaveBeenCalledWith("webhealth.com.tr", {
      workspaceId: "ws-1",
      projectId: "p1",
      brandId: "brand-1",
    });
    expect(dossierUpsert).not.toHaveBeenCalled();
    expect(identityUpsert).not.toHaveBeenCalled();
  });

  it("checks project access first and is rate limited", async () => {
    requireProjectAccess.mockRejectedValue(new Error("Project not found"));
    expect((await scanBrandWebsiteAction("p1", "x.com")).ok).toBe(false);
    expect(scanWebsite).not.toHaveBeenCalled();

    requireProjectAccess.mockResolvedValue({ workspaceId: "w", projectId: "p1", defaultBrandId: "b" });
    isRateLimited.mockReturnValue(true);
    const limited = await scanBrandWebsiteAction("p1", "x.com");
    expect(limited).toMatchObject({ ok: false, message: expect.stringContaining("Too many") });
    expect(scanWebsite).not.toHaveBeenCalled();
  });

  it("turns an unsafe address into a plain message", async () => {
    scanWebsite.mockRejectedValue(new UnsafeUrlError("That address is not publicly reachable"));
    expect(await scanBrandWebsiteAction("p1", "http://127.0.0.1")).toEqual({
      ok: false,
      message: "That address is not publicly reachable",
    });
  });
});

describe("applyBrandScanAction", () => {
  it("saves logo, fonts, identity and the site address", async () => {
    const result = await applyBrandScanAction("p1", payload());

    expect(result).toEqual({
      ok: true,
      logoSaved: true,
      logoSlot: "dark",
      domain: "webhealth.com.tr",
    });
    // The logo is re-encoded server-side, never stored as received.
    expect(putAsset).toHaveBeenCalledWith(expect.any(Buffer), "png", "image/png");
    expect(assetCreate.mock.calls[0]![0].data).toMatchObject({
      type: "LOGO",
      brandId: "brand-1",
      mimeType: "image/png",
    });
    // A teal logo is a dark / mid-tone mark: it goes to the dark-logo slot
    // and the light-logo slot is left alone.
    expect(dossierUpsert.mock.calls[0]![0].update).toEqual({
      approvedFonts: ["Inter", "Playfair Display"],
      darkLogoAssetId: "asset-1",
    });
    const identity = identityUpsert.mock.calls[0]![0];
    expect(identity.update).toMatchObject({
      primaryColors: [{ hex: "#0b1f3a", name: "Navy" }],
      photographyStyle: "PHOTOGRAPHIC",
      alwaysAvoid: ["stock smiles"],
    });
    // Template / layout columns are not part of the update.
    expect(Object.keys(identity.update)).not.toContain("logoPosition");
    expect(projectUpdate).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { domain: "webhealth.com.tr" },
    });
  });

  it("stores a light-coloured logo in the light slot (decided server-side)", async () => {
    const result = await applyBrandScanAction("p1", payload({ logoDataUrl: lightLogoDataUrl }));
    expect(result).toMatchObject({ ok: true, logoSaved: true, logoSlot: "light" });
    expect(dossierUpsert.mock.calls[0]![0].update).toEqual({
      approvedFonts: ["Inter", "Playfair Display"],
      logoAssetId: "asset-1",
    });
    expect(dossierUpsert.mock.calls[0]![0].create).toMatchObject({ logoAssetId: "asset-1" });
  });

  it("saves the reviewed layouts with the identity, and leaves them alone when none are sent", async () => {
    const { buildPresetLayouts } = await import("@/lib/layout-templates");
    const { DEFAULT_KIT_TEMPLATE } = await import("@/lib/brand-kit");
    const layouts = buildPresetLayouts(DEFAULT_KIT_TEMPLATE);

    await applyBrandScanAction("p1", payload({ layouts }));
    const withLayouts = identityUpsert.mock.calls[0]![0];
    expect(withLayouts.update.layoutTemplates.defaultId).toBe("classic");
    expect(withLayouts.create.layoutTemplates.items).toHaveLength(layouts.items.length);

    identityUpsert.mockClear();
    await applyBrandScanAction("p1", payload());
    expect(Object.keys(identityUpsert.mock.calls[0]![0].update)).not.toContain("layoutTemplates");

    identityUpsert.mockClear();
    const invalid = await applyBrandScanAction(
      "p1",
      payload({ layouts: { ...layouts, defaultId: "missing" } }),
    );
    expect(invalid.ok).toBe(false);
    expect(identityUpsert).not.toHaveBeenCalled();
  });

  it("keeps the current logo when none is sent", async () => {
    const result = await applyBrandScanAction("p1", payload({ logoDataUrl: null }));
    expect(result).toMatchObject({ ok: true, logoSaved: false, logoSlot: null });
    expect(putAsset).not.toHaveBeenCalled();
    expect(dossierUpsert.mock.calls[0]![0].update).toEqual({
      approvedFonts: ["Inter", "Playfair Display"],
    });
  });

  it.each([
    ["an invented hex", { colors: { primary: [{ hex: "red" }], secondary: [], accent: [] } }],
    ["too many colours", { colors: { primary: Array(5).fill({ hex: "#111111" }), secondary: [], accent: [] } }],
    ["an unknown style enum", { style: { ...payload().style, photographyStyle: "WATERCOLOR" } }],
    ["oversized text", { style: { ...payload().style, styleRefinement: "x".repeat(601) } }],
  ])("rejects %s and writes nothing", async (_label, overrides) => {
    const result = await applyBrandScanAction("p1", payload(overrides));
    expect(result.ok).toBe(false);
    expect(dossierUpsert).not.toHaveBeenCalled();
    expect(identityUpsert).not.toHaveBeenCalled();
    expect(assetCreate).not.toHaveBeenCalled();
  });

  it("rejects a logo that is not a real PNG data URL", async () => {
    for (const bad of [
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "data:image/png;base64,bm90IGFuIGltYWdl", // valid base64, not an image
      "https://evil.example/logo.png",
    ]) {
      const result = await applyBrandScanAction("p1", payload({ logoDataUrl: bad }));
      expect(result.ok).toBe(false);
    }
    expect(putAsset).not.toHaveBeenCalled();
    expect(dossierUpsert).not.toHaveBeenCalled();
  });

  it("does not touch the project's domain when the URL is not a real domain", async () => {
    const result = await applyBrandScanAction("p1", payload({ url: "http://localhost" }));
    expect(result).toMatchObject({ ok: true, domain: null });
    expect(projectUpdate).not.toHaveBeenCalled();
  });

  it("requires project access", async () => {
    requireProjectAccess.mockRejectedValue(new Error("Project not found"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await applyBrandScanAction("p1", payload())).ok).toBe(false);
    expect(dossierUpsert).not.toHaveBeenCalled();
  });
});
