import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: yalnız workspace OWNER/ADMIN; bayrak kapalıyken
// iş yok; yabancı proje reddedilir; PULSE ve bulunamayan rapor paylaşılmaz;
// onay kutusu ve gün sayısı doğrulanır; hız sınırı; dönen adres /r/<belirteç>
// biçimindedir ve marka oluşturma anındaki ayardan kopyalanır; iptal projeye
// kapsamlıdır; marka kaydı workspace düzeyindedir ve doğrulanır.

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
  isWorkspaceManager: vi.fn(),
  isRateLimited: vi.fn(),
  readSeoReportView: vi.fn(),
  brandingGet: vi.fn(),
  brandingSave: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
  requireWorkspaceMembership: mocks.requireWorkspaceMembership,
  isWorkspaceManager: mocks.isWorkspaceManager,
}));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: mocks.isRateLimited }));
vi.mock("@/lib/app-url", () => ({
  appUrl: (path: string) => new URL(path, "https://app.example.com"),
}));
vi.mock("@/server/seo/reports/store", () => ({
  readSeoReportView: mocks.readSeoReportView,
}));
vi.mock("@/server/report-share/branding", () => ({
  ReportBrandings: { get: mocks.brandingGet, save: mocks.brandingSave },
}));
vi.mock("@/server/report-share/store", () => ({
  ReportShares: { create: mocks.create, revoke: mocks.revoke },
}));

const {
  saveReportBrandingAction,
  createReportShareAction,
  revokeReportShareAction,
} = await import("./report-share-actions");
const { AgentelseError } = await import("@/server/security/errors");

const BRANDING = {
  displayName: "Acme",
  accent: "blue",
  footer: null,
  logoAssetId: null,
};
const EXPIRES = new Date("2026-11-06T12:00:00.000Z");

function form(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set("projectId", "proj_1");
  data.set("reportId", "rep_1");
  data.set("days", "30");
  data.set("confirm", "on");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function brandingForm(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set("displayName", "Acme Agency");
  data.set("accent", "green");
  data.set("footer", "Prepared by Acme.");
  data.set("logoAssetId", "");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GSC_AGENCY", "true");
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("SEO_REPORTS", "true");
  vi.stubEnv("NODE_ENV", "test");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireUser.mockResolvedValue({ userId: "user_1" });
  mocks.requireProjectAccess.mockResolvedValue({ workspaceId: "ws_1" });
  mocks.requireWorkspaceMembership.mockResolvedValue({ workspaceId: "ws_1" });
  mocks.isWorkspaceManager.mockResolvedValue(true);
  mocks.isRateLimited.mockReturnValue(false);
  mocks.readSeoReportView.mockResolvedValue({ id: "rep_1", kind: "WEEKLY" });
  mocks.brandingGet.mockResolvedValue(BRANDING);
  mocks.brandingSave.mockResolvedValue({ ok: true });
  mocks.create.mockResolvedValue({
    ok: true,
    id: "share_1",
    token: "tok_abc.secret",
    expiresAt: EXPIRES,
  });
  mocks.revoke.mockResolvedValue(true);
});

describe("createReportShareAction", () => {
  it("creates a SEARCH share and returns the absolute /r/<token> url", async () => {
    const result = await createReportShareAction(form());
    expect(result).toEqual({
      ok: true,
      url: "https://app.example.com/r/tok_abc.secret",
      expiresAt: EXPIRES.toISOString(),
    });
    expect(mocks.create).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      projectId: "proj_1",
      kind: "SEARCH",
      reportId: "rep_1",
      days: 30,
      userId: "user_1",
      branding: BRANDING,
    });
    expect(mocks.isRateLimited).toHaveBeenCalledWith(
      "share-create:user_1",
      20,
      3_600_000,
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj_1/arama");
  });

  it("is refused for a non-manager, before anything else", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    const result = await createReportShareAction(form());
    expect(result.ok).toBe(false);
    expect(mocks.readSeoReportView).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("is refused when the flags are off", async () => {
    vi.stubEnv("GSC_AGENCY", "false");
    vi.stubEnv("GA_AGENCY", "false");
    expect((await createReportShareAction(form())).ok).toBe(false);
    vi.stubEnv("GSC_AGENCY", "true");
    vi.stubEnv("SEO_REPORTS", "false");
    expect((await createReportShareAction(form())).ok).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("is refused for a project the user can't access", async () => {
    mocks.requireProjectAccess.mockRejectedValue(
      new AgentelseError("PERMISSION_DENIED", "No access to this project"),
    );
    const result = await createReportShareAction(form({ projectId: "foreign" }));
    expect(result).toEqual({ ok: false, message: "No access to this project" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("returns a generic message for an unexpected failure", async () => {
    mocks.create.mockRejectedValue(new Error("db secret details"));
    const result = await createReportShareAction(form());
    expect(result).toEqual({
      ok: false,
      message: "Something went wrong. Try again.",
    });
  });

  it("requires the explicit confirmation", async () => {
    const data = form();
    data.delete("confirm");
    expect((await createReportShareAction(data)).ok).toBe(false);
    expect((await createReportShareAction(form({ confirm: "true" }))).ok).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("validates the days", async () => {
    for (const days of ["0", "14", "abc", ""]) {
      expect((await createReportShareAction(form({ days }))).ok).toBe(false);
    }
    expect(mocks.create).not.toHaveBeenCalled();
    for (const days of ["7", "90"]) {
      expect((await createReportShareAction(form({ days }))).ok).toBe(true);
    }
  });

  it("rate-limits creation", async () => {
    mocks.isRateLimited.mockReturnValue(true);
    const result = await createReportShareAction(form());
    expect(result.ok).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses PULSE, a report of another project and a missing report", async () => {
    mocks.readSeoReportView.mockResolvedValueOnce({ id: "rep_1", kind: "PULSE" });
    expect((await createReportShareAction(form())).ok).toBe(false);
    mocks.readSeoReportView.mockResolvedValueOnce(null);
    expect((await createReportShareAction(form())).ok).toBe(false);
    expect((await createReportShareAction(form({ reportId: "" }))).ok).toBe(false);
    expect(mocks.readSeoReportView).toHaveBeenCalledWith("proj_1", "rep_1");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("maps the share limit to a fixed message", async () => {
    mocks.create.mockResolvedValue({ ok: false, code: "LIMIT" });
    const result = await createReportShareAction(form());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("maximum number");
  });
});

describe("revokeReportShareAction", () => {
  it("revokes within the project and refreshes the page", async () => {
    const result = await revokeReportShareAction(form({ shareId: "share_1" }));
    expect(result).toEqual({ ok: true });
    expect(mocks.revoke).toHaveBeenCalledWith({
      projectId: "proj_1",
      shareId: "share_1",
      userId: "user_1",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj_1/arama");
  });

  it("is manager-only", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    expect((await revokeReportShareAction(form({ shareId: "s" }))).ok).toBe(false);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("reports a share that is gone, already revoked or in another project", async () => {
    mocks.revoke.mockResolvedValue(false);
    expect((await revokeReportShareAction(form({ shareId: "s" }))).ok).toBe(false);
    expect((await revokeReportShareAction(form())).ok).toBe(false);
  });

  it("does nothing when the flags are off", async () => {
    vi.stubEnv("GSC_AGENCY", "false");
    vi.stubEnv("GA_AGENCY", "false");
    expect((await revokeReportShareAction(form({ shareId: "s" }))).ok).toBe(false);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
});

describe("saveReportBrandingAction", () => {
  it("saves validated branding for the workspace", async () => {
    expect(await saveReportBrandingAction(brandingForm())).toEqual({ ok: true });
    expect(mocks.brandingSave).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      userId: "user_1",
      value: {
        displayName: "Acme Agency",
        accent: "green",
        footer: "Prepared by Acme.",
        logoAssetId: null,
      },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/search");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/websites");
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/projects/[projectId]/arama/client/[reportId]",
      "page",
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/projects/[projectId]/site/client/[commandId]",
      "page",
    );
  });

  it("is manager-only and flag-gated", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    expect((await saveReportBrandingAction(brandingForm())).ok).toBe(false);
    mocks.isWorkspaceManager.mockResolvedValue(true);
    vi.stubEnv("GSC_AGENCY", "false");
    vi.stubEnv("GA_AGENCY", "false");
    expect((await saveReportBrandingAction(brandingForm())).ok).toBe(false);
    expect(mocks.brandingSave).not.toHaveBeenCalled();
  });

  it("rejects invalid input without saving", async () => {
    expect((await saveReportBrandingAction(brandingForm({ accent: "pink" }))).ok).toBe(false);
    expect((await saveReportBrandingAction(brandingForm({ displayName: "" }))).ok).toBe(false);
    expect(mocks.brandingSave).not.toHaveBeenCalled();
  });

  it("passes the store's refusal through (e.g. an ineligible logo)", async () => {
    mocks.brandingSave.mockResolvedValue({
      ok: false,
      message: "Choose a logo from the list.",
    });
    expect(
      await saveReportBrandingAction(brandingForm({ logoAssetId: "other-ws-logo" })),
    ).toEqual({ ok: false, message: "Choose a logo from the list." });
  });
});
