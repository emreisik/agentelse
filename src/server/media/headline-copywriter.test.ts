import { beforeEach, describe, expect, it, vi } from "vitest";

const openai = vi.hoisted(() => ({ runOpenAIStructured: vi.fn() }));
vi.mock("@/server/reasoning/openai-client", () => ({
  openaiModelForTier: () => "test-model",
  runOpenAIStructured: openai.runOpenAIStructured,
}));

import {
  buildCopywriterPrompt,
  copyContextOf,
  finishOnImageText,
  writeOnImageText,
} from "./headline-copywriter";

const budget = { maxChars: 48, minWords: 4, maxWords: 8 };

describe("copyContextOf", () => {
  it("keeps only what a writer needs, short and labelled", () => {
    const context = copyContextOf({
      language: "tr",
      positioning: "Mahalle fırını",
      toneOfVoice: "sıcak, samimi",
      targetAudiences: [{ label: "Aileler" }, "Öğrenciler"],
      approvedClaims: [{ claim: "Günlük taze üretim" }],
      negativeBrief: [{ rule: "İndirim sözü verme" }],
      brandLearnings: [{ insight: "Sorular iyi çalışıyor" }],
      recentApprovedCreatives: [
        { versions: [{ generationMetadata: { onImageText: { headline: "Sıcak ekmek geldi" } } }] },
      ],
      visualIdentity: { primaryColors: [{ hex: "#fff" }] },
      brandFacts: ["noise"],
    });
    expect(context).toMatchObject({
      language: "tr",
      audiences: ["Aileler", "Öğrenciler"],
      approvedClaims: ["Günlük taze üretim"],
      neverSay: ["İndirim sözü verme"],
      learnings: ["Sorular iyi çalışıyor"],
      recentHeadlines: ["Sıcak ekmek geldi"],
    });
    expect(context).not.toHaveProperty("visualIdentity");
    expect(context).not.toHaveProperty("brandFacts");
  });

  it("copes with an empty or odd context", () => {
    expect(copyContextOf(null)).toMatchObject({ audiences: [], recentHeadlines: [] });
    expect(copyContextOf("x")).toMatchObject({ audiences: [] });
  });
});

describe("buildCopywriterPrompt", () => {
  it("states the budget as numbers, the voice rules and the draft to improve", () => {
    const { system, user } = buildCopywriterPrompt({
      budget,
      context: { toneOfVoice: "sıcak" },
      brief: "Hafta sonu brunch menüsü",
      caption: "Brunch geri döndü",
      draft: { headline: "Brunch geri döndü", highlight: "geri döndü" },
    });
    expect(system).toContain("4-8 words and at most 48 characters");
    expect(system).toContain("Never invent prices");
    expect(system).toContain("recentHeadlines");
    expect(system).not.toContain("at most 6 words");
    expect(user).toContain("Hafta sonu brunch menüsü");
    expect(user).toContain("DRAFT TO IMPROVE");
    expect(user).toContain("sıcak");
  });
});

describe("finishOnImageText", () => {
  it("cleans quotes, hashtags, emoji and the trailing full stop", () => {
    const result = finishOnImageText(
      {
        headline: "“Pazar sofrası artık çok daha lezzetli.” #brunch 🍳",
        highlight: "çok daha lezzetli",
        subline: "Bu hafta sonu rezervasyon yap.",
        cta: "Hemen ayırt.",
      },
      budget,
    );
    expect(result).toEqual({
      headline: "Pazar sofrası artık çok daha lezzetli",
      highlight: "çok daha lezzetli",
      lines: ["Bu hafta sonu rezervasyon yap."],
      cta: "Hemen ayırt",
    });
  });

  it("drops a highlight that is not in the headline", () => {
    const result = finishOnImageText(
      { headline: "Taze ekmek her sabah", highlight: "başka" },
      budget,
    );
    expect(result).toEqual({ headline: "Taze ekmek her sabah" });
  });

  it("matches the highlight the Turkish way (İ / ı)", () => {
    const result = finishOnImageText(
      { headline: "İstanbul'un en taze simidi", highlight: "İSTANBUL" },
      budget,
    );
    expect(result?.highlight).toBe("İSTANBUL");
  });

  it("rejects a headline far past what the layout can carry, and non-headlines", () => {
    expect(finishOnImageText({ headline: "x".repeat(120) }, budget)).toBeNull();
    expect(finishOnImageText({ headline: "   " }, budget)).toBeNull();
    expect(finishOnImageText({ nope: 1 }, budget)).toBeNull();
    expect(finishOnImageText(null, budget)).toBeNull();
  });

  it("allows a little over budget: the typesetter shrinks to fit", () => {
    const slightly = "a".repeat(Math.floor(budget.maxChars * 1.2));
    expect(finishOnImageText({ headline: slightly }, budget)?.headline).toBe(slightly);
  });
});

describe("writeOnImageText", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns the finished words from the model's answer", async () => {
    openai.runOpenAIStructured.mockResolvedValue({
      raw: { headline: "Brunch masası kuruldu, sıra sizde", cta: "Yer ayırt" },
    });
    const result = await writeOnImageText({
      brandContext: { language: "tr" },
      brief: "brunch",
      budget,
    });
    expect(result).toEqual({
      headline: "Brunch masası kuruldu, sıra sizde",
      cta: "Yer ayırt",
    });
    const call = openai.runOpenAIStructured.mock.calls[0]![0];
    expect(call.model).toBe("test-model");
    expect(call.jsonSchema.properties).toHaveProperty("headline");
  });

  it("returns null instead of throwing when the model call fails", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    openai.runOpenAIStructured.mockRejectedValue(new Error("boom"));
    expect(
      await writeOnImageText({ brandContext: {}, brief: "x", budget }),
    ).toBeNull();
    quiet.mockRestore();
  });
});
