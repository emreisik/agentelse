import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorkspaceManager: vi.fn(),
  projectFindUnique: vi.fn(),
  loadSettings: vi.fn(),
  loadBio: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { project: { findUnique: mocks.projectFindUnique } },
}));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
  isWorkspaceManager: mocks.isWorkspaceManager,
}));
vi.mock("@/server/tracked-links/settings", () => ({
  loadLinkTrackingSettings: mocks.loadSettings,
}));
vi.mock("@/server/tracked-links/bio", () => ({
  loadInstagramBioLink: mocks.loadBio,
}));
vi.mock("@/server/actions/link-tracking-actions", () => ({
  updateLinkTrackingAction: vi.fn(),
  saveInstagramBioLinkAction: vi.fn(),
}));

const { LinkTrackingCard } = await import("./link-tracking-card");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ userId: "u1", email: null });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "ws",
    projectId: "p1",
    defaultBrandId: "b1",
  });
  mocks.isWorkspaceManager.mockResolvedValue(true);
  mocks.projectFindUnique.mockResolvedValue({ domain: "acme.test" });
  mocks.loadSettings.mockResolvedValue({ utmEnabled: true, stored: false });
  mocks.loadBio.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("LinkTrackingCard", () => {
  it("resolves to null without any query when GA_UTM is unset", async () => {
    vi.stubEnv("GA_UTM", "");

    await expect(LinkTrackingCard({ projectId: "p1" })).resolves.toBeNull();

    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.requireProjectAccess).not.toHaveBeenCalled();
    expect(mocks.projectFindUnique).not.toHaveBeenCalled();
    expect(mocks.loadSettings).not.toHaveBeenCalled();
    expect(mocks.loadBio).not.toHaveBeenCalled();
    expect(mocks.isWorkspaceManager).not.toHaveBeenCalled();
  });

  it("renders and loads everything in one pass when GA_UTM is on", async () => {
    vi.stubEnv("GA_UTM", "true");

    const element = await LinkTrackingCard({ projectId: "p1" });

    expect(element).not.toBeNull();
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith("u1", "p1");
    expect(mocks.loadSettings).toHaveBeenCalledWith("p1");
    expect(mocks.loadBio).toHaveBeenCalledWith("p1");
    expect(mocks.isWorkspaceManager).toHaveBeenCalledWith("u1", "ws");
    expect(mocks.projectFindUnique).toHaveBeenCalledTimes(1);
  });
});
