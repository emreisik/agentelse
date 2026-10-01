import { beforeEach, describe, expect, it, vi } from "vitest";

// A project that starts working from the chat never ran setup, so nothing has
// created its browser profiles yet, hence the lazy, idempotent bundle.

const count = vi.fn();
const createMany = vi.fn();
const findUniqueOrThrow = vi.fn();
const findUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    browserProfile: { count, createMany },
    project: { findUniqueOrThrow, findUnique },
  },
}));

const {
  ensureStandardBrowserProfiles,
  ensureStandardBrowserProfilesForProject,
} = await import("./browser-profiles");

const scope = { workspaceId: "ws-1", projectId: "proj-1", brandId: "brand-1" };

beforeEach(() => {
  vi.clearAllMocks();
  count.mockResolvedValue(0);
  createMany.mockResolvedValue({ count: 6 });
  findUniqueOrThrow.mockResolvedValue({ slug: "acme" });
});

describe("ensureStandardBrowserProfiles", () => {
  it("creates the six standard profiles without binding an external agent", async () => {
    await expect(ensureStandardBrowserProfiles(scope)).resolves.toBe(true);

    const { data, skipDuplicates } = createMany.mock.calls[0]![0] as {
      data: Record<string, unknown>[];
      skipDuplicates: boolean;
    };
    expect(data.map((row) => row.purpose)).toEqual([
      "PUBLIC_RESEARCH",
      "INSTAGRAM",
      "TIKTOK",
      "META_ADS",
      "GOOGLE_ADS",
      "LINKEDIN",
    ]);
    expect(data[0]).toMatchObject({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      slug: "acme-public_research",
      status: "READY",
    });
    expect(data.every((row) => !("externalProfileId" in row))).toBe(true);
    // Two callers can both see zero profiles; the loser must not throw.
    expect(skipDuplicates).toBe(true);
  });

  it("does nothing when the project already has profiles", async () => {
    count.mockResolvedValue(3);

    await expect(ensureStandardBrowserProfiles(scope)).resolves.toBe(false);

    expect(createMany).not.toHaveBeenCalled();
  });

  it("reports false when a concurrent caller created them first", async () => {
    createMany.mockResolvedValue({ count: 0 });

    await expect(ensureStandardBrowserProfiles(scope)).resolves.toBe(false);
  });
});

describe("ensureStandardBrowserProfilesForProject", () => {
  it("resolves the workspace and default brand from the project id", async () => {
    findUnique.mockResolvedValue({
      workspaceId: "ws-1",
      brands: [{ id: "brand-1" }],
    });

    await expect(
      ensureStandardBrowserProfilesForProject("proj-1"),
    ).resolves.toBe(true);

    expect(count).toHaveBeenCalledWith({ where: { projectId: "proj-1" } });
    expect(createMany).toHaveBeenCalled();
  });

  it.each([
    ["the project does not exist", null],
    ["the project has no default brand", { workspaceId: "ws-1", brands: [] }],
  ])("returns false when %s", async (_label, project) => {
    findUnique.mockResolvedValue(project);

    await expect(
      ensureStandardBrowserProfilesForProject("proj-1"),
    ).resolves.toBe(false);
    expect(createMany).not.toHaveBeenCalled();
  });
});
