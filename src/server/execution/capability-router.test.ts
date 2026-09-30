import { beforeEach, describe, expect, it, vi } from "vitest";

// resolveBrowserProfile is the last place a SOCIAL_ACCOUNT_SETUP task without a
// platform can be caught (the doors ask for it earlier). It applies the same
// rule as they do, with an error that says what is wrong, and never touches a
// browser profile for a platform an account cannot be set up on.

vi.mock("@/server/execution/provider-registry", () => ({
  ProviderRegistry: { all: () => [] },
}));
vi.mock("@/server/observability/provider-health.service", () => ({
  ProviderHealthService: { unhealthyProviderKeys: vi.fn() },
}));
const findByPurposeInProject = vi.fn();
vi.mock("@/server/repositories/browser-profile.repository", () => ({
  BrowserProfileRepository: { findByPurposeInProject },
}));
const ensureStandardBrowserProfilesForProject = vi.fn();
vi.mock("@/server/projects/browser-profiles", () => ({
  ensureStandardBrowserProfilesForProject,
}));

const { CapabilityRouter } = await import("./capability-router");

beforeEach(() => {
  vi.clearAllMocks();
  findByPurposeInProject.mockResolvedValue({ id: "profile-1" });
  ensureStandardBrowserProfilesForProject.mockResolvedValue(false);
});

describe("CapabilityRouter.resolveBrowserProfile: opening a new account", () => {
  const resolve = (payload: unknown) =>
    CapabilityRouter.resolveBrowserProfile(
      "SOCIAL_ACCOUNT_SETUP",
      "proj-1",
      payload,
    );

  it("refuses a payload without a platform, with a code and message that say why", async () => {
    await expect(resolve({ request: "x" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message:
        "SOCIAL_ACCOUNT_SETUP requires a `platform` field in the request payload",
    });
    expect(findByPurposeInProject).not.toHaveBeenCalled();
  });

  it("refuses a missing payload the same way", async () => {
    await expect(resolve(undefined)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("refuses a platform there is no browser profile for, instead of asking the database for one", async () => {
    await expect(resolve({ platform: "FACEBOOK" })).rejects.toThrow(
      "cannot open an account on FACEBOOK; supported platforms: INSTAGRAM, TIKTOK, LINKEDIN",
    );
    expect(findByPurposeInProject).not.toHaveBeenCalled();
  });

  // X is a platform elsewhere, but no code ever creates an X browser profile, so
  // an account could only fail after the client approved it.
  it("refuses X for the same reason: there is no profile for it", async () => {
    await expect(resolve({ platform: "X" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(findByPurposeInProject).not.toHaveBeenCalled();
  });

  it.each(["INSTAGRAM", "TIKTOK", "LINKEDIN"])(
    "looks up the %s profile of this project",
    async (platform) => {
      await expect(resolve({ platform })).resolves.toBe("profile-1");
      expect(findByPurposeInProject).toHaveBeenCalledWith("proj-1", platform);
    },
  );
});

describe("CapabilityRouter.resolveBrowserProfile: other capabilities", () => {
  it("needs no platform for research in the shared public profile", async () => {
    await CapabilityRouter.resolveBrowserProfile(
      "COMPETITOR_RESEARCH",
      "proj-1",
      {},
    );

    expect(findByPurposeInProject).toHaveBeenCalledWith(
      "proj-1",
      "PUBLIC_RESEARCH",
    );
  });

  it("needs no profile at all for a text capability", async () => {
    await expect(
      CapabilityRouter.resolveBrowserProfile("CREATE_COPY", "proj-1", {}),
    ).resolves.toBeUndefined();
    expect(findByPurposeInProject).not.toHaveBeenCalled();
  });
});
