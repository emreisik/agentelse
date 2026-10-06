import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: havuzdaki (APPROVED olmayan) fikirler silinir,
// onaylanmış ya da planlanmış fikirler kalır ve kanıtları çıkarılır; fikirler
// ideaIds boş olsa da kanıt adresindeki opportunity=<bulgu> ile bulunur;
// sinyaller kaynak + payload.linkId ile silinir; boş girdi sorgu atmaz.

const mocks = vi.hoisted(() => ({
  findings: vi.fn(),
  ideaFindMany: vi.fn(),
  ideaDeleteMany: vi.fn(),
  ideaUpdate: vi.fn(),
  signalDeleteMany: vi.fn(),
  links: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoFinding: { findMany: mocks.findings },
    idea: {
      findMany: mocks.ideaFindMany,
      deleteMany: mocks.ideaDeleteMany,
      update: mocks.ideaUpdate,
    },
    signal: { deleteMany: mocks.signalDeleteMany },
    gscSiteLink: { findMany: mocks.links },
  },
}));

const {
  forgetSearchOpportunitiesForCredential,
  forgetSearchOpportunitiesForLinks,
  forgetSearchOpportunitiesForProjects,
  opportunityIdsOf,
} = await import("./forget");

const URL_OF = (id: string) =>
  `https://app.example.com/projects/p1/arama?opportunity=${id}#opportunities`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findings.mockResolvedValue([
    { id: "f1", projectId: "p1", ideaIds: ["i-pool", "i-approved"] },
    { id: "f2", projectId: "p1", ideaIds: [] },
  ]);
  // 1. çağrı: projenin seo/search fikirleri; 2. çağrı: aday fikirler.
  mocks.ideaFindMany.mockImplementation(
    async (args: { where: { id?: { in: string[] } } }) => {
      const all = [
        {
          id: "i-pool",
          status: "RAW",
          concept: { module: "seo", source: "search", evidence: [] },
        },
        {
          id: "i-approved",
          status: "APPROVED",
          concept: {
            module: "seo",
            source: "search",
            evidence: [{ title: "Search", url: URL_OF("f1") }],
          },
        },
        {
          id: "i-by-url",
          status: "SHORTLISTED",
          concept: {
            module: "seo",
            source: "search",
            evidence: [{ title: "Search", url: URL_OF("f2") }],
          },
        },
        {
          id: "i-planned",
          status: "PLANNING",
          concept: {
            module: "seo",
            source: "search",
            evidence: [{ title: "Search", url: URL_OF("f2") }],
          },
        },
        {
          id: "i-other",
          status: "RAW",
          concept: {
            module: "seo",
            source: "search",
            evidence: [{ title: "Search", url: URL_OF("someone-else") }],
          },
        },
        {
          id: "i-broken",
          status: "RAW",
          concept: {
            module: "seo",
            source: "search",
            evidence: [{ title: "Search", url: "not a url" }],
          },
        },
      ];
      const ids = args.where.id?.in;
      return ids ? all.filter((idea) => ids.includes(idea.id)) : all;
    },
  );
  mocks.ideaDeleteMany.mockImplementation(
    async (args: { where: { id: { in: string[] } } }) => ({
      count: args.where.id.in.length,
    }),
  );
  mocks.ideaUpdate.mockResolvedValue({});
  mocks.signalDeleteMany.mockResolvedValue({ count: 2 });
  mocks.links.mockResolvedValue([{ id: "link-1" }]);
});

describe("forgetSearchOpportunitiesForLinks", () => {
  it("deletes pool ideas except APPROVED and strips evidence from kept ones", async () => {
    const result = await forgetSearchOpportunitiesForLinks(["link-1"]);
    const deleted = (
      mocks.ideaDeleteMany.mock.calls[0]?.[0] as {
        where: { id: { in: string[] } };
      }
    ).where.id.in;
    expect(deleted.sort()).toEqual(["i-by-url", "i-pool"]);
    const stripped = mocks.ideaUpdate.mock.calls.map(
      (call) => (call[0] as { where: { id: string } }).where.id,
    );
    expect(stripped.sort()).toEqual(["i-approved", "i-planned"]);
    for (const call of mocks.ideaUpdate.mock.calls) {
      const data = (call[0] as { data: { concept: Record<string, unknown> } })
        .data;
      expect(data.concept).not.toHaveProperty("evidence");
      expect(data.concept).toMatchObject({ module: "seo", source: "search" });
    }
    expect(result).toEqual({ ideas: 4, signals: 2 });
  });

  it("finds ideas through the evidence url even with empty ideaIds", async () => {
    mocks.findings.mockResolvedValue([
      { id: "f2", projectId: "p1", ideaIds: [] },
    ]);
    await forgetSearchOpportunitiesForLinks(["link-1"]);
    const deleted = (
      mocks.ideaDeleteMany.mock.calls[0]?.[0] as {
        where: { id: { in: string[] } };
      }
    ).where.id.in;
    expect(deleted).toEqual(["i-by-url"]);
  });

  it("deletes engine signals by source and linkId", async () => {
    await forgetSearchOpportunitiesForLinks(["link-1", "link-2"]);
    expect(mocks.signalDeleteMany).toHaveBeenCalledWith({
      where: {
        source: "search-console-opportunities",
        payload: { path: ["linkId"], equals: "link-1" },
      },
    });
    expect(mocks.signalDeleteMany).toHaveBeenCalledWith({
      where: {
        source: "search-console-opportunities",
        payload: { path: ["linkId"], equals: "link-2" },
      },
    });
  });

  it("returns zeros without a query for empty input", async () => {
    expect(await forgetSearchOpportunitiesForLinks([])).toEqual({
      ideas: 0,
      signals: 0,
    });
    expect(await forgetSearchOpportunitiesForProjects([])).toEqual({
      ideas: 0,
      signals: 0,
    });
    expect(mocks.findings).not.toHaveBeenCalled();
    expect(mocks.links).not.toHaveBeenCalled();
    expect(mocks.signalDeleteMany).not.toHaveBeenCalled();
  });

  it("resolves a credential to its links", async () => {
    await forgetSearchOpportunitiesForCredential("cred-1");
    expect(mocks.links).toHaveBeenCalledWith({
      where: { credentialId: "cred-1" },
      select: { id: true },
    });
    expect(mocks.findings).toHaveBeenCalledWith(
      expect.objectContaining({ where: { linkId: { in: ["link-1"] } } }),
    );
  });

  it("ignores malformed evidence urls", () => {
    expect(
      opportunityIdsOf({
        evidence: [{ url: "::" }, { url: URL_OF("f9") }, { title: "x" }],
      }),
    ).toEqual(["f9"]);
    expect(opportunityIdsOf(null)).toEqual([]);
  });
});
