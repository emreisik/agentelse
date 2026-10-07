import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı ("Website changes" bölümü): bayrak kapalıyken null ve
// oturum, erişim ya da veri okuması YOK; açıkken bölüm kimliği
// "website-changes" olur; erişim yoksa ya da okuma boşsa null.

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  loadSeoApplyView: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/seo-apply-actions", () => ({
  decideSeoChangeAction: vi.fn(),
  proposeMakeLiveAction: vi.fn(),
  saveApplySettingsAction: vi.fn(),
  undoSeoChangeAction: vi.fn(),
  indexNowEnableAction: vi.fn(),
  indexNowVerifyAction: vi.fn(),
  indexNowDisableAction: vi.fn(),
}));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("@/server/seo/apply/read", () => ({
  loadSeoApplyView: mocks.loadSeoApplyView,
}));

const { SearchApplySection } = await import("./changes-section");

const NAMES = ["SEO_APPLY", "SEO_HEALTH"] as const;
const ORIGINAL: Record<string, string | undefined> = Object.fromEntries(
  NAMES.map((name) => [name, process.env[name]]),
);

const VIEW = {
  connection: {
    connected: false,
    siteId: null,
    origin: null,
    host: null,
    accountLabel: null,
    health: "UNKNOWN",
    healthLabel: "Not checked yet",
    healthReason: null,
    seoPlugin: "NONE",
    descriptionWritable: false,
    capabilities: null,
    lastCheckedAt: null,
    canManage: true,
    adminWarning: false,
    canRebind: false,
  },
  canManage: true,
  dailyLimit: 10,
  usedToday: 0,
  changes: [],
  indexNow: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SEO_APPLY = "true";
  process.env.SEO_HEALTH = "true";
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.requireProjectAccess.mockResolvedValue({});
  mocks.loadSeoApplyView.mockResolvedValue(VIEW);
});

afterEach(() => {
  for (const name of NAMES) {
    if (ORIGINAL[name] === undefined) delete process.env[name];
    else process.env[name] = ORIGINAL[name];
  }
});

describe("SearchApplySection", () => {
  it("returns null with no reads at all when the flag is off", async () => {
    process.env.SEO_APPLY = "";
    expect(await SearchApplySection({ projectId: "p1" })).toBeNull();
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.requireProjectAccess).not.toHaveBeenCalled();
    expect(mocks.loadSeoApplyView).not.toHaveBeenCalled();
  });

  it("returns null without project access and does not read the view", async () => {
    mocks.requireProjectAccess.mockRejectedValue(new Error("denied"));
    expect(await SearchApplySection({ projectId: "p1" })).toBeNull();
    expect(mocks.loadSeoApplyView).not.toHaveBeenCalled();
  });

  it("returns null when the view cannot be read", async () => {
    mocks.loadSeoApplyView.mockRejectedValue(new Error("db"));
    expect(await SearchApplySection({ projectId: "p1" })).toBeNull();
    mocks.loadSeoApplyView.mockResolvedValue(null);
    expect(await SearchApplySection({ projectId: "p1" })).toBeNull();
  });

  it("renders the section with its anchor id", async () => {
    const element = await SearchApplySection({ projectId: "p1" });
    expect(element).not.toBeNull();
    expect(element?.type).toBe("section");
    expect(element?.props.id).toBe("website-changes");
    expect(mocks.loadSeoApplyView).toHaveBeenCalledWith({
      projectId: "p1",
      userId: "u1",
    });
  });
});
