import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const run = vi.fn();
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run },
}));

const { analyzePostStyleImage } = await import("./post-style-analyzer");
const { postStyleExampleDef } = await import("@/server/reasoning/prompts/post-style");

const scope = { workspaceId: "ws", projectId: "p1", brandId: "b1" };
const image = { mimeType: "image/jpeg", data: "abc" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("analyzePostStyleImage", () => {
  it("sends the picture to the reasoning service with the brand's scope and the label", async () => {
    run.mockResolvedValue({ output: { recipe: "r" }, isMock: false });
    const result = await analyzePostStyleImage({ scope, image, label: "Auction ad" });
    expect(result).toEqual({ recipe: "r" });
    expect(run).toHaveBeenCalledWith(postStyleExampleDef, {
      workspaceId: "ws",
      projectId: "p1",
      brandId: "b1",
      attachments: [image],
      context: { label: "Auction ad" },
    });
  });

  it("a failed analysis is null, never a throw (the example is kept anyway)", async () => {
    run.mockRejectedValue(new Error("model down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await analyzePostStyleImage({ scope, image })).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("the analysis prompt", () => {
  it("asks for a recipe another designer can rebuild the post from, with the product and words as placeholders", () => {
    const { system, user } = postStyleExampleDef.buildPrompt({ label: "Auction ad" });
    expect(system).toContain("how the post is BUILT, not what it is about");
    expect(system).toContain("recipe: the whole design as ONE imperative instruction");
    expect(system).toContain("PRODUCT AND THE WORDS are placeholders");
    expect(user).toContain('"Auction ad"');
    expect(postStyleExampleDef.buildPrompt({}).user).toBe("Analyse the attached example post.");
  });

  it("has a mock that derives from its input", () => {
    expect(postStyleExampleDef.buildMock({ label: "My ad" }).summary).toContain("My ad");
  });
});
