import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: the creative card's "Share on Social Accounts" list shows an
// Instagram Login connection once, under a neutral title with the handle as subtitle (not
// the handle twice), keeps the Page's name on the Facebook route, lists nothing for a
// connection that is not ACTIVE, and shows Facebook only for a Page selected in the
// Facebook integration itself.

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

  it("lists nothing for an Instagram Login connection past its 60 days, even though no status flipped yet", async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const metadata = (expires: string) => ({
      login: "instagram",
      instagramAccount: { id: "17841400", username: "webhealth" },
      pages: [],
      longLivedTokenExpiresAt: expires,
    });
    onlyInstagram(row("ACTIVE", metadata(yesterday)));
    expect(await getPublishTargets("proj-1")).toEqual([]);
    onlyInstagram(row("ACTIVE", metadata(tomorrow)));
    expect(await getPublishTargets("proj-1")).toHaveLength(1);
  });

  it("does not treat a Facebook-route connection's date as expiry (that date is a guess)", async () => {
    onlyInstagram(
      row("ACTIVE", {
        selectedPageId: "p1",
        pages: [{ pageId: "p1", pageName: "Web Health", instagramBusinessAccountId: "ig-1" }],
        longLivedTokenExpiresAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    );
    expect(await getPublishTargets("proj-1")).toHaveLength(1);
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

// Rows per provider; a provider without an entry has no row.
function rowsByProvider(rows: Record<string, unknown>) {
  findUnique.mockImplementation(
    async ({ where }: { where: { projectId_provider: { provider: string } } }) =>
      rows[where.projectId_provider.provider] ?? null,
  );
}

describe("getPublishTargets: Facebook", () => {
  const facebookPages = {
    selectedPageId: "p1",
    pages: [
      { pageId: "p1", pageName: "Web Health" },
      { pageId: "p2", pageName: "Other Page" },
    ],
  };

  it("lists the Page selected in the Facebook integration, with its name as the label", async () => {
    rowsByProvider({ facebook: row("ACTIVE", facebookPages) });
    expect(await getPublishTargets("proj-1")).toEqual([
      { platform: "facebook", pageId: "p1", accountLabel: "Web Health" },
    ]);
  });

  it("lists nothing without a selected Page, for a Page no longer in the list, or when not ACTIVE", async () => {
    rowsByProvider({ facebook: row("ACTIVE", { ...facebookPages, selectedPageId: undefined }) });
    expect(await getPublishTargets("proj-1")).toEqual([]);

    rowsByProvider({ facebook: row("ACTIVE", { ...facebookPages, selectedPageId: "gone" }) });
    expect(await getPublishTargets("proj-1")).toEqual([]);

    for (const status of ["EXPIRED", "REVOKED"]) {
      rowsByProvider({ facebook: row(status, facebookPages) });
      expect(await getPublishTargets("proj-1")).toEqual([]);
    }
  });

  it("a Page picked in the Instagram or Meta Ads connection is not a Facebook target", async () => {
    rowsByProvider({
      instagram: row("ACTIVE", {
        selectedPageId: "p1",
        pages: [{ pageId: "p1", pageName: "Web Health", instagramBusinessAccountId: "ig-1" }],
      }),
      meta_ads: row("ACTIVE", facebookPages),
    });
    const targets = await getPublishTargets("proj-1");
    expect(targets.map((t) => t.platform)).toEqual(["instagram"]);
  });

  it("comes last, so it never becomes the primary platform of a project that already publishes elsewhere", async () => {
    rowsByProvider({
      facebook: row("ACTIVE", facebookPages),
      x: { status: "ACTIVE", metadata: {}, accountLabel: "@webhealth" },
    });
    const targets = await getPublishTargets("proj-1");
    expect(targets.map((t) => t.platform)).toEqual(["x", "facebook"]);
  });
});
