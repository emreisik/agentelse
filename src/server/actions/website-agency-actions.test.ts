import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(async () => ({ userId: "u1" })),
  membership: vi.fn(async () => ({ workspaceId: "ws1" })),
  manager: vi.fn(async () => true),
  enabled: vi.fn(() => true),
  bulk: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireWorkspaceMembership: mocks.membership,
  isWorkspaceManager: mocks.manager,
}));
vi.mock("@/lib/website-analytics/agency/flags", () => ({
  gaAgencyEnabled: mocks.enabled,
}));
vi.mock("@/server/website-analytics/agency/bulk-link", () => ({
  BULK_LINK_MAX: 20,
  bulkLinkGoogleAccount: mocks.bulk,
}));

import { bulkLinkGoogleAccountAction } from "./website-agency-actions";

// Bu dosyanın kanıtladığı (GA-F8, toplu bağlama eylemi): yalnız OWNER/ADMIN,
// bayrak kapalıyken reddeder, 20'den fazla projeyi reddeder, başarıda
// /websites'ı yeniler.

function form(entries: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      data.append(key, item);
    }
  }
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.manager.mockResolvedValue(true);
  mocks.enabled.mockReturnValue(true);
  mocks.bulk.mockResolvedValue({
    ok: true,
    linked: 2,
    rows: [
      { projectId: "a", status: "linked", propertyId: null },
      { projectId: "b", status: "linked", propertyId: null },
      { projectId: "c", status: "skipped", reason: "already_connected" },
      { projectId: "d", status: "skipped", reason: "already_connected" },
      { projectId: "e", status: "skipped", reason: "closed" },
    ],
  });
});

describe("bulkLinkGoogleAccountAction", () => {
  it("refuses a member who is not owner or admin", async () => {
    mocks.manager.mockResolvedValue(false);
    const result = await bulkLinkGoogleAccountAction(
      form({ sourceCredentialId: "s", projectId: ["a"] }),
    );
    expect(result).toEqual({
      ok: false,
      message: "Only workspace owners and admins can change this.",
    });
    expect(mocks.bulk).not.toHaveBeenCalled();
  });

  it("refuses when agency tools are off", async () => {
    mocks.enabled.mockReturnValue(false);
    const result = await bulkLinkGoogleAccountAction(
      form({ sourceCredentialId: "s", projectId: ["a"] }),
    );
    expect(result).toEqual({ ok: false, message: "Agency tools aren't turned on." });
    expect(mocks.bulk).not.toHaveBeenCalled();
  });

  it("refuses more than 20 projects and none at all", async () => {
    const many = Array.from({ length: 21 }, (_, i) => `p${i}`);
    expect(
      await bulkLinkGoogleAccountAction(form({ sourceCredentialId: "s", projectId: many })),
    ).toEqual({ ok: false, message: "Pick up to 20 projects at a time." });
    expect(
      (await bulkLinkGoogleAccountAction(form({ sourceCredentialId: "s" }))).ok,
    ).toBe(false);
    expect(mocks.bulk).not.toHaveBeenCalled();
  });

  it("dedupes the project ids before counting them", async () => {
    const same = Array.from({ length: 25 }, () => "p1");
    await bulkLinkGoogleAccountAction(form({ sourceCredentialId: "s", projectId: same }));
    expect(mocks.bulk.mock.calls[0]?.[0].projectIds).toEqual(["p1"]);
  });

  it("links, summarises the skipped ones and revalidates /websites", async () => {
    const result = await bulkLinkGoogleAccountAction(
      form({ sourceCredentialId: "s", projectId: ["a", "b", "c", "d", "e"], autoProperty: "on" }),
    );
    expect(result).toEqual({
      ok: true,
      message: "Linked 2 projects. Skipped 3 (2 already connected, 1 closed).",
    });
    expect(mocks.bulk).toHaveBeenCalledWith({
      workspaceId: "ws1",
      userId: "u1",
      sourceCredentialId: "s",
      projectIds: ["a", "b", "c", "d", "e"],
      autoProperty: true,
    });
    expect(mocks.revalidate).toHaveBeenCalledWith("/websites");
  });

  it("keeps automatic property matching off unless the box is checked", async () => {
    await bulkLinkGoogleAccountAction(form({ sourceCredentialId: "s", projectId: ["a"] }));
    expect(mocks.bulk.mock.calls[0]?.[0].autoProperty).toBe(false);
  });

  it("says no project was linked when everything was skipped", async () => {
    mocks.bulk.mockResolvedValue({
      ok: true,
      linked: 0,
      rows: [{ projectId: "a", status: "skipped", reason: "closed" }],
    });
    const result = await bulkLinkGoogleAccountAction(
      form({ sourceCredentialId: "s", projectId: ["a"] }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("No project was linked.");
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("maps a refused source and an invalid token to plain messages", async () => {
    mocks.bulk.mockResolvedValue({ ok: false, reason: "bad_source" });
    expect(
      (await bulkLinkGoogleAccountAction(form({ sourceCredentialId: "s", projectId: ["a"] }))).message,
    ).toContain("can't be used");
    mocks.bulk.mockResolvedValue({ ok: false, reason: "token_invalid" });
    expect(
      (await bulkLinkGoogleAccountAction(form({ sourceCredentialId: "s", projectId: ["a"] }))).message,
    ).toContain("Reconnect");
  });
});
