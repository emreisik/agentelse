import { describe, expect, it, vi } from "vitest";

// What a creative job is billed for must equal what it does (docs/billing-
// quota.md "Image rights"): the pictures an image model DRAWS, nothing else.

vi.mock("@/server/reasoning/openai-client", () => ({
  isOpenAIConfigured: () => true,
  openaiModelForTier: () => "gpt-test",
  runOpenAIStructured: vi.fn(),
}));
vi.mock("@/server/media/creative-image", () => ({
  generateCreativeImage: vi.fn(),
  isCreativeImageConfigured: () => true,
}));

const { OpenAiCreativeProvider, creativeImageCount } = await import(
  "./openai-creative.provider"
);

describe("creativeImageCount", () => {
  it("is one picture for an ordinary job", () => {
    expect(creativeImageCount({})).toBe(1);
    expect(creativeImageCount({ request: "a post about coffee" })).toBe(1);
    expect(creativeImageCount({ preset: { caption: "x" } })).toBe(1);
  });

  it("is zero when the brand's own photo is the picture", () => {
    expect(creativeImageCount({ photoAssetIds: ["asset-1"] })).toBe(0);
    // Photo mode wins over a variants request (one photo is one picture).
    expect(
      creativeImageCount({ photoAssetIds: ["asset-1"], variantCount: 3 }),
    ).toBe(0);
  });

  it("ignores photo ids that execute() would also ignore", () => {
    expect(creativeImageCount({ photoAssetIds: [] })).toBe(1);
    expect(creativeImageCount({ photoAssetIds: [42, null, ""] })).toBe(1);
    expect(creativeImageCount({ photoAssetIds: ["x".repeat(65)] })).toBe(1);
    expect(creativeImageCount({ photoAssetIds: "asset-1" })).toBe(1);
  });

  // execute() only cuts a photo when the FIRST id is a real one; an empty id
  // passes the length bound but names nothing, so the job still draws. Billing
  // it as a free photo post would hand out pictures at no charge.
  it("does not treat an empty first id as a photo", () => {
    expect(creativeImageCount({ photoAssetIds: [""] })).toBe(1);
    expect(creativeImageCount({ photoAssetIds: ["", "asset-1"] })).toBe(1);
    // Any listed id still switches variants off, exactly as execute() does.
    expect(creativeImageCount({ photoAssetIds: [""], variantCount: 3 })).toBe(1);
  });

  it("is zero for another format of a post that already has its picture", () => {
    expect(creativeImageCount({ adaptFromAssetId: "asset-9" })).toBe(0);
  });

  it("is the full count for a variants job, even one that names a picture", () => {
    expect(creativeImageCount({ variantCount: 3 })).toBe(3);
    expect(creativeImageCount({ variantCount: 2 })).toBe(2);
    expect(
      creativeImageCount({ variantCount: 3, adaptFromAssetId: "asset-9" }),
    ).toBe(3);
  });

  it("treats an invalid variant count as an ordinary single picture", () => {
    expect(creativeImageCount({ variantCount: 1 })).toBe(1);
    expect(creativeImageCount({ variantCount: 2.5 })).toBe(1);
    expect(creativeImageCount({ variantCount: "3" })).toBe(1);
    expect(creativeImageCount({ variantCount: 999 })).toBe(1);
  });
});

describe("OpenAiCreativeProvider.usageEstimate", () => {
  it("declares a content job with the drawn picture count", () => {
    const provider = new OpenAiCreativeProvider();
    const estimate = (payload: unknown) =>
      provider.usageEstimate({
        executionJobId: "job-1",
        correlationId: "corr-1",
        idempotencyKey: "k",
        capability: "CREATE_SOCIAL_CREATIVE",
        context: {
          workspaceId: "ws",
          projectId: "p",
          brandId: "b",
          taskId: "t",
          capability: "CREATE_SOCIAL_CREATIVE",
          riskLevel: "LOW",
        },
        payload,
      });
    expect(estimate({ request: "x" })).toEqual({ class: "content", images: 1 });
    expect(estimate({ adaptFromAssetId: "a" })).toEqual({
      class: "content",
      images: 0,
    });
    expect(estimate(undefined)).toEqual({ class: "content", images: 1 });
  });
});
