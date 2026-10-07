import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

// Core guarantee this file exists to prove (docs/brand-workspace-migration.md
// §7 Phase 5 — Creative Engine provider fallback): generateCreativeImage's
// preference order is OpenAI -> fal.ai (last-resort tier), each only tried
// once every earlier tier has failed or isn't configured — and the explicit falModelId path (Image Studio) still never
// falls back to anything else.

const storageMocks = vi.hoisted(() => ({
  readAsset: vi.fn(),
  overwriteAsset: vi.fn(),
}));
vi.mock("@/server/storage/asset-storage", () => ({
  readAsset: storageMocks.readAsset,
  overwriteAsset: storageMocks.overwriteAsset,
}));

const openaiMocks = vi.hoisted(() => ({
  generateOpenAIImage: vi.fn(),
  isOpenAIImageConfigured: vi.fn(),
}));
vi.mock("@/server/reasoning/openai-image-client", () => ({
  generateOpenAIImage: openaiMocks.generateOpenAIImage,
  isOpenAIImageConfigured: openaiMocks.isOpenAIImageConfigured,
}));

const falMocks = vi.hoisted(() => ({
  generateFalImage: vi.fn(),
  isFalImageConfigured: vi.fn(),
}));
vi.mock("@/server/reasoning/fal-image-client", () => ({
  generateFalImage: falMocks.generateFalImage,
  isFalImageConfigured: falMocks.isFalImageConfigured,
}));

const { generateCreativeImage, isCreativeImageConfigured } =
  await import("./creative-image");

async function solidPng(): Promise<Buffer> {
  return sharp({
    create: { width: 100, height: 100, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();
}

beforeEach(async () => {
  vi.clearAllMocks();
  storageMocks.readAsset.mockResolvedValue(await solidPng());
  storageMocks.overwriteAsset.mockResolvedValue(undefined);
  openaiMocks.isOpenAIImageConfigured.mockReturnValue(false);
  falMocks.isFalImageConfigured.mockReturnValue(false);
});

describe("generateCreativeImage — reference pictures", () => {
  const refs = [
    { data: "ZXgx", mimeType: "image/png" },
    { data: "cHJvZA==", mimeType: "image/png" },
  ];
  const stored = {
    storageKey: "local-asset://a.png",
    filename: "a.png",
    mimeType: "image/png",
    size: 1,
  };

  it("hands the whole ordered set to the OpenAI tier", async () => {
    openaiMocks.isOpenAIImageConfigured.mockReturnValue(true);
    openaiMocks.generateOpenAIImage.mockResolvedValue({ ...stored, provider: "openai" });

    await generateCreativeImage("p", { referenceImages: refs, imageSize: { width: 100, height: 100 } });

    const args = openaiMocks.generateOpenAIImage.mock.calls[0]!;
    expect(args[3]).toBeUndefined();
    expect(args[6]).toEqual(refs);
  });

  it("the single reference picture goes the way it always did", async () => {
    openaiMocks.isOpenAIImageConfigured.mockReturnValue(true);
    openaiMocks.generateOpenAIImage.mockResolvedValue({ ...stored, provider: "openai" });

    await generateCreativeImage("p", {
      referenceImage: refs[0],
      imageSize: { width: 100, height: 100 },
    });

    const args = openaiMocks.generateOpenAIImage.mock.calls[0]!;
    expect(args[3]).toEqual(refs[0]);
    expect(args[6]).toBeUndefined();
  });
});

describe("generateCreativeImage — fallback order", () => {
  it("uses OpenAI when configured and successful, never touching fal", async () => {
    openaiMocks.isOpenAIImageConfigured.mockReturnValue(true);
    openaiMocks.generateOpenAIImage.mockResolvedValue({
      storageKey: "k-openai",
      mimeType: "image/png",
      size: 123,
    });

    const result = await generateCreativeImage("a blazer on white");

    expect(result?.storageKey).toBe("k-openai");
    expect(falMocks.generateFalImage).not.toHaveBeenCalled();
  });

  it("falls back to fal when OpenAI is configured but returns null (failure)", async () => {
    openaiMocks.isOpenAIImageConfigured.mockReturnValue(true);
    openaiMocks.generateOpenAIImage.mockResolvedValue(null);
    falMocks.isFalImageConfigured.mockReturnValue(true);
    falMocks.generateFalImage.mockResolvedValue({
      storageKey: "k-fal",
      mimeType: "image/png",
      size: 123,
    });

    const result = await generateCreativeImage("a blazer on white");

    expect(result?.storageKey).toBe("k-fal");
  });

  it("falls back to fal (FLUX Schnell) only once OpenAI fails/isn't configured", async () => {
    falMocks.isFalImageConfigured.mockReturnValue(true);
    falMocks.generateFalImage.mockResolvedValue({
      storageKey: "k-fal",
      mimeType: "image/png",
      size: 123,
    });

    const result = await generateCreativeImage("a blazer on white");

    expect(result?.storageKey).toBe("k-fal");
    expect(falMocks.generateFalImage).toHaveBeenCalledWith(
      "fal-ai/flux/schnell",
      "a blazer on white",
      undefined,
      undefined,
    );
  });

  it("returns null when no tier is configured or every tier fails", async () => {
    const result = await generateCreativeImage("a blazer on white");
    expect(result).toBeNull();
  });

  it("an explicit falModelId (Image Studio path) never falls back to OpenAI/the generic fal fallback", async () => {
    openaiMocks.isOpenAIImageConfigured.mockReturnValue(true);
    falMocks.generateFalImage.mockResolvedValue(null); // the picked model fails

    const result = await generateCreativeImage("a blazer", {
      falModelId: "flux-pro-ultra",
    });

    expect(result).toBeNull();
    expect(openaiMocks.generateOpenAIImage).not.toHaveBeenCalled();
    expect(falMocks.generateFalImage).toHaveBeenCalledWith(
      "fal-ai/flux-pro/v1.1-ultra",
      "a blazer",
      undefined,
      undefined,
    );
  });
});

describe("isCreativeImageConfigured", () => {
  it("is true when only OpenAI is configured", () => {
    openaiMocks.isOpenAIImageConfigured.mockReturnValue(true);
    expect(isCreativeImageConfigured()).toBe(true);
  });

  it("is true when only fal is configured", () => {
    falMocks.isFalImageConfigured.mockReturnValue(true);
    expect(isCreativeImageConfigured()).toBe(true);
  });

  it("is false when nothing is configured", () => {
    expect(isCreativeImageConfigured()).toBe(false);
  });
});
