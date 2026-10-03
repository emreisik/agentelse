import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  assetCreate: vi.fn(),
  assetFindFirst: vi.fn(),
  identityUpsert: vi.fn(),
  countExamples: vi.fn(),
  getExample: vi.fn(),
  saveExample: vi.fn(),
  analyze: vi.fn(),
  safeFetch: vi.fn(),
  putAsset: vi.fn(),
  readAsset: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    asset: { create: mocks.assetCreate, findFirst: mocks.assetFindFirst },
    brandVisualIdentity: { upsert: mocks.identityUpsert },
  },
}));
vi.mock("@/server/brand/post-style-store", () => ({
  countExamples: mocks.countExamples,
  getExample: mocks.getExample,
  saveExample: mocks.saveExample,
}));
vi.mock("@/server/brand/post-style-analyzer", () => ({
  analyzePostStyleImage: mocks.analyze,
}));
vi.mock("@/server/security/safe-fetch", () => ({ safeFetch: mocks.safeFetch }));
vi.mock("@/server/storage/asset-storage", () => ({
  putAsset: mocks.putAsset,
  readAsset: mocks.readAsset,
}));

const {
  addExampleFromAsset,
  addExampleFromBytes,
  fetchLinkImage,
  normalizeExampleImage,
  reanalyzeExample,
} = await import("./post-style-service");

const scope = { workspaceId: "ws", projectId: "p1", brandId: "b1" };

async function png(
  width: number,
  height: number,
  options: { alpha?: boolean } = {},
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: options.alpha ? 4 : 3,
      background: options.alpha ? { r: 10, g: 20, b: 30, alpha: 0.5 } : "#123456",
    },
  })
    .png()
    .toBuffer();
}

const analysis = {
  summary: "Dark ad",
  layout: "",
  typography: "",
  colors: "",
  product: "",
  graphics: "",
  background: "",
  mood: "",
  recipe: "Recipe.",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.countExamples.mockResolvedValue(0);
  mocks.getExample.mockResolvedValue(null);
  mocks.saveExample.mockResolvedValue(undefined);
  mocks.identityUpsert.mockResolvedValue({});
  mocks.analyze.mockResolvedValue(analysis);
  mocks.putAsset.mockResolvedValue({ storageKey: "r2://k.jpg", filename: "k.jpg" });
  mocks.assetCreate.mockResolvedValue({ id: "asset-1" });
});

describe("normalizeExampleImage", () => {
  it("fits a big picture inside 1600px and re-encodes it as a JPEG", async () => {
    const result = await normalizeExampleImage(await png(3200, 2400));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(1600);
    expect(result.image.height).toBe(1200);
    expect(result.image.mimeType).toBe("image/jpeg");
    expect(result.image.ext).toBe("jpg");
    expect((await sharp(result.image.buffer).metadata()).format).toBe("jpeg");
  });

  it("keeps a picture with transparency as a PNG and never enlarges", async () => {
    const result = await normalizeExampleImage(await png(500, 600, { alpha: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.mimeType).toBe("image/png");
    expect(result.image.width).toBe(500);
    expect(result.image.height).toBe(600);
  });

  it("refuses a thumbnail, a file that is not a picture and a format the model does not take", async () => {
    expect(await normalizeExampleImage(await png(100, 100))).toEqual({
      ok: false,
      reason: "The picture is too small (at least 240px on its short side).",
    });
    expect(await normalizeExampleImage(Buffer.from("not a picture"))).toEqual({
      ok: false,
      reason: "That file isn't a picture.",
    });
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="red"/></svg>',
    );
    expect(await normalizeExampleImage(svg)).toEqual({
      ok: false,
      reason: "Use a PNG, JPG or WebP picture.",
    });
  });
});

describe("addExampleFromBytes", () => {
  it("stores the picture, reads it into a recipe and keeps the example switched on", async () => {
    const result = await addExampleFromBytes({
      scope,
      bytes: await png(800, 1000),
      label: "  Auction   ad ",
      source: "upload",
    });
    expect(result).toEqual({ ok: true, assetId: "asset-1", analyzed: true });
    expect(mocks.assetCreate.mock.calls[0]![0].data).toMatchObject({
      workspaceId: "ws",
      projectId: "p1",
      brandId: "b1",
      type: "IMAGE",
      source: "CUSTOMER_UPLOAD",
      width: 800,
      height: 1000,
    });
    // The brand needs a visual identity row for the kit to reach a render.
    expect(mocks.identityUpsert).toHaveBeenCalledWith({
      where: { brandId: "b1" },
      create: { workspaceId: "ws", projectId: "p1", brandId: "b1" },
      update: {},
    });
    const saved = mocks.saveExample.mock.calls[0]![1];
    expect(saved).toMatchObject({
      assetId: "asset-1",
      label: "Auction ad",
      source: "upload",
      enabled: true,
      analysis,
    });
    expect(saved.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("an analysis that failed still keeps the example (the pictures guide the model)", async () => {
    mocks.analyze.mockResolvedValue(null);
    const result = await addExampleFromBytes({
      scope,
      bytes: await png(800, 1000),
      source: "link",
      url: "https://x.com/post",
    });
    expect(result).toEqual({ ok: true, assetId: "asset-1", analyzed: false });
    expect(mocks.saveExample.mock.calls[0]![1]).toMatchObject({
      analysis: null,
      source: "link",
      url: "https://x.com/post",
    });
  });

  it("refuses when the brand already keeps the most examples, before storing anything", async () => {
    mocks.countExamples.mockResolvedValue(12);
    const result = await addExampleFromBytes({
      scope,
      bytes: await png(800, 1000),
      source: "upload",
    });
    expect(result).toEqual({
      ok: false,
      reason: "You can keep up to 12 examples. Remove one first.",
    });
    expect(mocks.putAsset).not.toHaveBeenCalled();
    expect(mocks.assetCreate).not.toHaveBeenCalled();
  });

  it("refuses what is not a picture without storing it", async () => {
    const result = await addExampleFromBytes({
      scope,
      bytes: Buffer.from("nope"),
      source: "upload",
    });
    expect(result).toMatchObject({ ok: false });
    expect(mocks.putAsset).not.toHaveBeenCalled();
  });
});

describe("addExampleFromAsset", () => {
  it("a picture of the project becomes an example without a second copy of the file", async () => {
    mocks.assetFindFirst.mockResolvedValue({ storageKey: "r2://att.png", mimeType: "image/png" });
    mocks.readAsset.mockResolvedValue(await png(800, 1000));
    const result = await addExampleFromAsset({
      scope,
      assetId: "att-1",
      label: "iPhone ad",
      source: "chat",
    });
    expect(result).toEqual({ ok: true, assetId: "att-1", analyzed: true });
    // Looked up WITH the project.
    expect(mocks.assetFindFirst.mock.calls[0]![0].where).toMatchObject({
      id: "att-1",
      projectId: "p1",
    });
    expect(mocks.putAsset).not.toHaveBeenCalled();
    expect(mocks.saveExample.mock.calls[0]![1]).toMatchObject({
      assetId: "att-1",
      source: "chat",
      label: "iPhone ad",
    });
  });

  it("an example that is already kept is not read again", async () => {
    mocks.getExample.mockResolvedValue({ assetId: "att-1", analysis });
    const result = await addExampleFromAsset({ scope, assetId: "att-1", source: "chat" });
    expect(result).toEqual({ ok: true, assetId: "att-1", analyzed: true });
    expect(mocks.analyze).not.toHaveBeenCalled();
    expect(mocks.saveExample).not.toHaveBeenCalled();
  });

  it("an asset of another project, or one that is not a picture, is not available", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);
    expect(await addExampleFromAsset({ scope, assetId: "x", source: "chat" })).toEqual({
      ok: false,
      reason: "That picture isn't available.",
    });
    mocks.assetFindFirst.mockResolvedValue({ storageKey: "r2://a.pdf", mimeType: "application/pdf" });
    expect(await addExampleFromAsset({ scope, assetId: "x", source: "chat" })).toEqual({
      ok: false,
      reason: "That picture isn't available.",
    });
    expect(mocks.saveExample).not.toHaveBeenCalled();
  });

  it("refuses when the brand already keeps the most examples", async () => {
    mocks.countExamples.mockResolvedValue(12);
    expect(await addExampleFromAsset({ scope, assetId: "x", source: "chat" })).toMatchObject({
      ok: false,
    });
    expect(mocks.assetFindFirst).not.toHaveBeenCalled();
  });
});

describe("reanalyzeExample", () => {
  it("reads the picture again and keeps everything else of the example", async () => {
    mocks.getExample.mockResolvedValue({
      assetId: "a1",
      label: "Old",
      source: "upload",
      enabled: false,
      analysis: null,
      addedAt: "2026-10-01T00:00:00.000Z",
    });
    mocks.assetFindFirst.mockResolvedValue({ storageKey: "r2://a.png", mimeType: "image/png" });
    mocks.readAsset.mockResolvedValue(await png(400, 400));
    expect(await reanalyzeExample(scope, "a1")).toBe(true);
    expect(mocks.saveExample.mock.calls[0]![1]).toMatchObject({
      assetId: "a1",
      label: "Old",
      enabled: false,
      analysis,
    });
  });

  it("false when the example is gone or the reading fails again", async () => {
    mocks.getExample.mockResolvedValue(null);
    expect(await reanalyzeExample(scope, "a1")).toBe(false);
    mocks.getExample.mockResolvedValue({ assetId: "a1", label: "" });
    mocks.assetFindFirst.mockResolvedValue({ storageKey: "r2://a.png", mimeType: "image/png" });
    mocks.readAsset.mockResolvedValue(await png(400, 400));
    mocks.analyze.mockResolvedValue(null);
    expect(await reanalyzeExample(scope, "a1")).toBe(false);
    expect(mocks.saveExample).not.toHaveBeenCalled();
  });
});

describe("fetchLinkImage", () => {
  const reply = (over: Record<string, unknown>) => ({
    url: "https://x.com/p",
    status: 200,
    contentType: "text/html",
    body: Buffer.from(""),
    truncated: false,
    ...over,
  });

  it("a link to a picture is the picture", async () => {
    mocks.safeFetch.mockResolvedValue(
      reply({ contentType: "image/png", body: Buffer.from("png-bytes"), url: "https://x.com/a.png" }),
    );
    expect(await fetchLinkImage("https://x.com/a.png")).toEqual({
      ok: true,
      bytes: Buffer.from("png-bytes"),
      url: "https://x.com/a.png",
    });
    expect(mocks.safeFetch).toHaveBeenCalledTimes(1);
  });

  it("a page gives the picture it names for itself, fetched in a second public request", async () => {
    mocks.safeFetch
      .mockResolvedValueOnce(
        reply({
          body: Buffer.from('<meta property="og:image" content="/img/p.jpg">'),
        }),
      )
      .mockResolvedValueOnce(
        reply({ contentType: "image/jpeg", body: Buffer.from("jpg"), url: "https://x.com/img/p.jpg" }),
      );
    const result = await fetchLinkImage("https://x.com/p");
    expect(result).toEqual({ ok: true, bytes: Buffer.from("jpg"), url: "https://x.com/img/p.jpg" });
    const second = mocks.safeFetch.mock.calls[1]!;
    expect(second[0]).toBe("https://x.com/img/p.jpg");
    expect(second[1].allowedContentTypes.test("image/webp")).toBe(true);
    expect(second[1].allowedContentTypes.test("text/html")).toBe(false);
  });

  it("a social network page with no picture says to add the picture as a file", async () => {
    mocks.safeFetch.mockResolvedValue(reply({ body: Buffer.from("<html>Log in</html>") }));
    const result = await fetchLinkImage("https://www.instagram.com/p/abc/");
    expect(result).toEqual({
      ok: false,
      reason:
        "That network doesn't hand its posts' pictures to apps. Save the picture (or take a screenshot) and add it as a file.",
    });
  });

  it("another page with no picture, a truncated picture and an odd content type", async () => {
    mocks.safeFetch.mockResolvedValueOnce(reply({ body: Buffer.from("<html></html>") }));
    expect(await fetchLinkImage("https://shop.com/p")).toEqual({
      ok: false,
      reason: "No picture was found on that page. Add the picture as a file.",
    });
    mocks.safeFetch.mockResolvedValueOnce(reply({ contentType: "image/png", truncated: true }));
    expect(await fetchLinkImage("https://x.com/big.png")).toEqual({
      ok: false,
      reason: "That picture is too large.",
    });
    mocks.safeFetch.mockResolvedValueOnce(reply({ contentType: "application/pdf" }));
    expect(await fetchLinkImage("https://x.com/a.pdf")).toEqual({
      ok: false,
      reason: "That link isn't a picture or a page.",
    });
  });

  it("an address that is not public (or any fetch failure) is a plain refusal, never a throw", async () => {
    mocks.safeFetch.mockRejectedValue(new Error("Blocked address"));
    expect(await fetchLinkImage("http://127.0.0.1/a.png")).toMatchObject({ ok: false });
    expect(await fetchLinkImage("https://instagram.com/p/x")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Save the picture"),
    });
  });
});
