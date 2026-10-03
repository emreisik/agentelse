import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const loadReferenceImage = vi.fn();
vi.mock("@/server/media/brand-logo", () => ({ loadReferenceImage }));

const { NO_STYLE_REFERENCES, loadStyleReferences } = await import("./style-references");

const picture = (id: string) => ({ data: `data-${id}`, mimeType: "image/png" });

const analysis = (recipe: string) => ({
  summary: "s",
  layout: "",
  typography: "",
  colors: "",
  product: "",
  graphics: "",
  background: "",
  mood: "",
  recipe,
});

const kit = (fidelity: "match" | "inspired" = "match") => ({
  fidelity,
  directives: "Always dark.",
  examples: [
    { assetId: "a", label: "A", analysis: analysis("Recipe A.") },
    { assetId: "b", label: "B", analysis: analysis("Recipe B.") },
    { assetId: "c", label: "C", analysis: null },
    { assetId: "d", label: "D", analysis: null },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  loadReferenceImage.mockImplementation(async (id: string | null | undefined) =>
    id && !id.startsWith("gone") ? picture(id) : null,
  );
});

describe("loadStyleReferences", () => {
  it("examples first (at most three), then the real product", async () => {
    const refs = await loadStyleReferences({
      visualIdentity: { postStyle: kit(), referenceImageAssetId: "board" },
      productAssetIds: ["p1", "p2"],
    });
    expect(refs.images).toEqual([picture("a"), picture("b"), picture("c"), picture("p1"), picture("p2")]);
    expect(refs.exampleCount).toBe(3);
    expect(refs.productCount).toBe(2);
    // The old board is not used next to a kit.
    expect(refs.legacyBoard).toBe(false);
    expect(refs.matchStyle).toBe(true);
    expect(refs.section).toContain("the first 3 attached images are example posts");
    expect(refs.section).toContain("next 2 attached images show the REAL product");
    expect(refs.section).toContain("Always dark.");
  });

  it("follows the examples a request names, and skips one whose picture is gone", async () => {
    const refs = await loadStyleReferences({
      visualIdentity: {
        postStyle: {
          ...kit(),
          examples: [
            ...kit().examples,
            { assetId: "gone-1", label: "Gone", analysis: null },
          ],
        },
      },
      exampleIds: ["gone-1", "b"],
    });
    expect(refs.images).toEqual([picture("b")]);
    expect(refs.exampleCount).toBe(1);
  });

  it("inspired is a direction, not a replica", async () => {
    const refs = await loadStyleReferences({
      visualIdentity: { postStyle: kit("inspired") },
    });
    expect(refs.matchStyle).toBe(false);
    expect(refs.section).toContain("as the design direction");
  });

  it("no kit: the old style board, with its old wording left to the prompt", async () => {
    const refs = await loadStyleReferences({
      visualIdentity: { referenceImageAssetId: "board" },
    });
    expect(refs.images).toEqual([picture("board")]);
    expect(refs.legacyBoard).toBe(true);
    expect(refs.section).toBeNull();
    expect(refs.matchStyle).toBe(false);
  });

  it("a kit whose pictures are all gone falls back to the board", async () => {
    const refs = await loadStyleReferences({
      visualIdentity: {
        postStyle: {
          fidelity: "match",
          directives: "",
          examples: [{ assetId: "gone-1", label: "", analysis: null }],
        },
        referenceImageAssetId: "board",
      },
    });
    expect(refs.images).toEqual([picture("board")]);
    expect(refs.legacyBoard).toBe(true);
  });

  it("a product picture alone, and no more than three of them", async () => {
    const refs = await loadStyleReferences({
      visualIdentity: null,
      productAssetIds: ["p1", "p2", "p3", "p4", "gone-x"],
    });
    expect(refs.images).toEqual([picture("p1"), picture("p2"), picture("p3")]);
    expect(refs.section).toContain("REAL product");
    expect(refs.exampleCount).toBe(0);
  });

  it("an edit has one picture of its own: no references at all", async () => {
    const refs = await loadStyleReferences({
      visualIdentity: { postStyle: kit(), referenceImageAssetId: "board" },
      productAssetIds: ["p1"],
      withReferences: false,
    });
    expect(refs).toEqual(NO_STYLE_REFERENCES);
    expect(loadReferenceImage).not.toHaveBeenCalled();
  });

  it("nothing configured: nothing is loaded", async () => {
    expect(await loadStyleReferences({ visualIdentity: null })).toEqual(NO_STYLE_REFERENCES);
    expect(await loadStyleReferences({ visualIdentity: {} })).toEqual(NO_STYLE_REFERENCES);
  });
});
