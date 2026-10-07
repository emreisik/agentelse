import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorkspaceManager: vi.fn(),
  revalidatePath: vi.fn(),
  audit: vi.fn(),
  saveSettings: vi.fn(),
  saveBio: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
  isWorkspaceManager: mocks.isWorkspaceManager,
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.audit },
}));
vi.mock("@/server/tracked-links/settings", () => ({
  saveLinkTrackingSettings: mocks.saveSettings,
}));
vi.mock("@/server/tracked-links/bio", () => ({
  saveInstagramBioLink: mocks.saveBio,
}));

const { saveInstagramBioLinkAction, updateLinkTrackingAction } = await import(
  "./link-tracking-actions"
);
const { LINK_TRACKING_COPY } = await import("@/lib/tracked-links/copy");

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ userId: "u1", email: null });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "ws",
    projectId: "p1",
    defaultBrandId: "b1",
  });
  mocks.isWorkspaceManager.mockResolvedValue(true);
  mocks.audit.mockResolvedValue(undefined);
  mocks.saveSettings.mockResolvedValue({ utmEnabled: false, stored: true });
});

describe("updateLinkTrackingAction", () => {
  it("refuses a member who is not a workspace manager and saves nothing", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);

    const result = await updateLinkTrackingAction(
      form({ projectId: "p1", utmEnabled: "on" }),
    );

    expect(result).toEqual({
      ok: false,
      message: LINK_TRACKING_COPY.managersOnly,
    });
    expect(mocks.saveSettings).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("saves the switch for a manager and audits the change", async () => {
    const result = await updateLinkTrackingAction(form({ projectId: "p1" }));

    expect(result).toEqual({ ok: true });
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      workspaceId: "ws",
      projectId: "p1",
      userId: "u1",
      value: { utmEnabled: false },
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "link_tracking.updated",
        entityType: "LinkTrackingSetting",
        entityId: "p1",
        metadata: { utmEnabled: false },
      }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/p1");
  });

  it("turns an unexpected error into a failed result", async () => {
    mocks.saveSettings.mockRejectedValue(new Error("db down"));
    const result = await updateLinkTrackingAction(
      form({ projectId: "p1", utmEnabled: "on" }),
    );
    expect(result).toEqual({ ok: false, message: "db down" });
  });
});

describe("saveInstagramBioLinkAction", () => {
  const reasons = [
    ["off", LINK_TRACKING_COPY.bioOff],
    ["invalid", LINK_TRACKING_COPY.invalidUrl],
    ["no_domain", LINK_TRACKING_COPY.bioNoDomain],
    ["not_own_site", LINK_TRACKING_COPY.notOwnSite],
  ] as const;

  it.each(reasons)("maps the %s failure to its message", async (reason, message) => {
    mocks.saveBio.mockResolvedValue({ ok: false, reason });

    const result = await saveInstagramBioLinkAction(
      form({ projectId: "p1", destinationUrl: "https://acme.test/" }),
    );

    expect(result).toEqual({ ok: false, message });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("lets any project member save and never audits the URL", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    mocks.saveBio.mockResolvedValue({
      ok: true,
      link: {
        url: "https://acme.test/?utm_content=agx_abc123",
        destinationUrl: "https://acme.test/",
        code: "abc123",
        updatedAt: "2026-10-07T00:00:00.000Z",
      },
    });

    const result = await saveInstagramBioLinkAction(
      form({ projectId: "p1", destinationUrl: " https://acme.test/ " }),
    );

    expect(result).toEqual({ ok: true });
    expect(mocks.saveBio).toHaveBeenCalledWith({
      workspaceId: "ws",
      projectId: "p1",
      userId: "u1",
      destinationUrl: "https://acme.test/",
    });
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    const entry = mocks.audit.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(entry.action).toBe("tracked_link.saved");
    expect(entry.metadata).toEqual({ entityType: "instagram_bio" });
    expect(JSON.stringify(entry)).not.toContain("acme.test");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/p1");
  });
});
