import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard W95 (variants-provider): with payload.variantCount the provider
// renders the main picture plus N-1 alternatives concurrently at quality
// <= medium (an absent quality must never mean the provider's "high"),
// drops a failed render and still completes when one picture exists; without
// variantCount it makes exactly one image call, as before.

const runOpenAIStructured = vi.fn();
vi.mock("@/server/reasoning/openai-client", () => ({
  isOpenAIConfigured: () => true,
  openaiModelForTier: () => "gpt-test",
  runOpenAIStructured,
}));

const generateCreativeImage = vi.fn();
vi.mock("@/server/media/creative-image", () => ({
  generateCreativeImage,
  isCreativeImageConfigured: () => true,
}));
vi.mock("@/server/media/brand-logo", () => ({
  loadReferenceImage: vi.fn().mockResolvedValue(null),
}));
const applyBrandTemplate = vi.fn();
vi.mock("@/server/media/creative-template", () => ({ applyBrandTemplate }));

const { OpenAiCreativeProvider } = await import("./openai-creative.provider");

type Img = {
  storageKey: string;
  filename: string;
  mimeType: string;
  size: number;
  provider: string;
  width: number;
  height: number;
};

const img = (n: number): Img => ({
  storageKey: `r2://img-${n}.png`,
  filename: `img-${n}.png`,
  mimeType: "image/png",
  size: n,
  provider: "openai",
  width: 1080,
  height: 1350,
});

function request(payload: Record<string, unknown>) {
  return {
    executionJobId: "job-1",
    correlationId: "corr-1",
    idempotencyKey: "k",
    capability: "CREATE_SOCIAL_CREATIVE" as const,
    context: {
      workspaceId: "w",
      projectId: "p",
      brandId: "b",
      taskId: "t",
      capability: "CREATE_SOCIAL_CREATIVE" as const,
      riskLevel: "LOW" as const,
    },
    payload,
  };
}

type Completed = {
  image?: Img;
  alternatives?: { image: Img; label: string }[];
};

async function run(payload: Record<string, unknown>) {
  const provider = new OpenAiCreativeProvider();
  await provider.execute(request({ request: "a brief", ...payload }));
  return provider.getStatus("corr-1");
}

function completed(status: Awaited<ReturnType<typeof run>>): Completed {
  expect(status.status).toBe("COMPLETED");
  return (status as { rawResult: Completed }).rawResult;
}

const textStep = {
  raw: {
    caption: "cap",
    copy: "copy",
    imagePrompt: "MAIN-PROMPT",
    alternativeImagePrompts: ["ALT-PROMPT-A", "ALT-PROMPT-B"],
  },
};

// Which call is which: the prompt carries the subject text.
function promptOf(call: unknown[]): string {
  return String(call[0]);
}
const isMain = (call: unknown[]) => promptOf(call).includes("MAIN-PROMPT");
const isAlt = (call: unknown[]) => promptOf(call).includes("ALT-PROMPT");

beforeEach(() => {
  vi.clearAllMocks();
  runOpenAIStructured.mockResolvedValue(textStep);
  applyBrandTemplate.mockResolvedValue(null);
  let n = 0;
  generateCreativeImage.mockImplementation(async () => img(++n));
});

describe("variants: N-way renders", () => {
  it("renders the main picture and two alternatives, all at medium quality", async () => {
    const raw = completed(await run({ variantCount: 3 }));

    expect(generateCreativeImage).toHaveBeenCalledTimes(3);
    expect(raw.image).toBeDefined();
    expect(raw.alternatives).toHaveLength(2);
    expect(raw.alternatives?.map((a) => a.label)).toEqual([
      "Option 2",
      "Option 3",
    ]);
    // The main and the alternatives are three different renders.
    const keys = [raw.image, ...(raw.alternatives ?? []).map((a) => a.image)]
      .map((i) => i?.storageKey)
      .sort();
    expect(new Set(keys).size).toBe(3);
    for (const call of generateCreativeImage.mock.calls) {
      expect((call[1] as { quality?: string }).quality).toBe("medium");
    }
    expect(generateCreativeImage.mock.calls.filter(isMain)).toHaveLength(1);
    expect(generateCreativeImage.mock.calls.filter(isAlt)).toHaveLength(2);
  });

  it("asks the text step for N-1 different compositions, only with variantCount", async () => {
    await run({ variantCount: 3 });
    const variantCall = runOpenAIStructured.mock.calls[0]?.[0] as {
      system: string;
      jsonSchema: { properties: Record<string, unknown> };
    };
    expect(variantCall.system).toContain("alternativeImagePrompts");
    expect(variantCall.system).toContain("exactly 2 more image prompts");
    expect(Object.keys(variantCall.jsonSchema.properties)).toContain(
      "alternativeImagePrompts",
    );

    runOpenAIStructured.mockClear();
    await run({});
    const plainCall = runOpenAIStructured.mock.calls[0]?.[0] as {
      system: string;
      jsonSchema: { properties: Record<string, unknown> };
    };
    expect(plainCall.system).not.toContain("alternativeImagePrompts");
    expect(Object.keys(plainCall.jsonSchema.properties)).toEqual([
      "caption",
      "copy",
      "imagePrompt",
    ]);
  });

  it("drops a failed alternative (null) and keeps the others", async () => {
    generateCreativeImage.mockImplementation(async (prompt: string) =>
      prompt.includes("ALT-PROMPT-A") ? null : img(prompt.length),
    );

    const raw = completed(await run({ variantCount: 3 }));

    expect(raw.image).toBeDefined();
    expect(raw.alternatives).toHaveLength(1);
  });

  it("drops a render that throws without failing the job", async () => {
    generateCreativeImage.mockImplementation(async (prompt: string) => {
      if (prompt.includes("ALT-PROMPT-B")) throw new Error("render blew up");
      return img(prompt.length);
    });

    const raw = completed(await run({ variantCount: 3 }));

    expect(raw.image).toBeDefined();
    expect(raw.alternatives).toHaveLength(1);
  });

  it("completes with the main picture and no alternatives when every extra render fails", async () => {
    generateCreativeImage.mockImplementation(async (prompt: string) =>
      isAltPrompt(prompt) ? null : img(1),
    );

    const raw = completed(await run({ variantCount: 3 }));

    expect(raw.image?.storageKey).toBe("r2://img-1.png");
    expect(raw.alternatives).toEqual([]);
  });

  it("lets the first surviving alternative lead when the main render failed", async () => {
    generateCreativeImage.mockImplementation(async (prompt: string) =>
      prompt.includes("MAIN-PROMPT") ? null : img(prompt.length),
    );

    const raw = completed(await run({ variantCount: 3 }));

    expect(raw.image).toBeDefined();
    expect(raw.alternatives).toHaveLength(1);
  });

  it("fails the job (nothing billed) when every render threw", async () => {
    generateCreativeImage.mockRejectedValue(new Error("quota exceeded"));

    const status = await run({ variantCount: 3 });

    expect(status).toEqual({
      status: "FAILED",
      errorMessage: "quota exceeded",
      isMock: false,
    });
  });

  it("fails the job when every render answered null (generateCreativeImage never throws)", async () => {
    generateCreativeImage.mockResolvedValue(null);

    const status = await run({ variantCount: 3 });

    expect(status).toMatchObject({ status: "FAILED", isMock: false });
  });

  it("renders the three pictures concurrently, not one after another", async () => {
    const release: Array<() => void> = [];
    generateCreativeImage.mockImplementation(
      () =>
        new Promise((resolve) => {
          release.push(() => resolve(img(release.length)));
        }),
    );

    const provider = new OpenAiCreativeProvider();
    const done = provider.execute(
      request({ request: "a brief", variantCount: 3 }),
    );
    // All three renders started before any of them finished.
    await vi.waitFor(() =>
      expect(generateCreativeImage).toHaveBeenCalledTimes(3),
    );
    release.forEach((r) => r());
    await done;
    expect(
      completed(await provider.getStatus("corr-1")).alternatives,
    ).toHaveLength(2);
  });

  it("brand-templates every picture, the alternatives too", async () => {
    await run({ variantCount: 3 });
    expect(applyBrandTemplate).toHaveBeenCalledTimes(3);
  });

  it("re-renders the main prompt when the text step returned too few alternative prompts", async () => {
    runOpenAIStructured.mockResolvedValue({
      raw: { caption: "c", copy: "c", imagePrompt: "MAIN-PROMPT" },
    });

    const raw = completed(await run({ variantCount: 3 }));

    expect(generateCreativeImage).toHaveBeenCalledTimes(3);
    expect(raw.alternatives).toHaveLength(2);
  });

  it("uses the alternative prompts of a preset (chat-written) job too", async () => {
    const raw = completed(
      await run({
        variantCount: 2,
        preset: {
          caption: "c",
          copy: "c",
          imagePrompt: "MAIN-PROMPT",
          alternativeImagePrompts: ["ALT-PROMPT-A"],
        },
      }),
    );

    expect(runOpenAIStructured).not.toHaveBeenCalled();
    expect(generateCreativeImage).toHaveBeenCalledTimes(2);
    expect(raw.alternatives).toHaveLength(1);
  });
});

function isAltPrompt(prompt: string) {
  return prompt.includes("ALT-PROMPT");
}

describe("variants: the quality clamp", () => {
  const qualities = () =>
    generateCreativeImage.mock.calls.map(
      (c) => (c[1] as { quality?: string }).quality,
    );

  it("turns an absent quality into medium, never the provider's high default", async () => {
    await run({ variantCount: 3 });
    expect(qualities()).toEqual(["medium", "medium", "medium"]);
  });

  it("clamps an explicit high to medium", async () => {
    await run({ variantCount: 3, quality: "high" });
    expect(qualities()).toEqual(["medium", "medium", "medium"]);
  });

  it("keeps a lower quality and an invalid value falls to medium", async () => {
    await run({ variantCount: 2, quality: "low" });
    expect(qualities()).toEqual(["low", "low"]);

    generateCreativeImage.mockClear();
    await run({ variantCount: 2, quality: "ultra" });
    expect(qualities()).toEqual(["medium", "medium"]);
  });
});

describe("no variantCount: byte-identical single render", () => {
  it("makes exactly one image call, with the quality left as sent", async () => {
    const raw = completed(await run({}));

    expect(generateCreativeImage).toHaveBeenCalledTimes(1);
    expect(
      (generateCreativeImage.mock.calls[0]?.[1] as { quality?: string })
        .quality,
    ).toBeUndefined();
    expect("alternatives" in raw).toBe(false);
  });

  it("keeps an explicit high for an ordinary job", async () => {
    await run({ quality: "high" });
    expect(
      (generateCreativeImage.mock.calls[0]?.[1] as { quality?: string })
        .quality,
    ).toBe("high");
  });

  it.each([[1], [0], [4], [2.5], ["3"], [null]])(
    "treats variantCount %j as an ordinary single-image job",
    async (variantCount) => {
      const raw = completed(await run({ variantCount }));

      expect(generateCreativeImage).toHaveBeenCalledTimes(1);
      expect("alternatives" in raw).toBe(false);
    },
  );
});
