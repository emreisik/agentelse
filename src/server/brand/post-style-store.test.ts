import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
  count: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    brandFact: {
      findMany: mocks.findMany,
      findFirst: mocks.findFirst,
      create: mocks.create,
      update: mocks.update,
      deleteMany: mocks.deleteMany,
      count: mocks.count,
    },
  },
}));

const {
  countExamples,
  getExample,
  loadPostStyle,
  loadPostStyleContext,
  removeExample,
  saveDirectives,
  saveExample,
} = await import("./post-style-store");

const scope = { workspaceId: "ws", projectId: "p1", brandId: "b1" };

const example = {
  assetId: "a1",
  label: "Ad",
  source: "upload" as const,
  enabled: true,
  analysis: null,
  addedAt: "2026-10-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadPostStyle", () => {
  it("reads only the kit's rows of the brand and sorts them into instructions and examples", async () => {
    mocks.findMany.mockResolvedValue([
      { key: "directives", value: { text: "Always dark.", fidelity: "inspired" } },
      { key: "example:a1", value: example },
      { key: "example:broken", value: { label: "no asset id" } },
      { key: "something-else", value: {} },
    ]);
    const kit = await loadPostStyle("b1");
    expect(mocks.findMany.mock.calls[0]![0].where).toEqual({
      brandId: "b1",
      category: "post_style",
    });
    expect(kit.directives).toEqual({ text: "Always dark.", fidelity: "inspired" });
    expect(kit.examples.map((entry) => entry.assetId)).toEqual(["a1"]);
  });

  it("an empty brand has the default instructions and no examples", async () => {
    mocks.findMany.mockResolvedValue([]);
    expect(await loadPostStyle("b1")).toEqual({
      directives: { text: "", fidelity: "match" },
      examples: [],
    });
    expect(await loadPostStyleContext("b1")).toBeNull();
  });

  it("the context keeps what is switched on", async () => {
    mocks.findMany.mockResolvedValue([
      { key: "example:a1", value: example },
      { key: "example:a2", value: { ...example, assetId: "a2", enabled: false } },
    ]);
    const context = await loadPostStyleContext("b1");
    expect(context?.examples.map((entry) => entry.assetId)).toEqual(["a1"]);
  });
});

describe("writing", () => {
  it("creates a row for a new example, with the brand's scope and its own category", async () => {
    mocks.findFirst.mockResolvedValue(null);
    await saveExample(scope, example);
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "ws",
        projectId: "p1",
        brandId: "b1",
        category: "post_style",
        key: "example:a1",
        value: example,
        source: "post-style",
      },
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("updates the row of an example that is already kept: one row per example", async () => {
    mocks.findFirst.mockResolvedValue({ id: "row-1" });
    await saveExample(scope, { ...example, enabled: false });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: { value: { ...example, enabled: false } },
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.findFirst.mock.calls[0]![0].where).toEqual({
      brandId: "b1",
      category: "post_style",
      key: "example:a1",
    });
  });

  it("the instructions are one row of their own", async () => {
    mocks.findFirst.mockResolvedValue(null);
    await saveDirectives(scope, { text: "Always dark.", fidelity: "match" });
    expect(mocks.create.mock.calls[0]![0].data).toMatchObject({
      key: "directives",
      category: "post_style",
      value: { text: "Always dark.", fidelity: "match" },
    });
  });
});

describe("reading and removing one example", () => {
  it("getExample parses the row, null when there is none or it is broken", async () => {
    mocks.findFirst.mockResolvedValueOnce({ value: example });
    expect(await getExample("b1", "a1")).toMatchObject({ assetId: "a1" });
    mocks.findFirst.mockResolvedValueOnce(null);
    expect(await getExample("b1", "a1")).toBeNull();
    mocks.findFirst.mockResolvedValueOnce({ value: "nonsense" });
    expect(await getExample("b1", "a1")).toBeNull();
  });

  it("removeExample deletes only that example of that brand and says whether it was there", async () => {
    mocks.deleteMany.mockResolvedValueOnce({ count: 1 });
    expect(await removeExample("b1", "a1")).toBe(true);
    expect(mocks.deleteMany.mock.calls[0]![0].where).toEqual({
      brandId: "b1",
      category: "post_style",
      key: "example:a1",
    });
    mocks.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await removeExample("b1", "a1")).toBe(false);
  });

  it("countExamples counts the examples, not the instructions", async () => {
    mocks.count.mockResolvedValue(3);
    expect(await countExamples("b1")).toBe(3);
    expect(mocks.count.mock.calls[0]![0].where).toEqual({
      brandId: "b1",
      category: "post_style",
      key: { startsWith: "example:" },
    });
  });
});
