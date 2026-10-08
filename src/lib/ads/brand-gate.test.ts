import { describe, expect, it } from "vitest";

import { adTextsOf, literalRuleHits } from "./brand-gate";
import type { AdsLaunchSpec } from "./launch-spec";

function specWith(ads: Partial<AdsLaunchSpec["ads"][number]["creative"]>[]): AdsLaunchSpec {
  return {
    ads: ads.map((creative) => ({
      name: "Ad",
      adSetIndex: 0,
      creative: {
        imageAssetId: "a",
        message: "Merhaba",
        link: "https://x.test",
        callToAction: "LEARN_MORE",
        ...creative,
      },
      urlTags: "",
    })),
  } as unknown as AdsLaunchSpec;
}

describe("adTextsOf", () => {
  it("collects the message, the headline and every card's words", () => {
    const texts = adTextsOf(
      specWith([
        {
          message: "Ana metin",
          headline: "Başlık",
          cards: [
            { imageAssetId: "1", link: "https://x.test", headline: "Kart 1", description: "Açıklama 1" },
            { imageAssetId: "2", link: "https://x.test" },
          ],
        },
      ]),
    );
    expect(texts.map((t) => t.field)).toEqual([
      "ads.0.creative.message",
      "ads.0.creative.headline",
      "ads.0.creative.cards.0.headline",
      "ads.0.creative.cards.0.description",
    ]);
  });

  it("skips empty texts", () => {
    expect(adTextsOf(specWith([{ message: "   " }]))).toEqual([]);
  });
});

describe("literalRuleHits", () => {
  const texts = [
    { field: "ads.0.creative.message", text: "Garantili Sonuç için hemen yazın!" },
    { field: "ads.1.creative.message", text: "Yeni sezon geldi" },
  ];

  it("matches a short rule phrase without caring about case or accents", () => {
    expect(literalRuleHits(texts, ["garantili sonuc"])).toEqual([
      { field: "ads.0.creative.message", rule: "garantili sonuc" },
    ]);
  });

  it("matches on word boundaries only", () => {
    expect(literalRuleHits([{ field: "f", text: "Bu bir test" }], ["tes"])).toEqual([]);
    expect(literalRuleHits([{ field: "f", text: "Sınırsız indirim" }], ["indirim"])).toHaveLength(1);
  });

  it("leaves long sentence rules to the model", () => {
    expect(
      literalRuleHits(texts, ["Asla garantili sonuç vaat etme ve rakipleri kötüleme"]),
    ).toEqual([]);
  });

  it("ignores rules that are too short to be a phrase", () => {
    expect(literalRuleHits(texts, ["ve", "ab"])).toEqual([]);
  });
});
