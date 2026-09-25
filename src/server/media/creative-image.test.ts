import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

// Core guarantee this file exists to prove (docs/brand-workspace-migration.md
// §7 Phase 5 — Creative Engine provider fallback): generateCreativeImage's
// preference order is Gemini -> OpenAI -> OpenClaw -> fal.ai (last-resort
// tier), each only tried once every earlier tier has failed or isn't
// configured — and the explicit falModelId path (Image Studio) still never
// falls back to anything else.

const storageMocks = vi.hoisted(() => ({
  readAsset: vi.fn(),
  overwriteAsset: vi.fn(),
}));
vi.mock("@/server/storage/asset-storage", () => ({
  readAsset: storageMocks.readAsset,
  overwriteAsset: storageMocks.overwriteAsset,
}));

const geminiMocks = vi.hoisted(() => ({
  generateGeminiImage: vi.fn(),
  isGeminiImageConfigured: vi.fn(),
}));
vi.mock("@/server/reasoning/gemini-image-client", () => ({
  generateGeminiImage: geminiMocks.generateGeminiImage,
  isGeminiImageConfigured: geminiMocks.isGeminiImageConfigured,
}));

const openaiMocks = vi.hoisted(() => ({
  generateOpenAIImage: vi.fn(),
  isOpenAIImageConfigured: vi.fn(),
}));
vi.mock("@/server/reasoning/openai-image-client", () => ({
  generateOpenAIImage: openaiMocks.generateOpenAIImage,
  isOpenAIImageConfigured: openaiMocks.isOpenAIImageConfigured,
}));

const openclawMocks = vi.hoisted(() => ({
  generateCreativeImageAsset: vi.fn(),
  isOpenClawImageConfigured: vi.fn(),
}));
vi.mock("@/server/execution/providers/openclaw/openclaw-image-client", () => ({
  generateCreativeImageAsset: openclawMocks.generateCreativeImageAsset,
  isOpenClawImageConfigured: openclawMocks.isOpenClawImageConfigured,
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
  geminiMocks.isGeminiImageConfigured.mockReturnValue(false);
  openaiMocks.isOpenAIImageConfigured.mockReturnValue(false);
  openclawMocks.isOpenClawImageConfigured.mockReturnValue(false);
  falMocks.isFalImageConfigured.mockReturnValue(false);
});

describe("generateCreativeImage — fallback order", () => {
  it("uses Gemini when configured and successful, never touching OpenAI, OpenClaw or fal", async () => {
    geminiMocks.isGeminiImageConfigured.mockReturnValue(true);
    geminiMocks.generateGeminiImage.mockResolvedValue({
      storageKey: "k-gemini",
      mimeType: "image/png",
      size: 123,
    });

    const result = await generateCreativeImage("a blazer on white");

    expect(result?.storageKey).toBe("k-gemini");
    expect(openaiMocks.generateOpenAIImage).not.toHaveBeenCalled();
    expect(openclawMocks.generateCreativeImageAsset).not.toHaveBeenCalled();
    expect(falMocks.generateFalImage).not.toHaveBeenCalled();
  });

  it("falls back to OpenAI when Gemini is configured but returns null (failure)", async () => {
    geminiMocks.isGeminiImageConfigured.mockReturnValue(true);
    geminiMocks.generateGeminiImage.mockResolvedValue(null);
    openaiMocks.isOpenAIImageConfigured.mockReturnValue(true);
    openaiMocks.generateOpenAIImage.mockResolvedValue({
      storageKey: "k-openai",
      mimeType: "image/png",
      size: 123,
    });

    const result = await generateCreativeImage("a blazer on white");

    expect(result?.storageKey).toBe("k-openai");
  });

  it("uses OpenAI when Gemini is unconfigured, never touching OpenClaw or fal", async () => {
    openaiMocks.isOpenAIImageConfigured.mockReturnValue(true);
    openaiMocks.generateOpenAIImage.mockResolvedValue({
      storageKey: "k-openai",
      mimeType: "image/png",
      size: 123,
    });

    const result = await generateCreativeImage("a blazer on white");

    expect(result?.storageKey).toBe("k-openai");
    expect(openclawMocks.generateCreativeImageAsset).not.toHaveBeenCalled();
    expect(falMocks.generateFalImage).not.toHaveBeenCalled();
  });

  it("falls back to OpenClaw when neither Gemini nor OpenAI is configured", async () => {
    openclawMocks.isOpenClawImageConfigured.mockReturnValue(true);
    openclawMocks.generateCreativeImageAsset.mockResolvedValue({
      storageKey: "k-openclaw",
      mimeType: "image/png",
      size: 123,
    });

    const result = await generateCreativeImage("a blazer on white");

    expect(result?.storageKey).toBe("k-openclaw");
    expect(falMocks.generateFalImage).not.toHaveBeenCalled();
  });

  it("falls back to OpenClaw when Gemini and OpenAI are both configured but return null (failure)", async () => {
    geminiMocks.isGeminiImageConfigured.mockReturnValue(true);
    geminiMocks.generateGeminiImage.mockResolvedValue(null);
    openaiMocks.isOpenAIImageConfigured.mockReturnValue(true);
    openaiMocks.generateOpenAIImage.mockResolvedValue(null);
    openclawMocks.isOpenClawImageConfigured.mockReturnValue(true);
    openclawMocks.generateCreativeImageAsset.mockResolvedValue({
      storageKey: "k-openclaw",
      mimeType: "image/png",
      size: 123,
    });

    const result = await generateCreativeImage("a blazer on white");

    expect(result?.storageKey).toBe("k-openclaw");
  });

  it("falls back to fal (FLUX Schnell) only once Gemini, OpenAI and OpenClaw all fail/aren't configured", async () => {
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

  it("an explicit falModelId (Image Studio path) never falls back to Gemini/OpenAI/OpenClaw/the generic fal fallback", async () => {
    geminiMocks.isGeminiImageConfigured.mockReturnValue(true);
    openaiMocks.isOpenAIImageConfigured.mockReturnValue(true);
    openclawMocks.isOpenClawImageConfigured.mockReturnValue(true);
    falMocks.generateFalImage.mockResolvedValue(null); // the picked model fails

    const result = await generateCreativeImage("a blazer", {
      falModelId: "flux-pro-ultra",
    });

    expect(result).toBeNull();
    expect(geminiMocks.generateGeminiImage).not.toHaveBeenCalled();
    expect(openaiMocks.generateOpenAIImage).not.toHaveBeenCalled();
    expect(openclawMocks.generateCreativeImageAsset).not.toHaveBeenCalled();
    expect(falMocks.generateFalImage).toHaveBeenCalledWith(
      "fal-ai/flux-pro/v1.1-ultra",
      "a blazer",
      undefined,
      undefined,
    );
  });
});

describe("isCreativeImageConfigured", () => {
  it("is true when only Gemini is configured", () => {
    geminiMocks.isGeminiImageConfigured.mockReturnValue(true);
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
