import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: the creative card's "Share on Social Accounts" list shows an
// Instagram Login connection once, under a neutral title with the handle as subtitle (not
// the handle twice), keeps the Page's name on the Facebook route, and lists nothing for a
// connection that is not ACTIVE.

const findUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { integrationCredential: { findUnique } },
}));

const { getPublishTargets } = await import("./meta-connection-status");

const row = (status: string, metadata: unknown) => ({ status, metadata, accountLabel: null });

// Instagram is the only provider with a row in these tests.
function onlyInstagram(instagramRow: unknown) {
  findUnique.mockImplementation(
    async ({ where }: { where: { projectId_provider: { provider: string } } }) =>
      where.projectId_provider.provider === "instagram" ? instagramRow : null,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("getPublishTargets: Instagram", () => {
  it("Instagram Login: title 'Instagram', the handle as the subtitle, a stable key", async () => {
    onlyInstagram(
      row("ACTIVE", {
        login: "instagram",
        instagramAccount: { id: "17841400", username: "webhealth" },
        pages: [],
      }),
    );
    expect(await getPublishTargets("proj-1")).toEqual([
      { platform: "instagram", pageId: "17841400", pageName: "Instagram", igUsername: "webhealth" },
    ]);
  });

  it("Facebook route: the Page's name as the title, as before", async () => {
    onlyInstagram(
      row("ACTIVE", {
        selectedPageId: "p1",
        pages: [
          { pageId: "p1", pageName: "Web Health", instagramBusinessAccountId: "ig-1", instagramUsername: "wh" },
        ],
      }),
    );
    expect(await getPublishTargets("proj-1")).toEqual([
      { platform: "instagram", pageId: "p1", pageName: "Web Health", igUsername: "wh" },
    ]);
  });

  it("lists nothing for a connection that is expired, revoked or has no account", async () => {
    for (const status of ["EXPIRED", "REVOKED", "NOT_CONFIGURED"]) {
      onlyInstagram(
        row(status, { login: "instagram", instagramAccount: { id: "1", username: "u" }, pages: [] }),
      );
      expect(await getPublishTargets("proj-1")).toEqual([]);
    }
    onlyInstagram(row("ACTIVE", { login: "instagram", pages: [] }));
    expect(await getPublishTargets("proj-1")).toEqual([]);
    onlyInstagram(null);
    expect(await getPublishTargets("proj-1")).toEqual([]);
  });
});
