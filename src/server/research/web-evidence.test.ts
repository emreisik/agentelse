import { beforeEach, describe, expect, it, vi } from "vitest";

// The shared store for what a web page said. What matters: a page read
// recently is found and reused, an old or empty one is not, and reading the
// same unchanged page again refreshes a timestamp instead of adding a copy.

const findFirst = vi.fn();
const update = vi.fn();
const create = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { evidence: { findFirst, update, create } },
}));

const { contentHashOf, findFreshPageEvidence, recordPageEvidence } =
  await import("./web-evidence");

const scope = { workspaceId: "ws-1", projectId: "proj-1", brandId: "brand-1" };
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.resetAllMocks();
  update.mockResolvedValue({});
  create.mockResolvedValue({ id: "ev-new" });
});

describe("contentHashOf", () => {
  it("is a stable sha256 of the text", () => {
    expect(contentHashOf("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(contentHashOf("hello")).toBe(contentHashOf("hello"));
    expect(contentHashOf("hello!")).not.toBe(contentHashOf("hello"));
  });
});

describe("findFreshPageEvidence", () => {
  it("returns a page read within the allowed age, scoped to the project and the exact URL", async () => {
    findFirst.mockResolvedValue({
      id: "ev-1",
      sourceUrl: "https://acme.com.tr/about",
      pageTitle: "Hakkımızda",
      extractedText: "Aile şirketi.",
    });
    const before = Date.now();

    const found = await findFreshPageEvidence(
      "proj-1",
      "https://acme.com.tr/about",
      7 * DAY,
    );

    expect(found).toEqual({
      id: "ev-1",
      url: "https://acme.com.tr/about",
      title: "Hakkımızda",
      text: "Aile şirketi.",
    });
    const where = findFirst.mock.calls[0]![0].where as {
      accessedAt: { gte: Date };
    };
    expect(where).toMatchObject({
      projectId: "proj-1",
      sourceType: "WEB_PAGE",
      sourceUrl: "https://acme.com.tr/about",
      extractedText: { not: null },
    });
    // The cut-off is "now minus the allowed age".
    expect(where.accessedAt.gte.getTime()).toBeGreaterThanOrEqual(before - 7 * DAY);
    expect(where.accessedAt.gte.getTime()).toBeLessThanOrEqual(Date.now() - 7 * DAY + 1_000);
  });

  it("returns null when nothing recent exists", async () => {
    findFirst.mockResolvedValue(null);

    await expect(
      findFreshPageEvidence("proj-1", "https://acme.com.tr/", DAY),
    ).resolves.toBeNull();
  });

  it("returns null for a row that never kept its text", async () => {
    findFirst.mockResolvedValue({
      id: "ev-2",
      sourceUrl: "https://acme.com.tr/",
      pageTitle: null,
      extractedText: null,
    });

    await expect(
      findFreshPageEvidence("proj-1", "https://acme.com.tr/", DAY),
    ).resolves.toBeNull();
  });

  it("does not even look when a fresh read is demanded (max age 0)", async () => {
    await expect(
      findFreshPageEvidence("proj-1", "https://acme.com.tr/", 0),
    ).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("recordPageEvidence", () => {
  it("stores a new page with where and when it was read, and a hash of its text", async () => {
    findFirst.mockResolvedValue(null);

    const id = await recordPageEvidence(scope, {
      url: "https://acme.com.tr/",
      title: "Acme",
      text: "Su bazlı boya.",
    });

    expect(id).toBe("ev-new");
    const data = create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      ...scope,
      sourceType: "WEB_PAGE",
      sourceUrl: "https://acme.com.tr/",
      pageTitle: "Acme",
      extractedText: "Su bazlı boya.",
      contentHash: contentHashOf("Su bazlı boya."),
    });
    expect(data.accessedAt).toBeInstanceOf(Date);
  });

  it("reuses the row when the same content was already stored, refreshing only its access time", async () => {
    findFirst.mockResolvedValue({ id: "ev-existing" });

    const id = await recordPageEvidence(scope, {
      url: "https://acme.com.tr/",
      text: "Aynı içerik.",
    });

    expect(id).toBe("ev-existing");
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "ev-existing" },
      data: { accessedAt: expect.any(Date) },
    });
    // Matched on project, URL and the content hash.
    expect(findFirst.mock.calls[0]![0].where).toMatchObject({
      projectId: "proj-1",
      sourceUrl: "https://acme.com.tr/",
      contentHash: contentHashOf("Aynı içerik."),
    });
  });

  it("stores a changed page as a new row", async () => {
    findFirst.mockResolvedValue(null);

    await recordPageEvidence(scope, { url: "https://acme.com.tr/", text: "v2" });

    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it("cuts an enormous page to a fixed size and hashes what it kept", async () => {
    findFirst.mockResolvedValue(null);

    await recordPageEvidence(scope, {
      url: "https://acme.com.tr/",
      text: "x".repeat(50_000),
    });

    const data = create.mock.calls[0]![0].data;
    expect(data.extractedText).toHaveLength(20_000);
    expect(data.contentHash).toBe(contentHashOf("x".repeat(20_000)));
  });
});
