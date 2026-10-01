import { describe, expect, it } from "vitest";

import { GUARDRAILS } from "@/lib/guided-setup/contract";
import {
  PRESET_DETECTORS,
  PRESET_RULE_LABELS,
  type PresetId,
} from "@/lib/works/brand-rule-lexicons";
import {
  MAX_RULE_ECHO,
  blocksOf,
  brandCheckOf,
  brandRepairMessage,
  checkItems,
  checkText,
  flagsForItem,
  ruleTermsOf,
  type BrandRule,
  type BrandRuleOrigin,
  type BrandRuleSet,
  type ItemFlag,
} from "@/lib/works/brand-rules";

function set(
  never: (string | BrandRule)[],
  extra: Partial<BrandRuleSet> = {},
): BrandRuleSet {
  return {
    language: "tr",
    never: never.map((rule) =>
      typeof rule === "string"
        ? { text: rule, origin: "client-rule" as BrandRuleOrigin }
        : rule,
    ),
    approvedClaims: [],
    competitors: [],
    ...extra,
  };
}

function preset(id: PresetId, extra: Partial<BrandRuleSet> = {}) {
  return set([PRESET_RULE_LABELS[id]], extra);
}

const rule = (text: string, origin: BrandRuleOrigin): BrandRule => ({
  text,
  origin,
});

describe("preset labels", () => {
  it("are built from the guided guardrails", () => {
    for (const option of GUARDRAILS) {
      const id = option.id.replace("guardrail.", "") as PresetId;
      expect(PRESET_RULE_LABELS[id]).toBe(option.label);
    }
  });
});

describe("ruleTermsOf", () => {
  it("reads a short rule as a term list", () => {
    expect(ruleTermsOf(rule("kesin garanti", "client-rule"))).toEqual([
      "kesin garanti",
    ]);
    expect(
      ruleTermsOf(rule("cheap, free, bargain", "forbidden-claim")),
    ).toEqual(["cheap", "free", "bargain"]);
  });

  it("reads a sentence rule through its quoted spans only", () => {
    expect(
      ruleTermsOf(
        rule('Never say "cheap" or “bargain” to clients', "negative-brief"),
      ),
    ).toEqual(["cheap", "bargain"]);
    expect(
      ruleTermsOf(rule("Asla 'ucuz' kelimesini kullanma", "client-rule")),
    ).toEqual(["ucuz"]);
    expect(
      ruleTermsOf(rule("Nemoj reći «jeftino» nikada", "client-rule")),
    ).toEqual(["jeftino"]);
    expect(
      ruleTermsOf(rule("Nie mów „tanio” klientom", "client-rule")),
    ).toEqual(["tanio"]);
  });

  it("gives a sentence without quotes no terms", () => {
    expect(
      ruleTermsOf(rule("Never state prices or discounts", "client-rule")),
    ).toEqual([]);
    expect(
      ruleTermsOf(rule("Do not misrepresent pricing", "negative-brief")),
    ).toEqual([]);
    expect(ruleTermsOf(rule("Don't say free", "negative-brief"))).toEqual([]);
  });

  it("does not read an apostrophe as a quote", () => {
    expect(
      ruleTermsOf(
        rule("Don't ever say 'free' or it's over for us", "client-rule"),
      ),
    ).toEqual(["free"]);
  });

  it("lets a memory rule contribute quoted spans only", () => {
    expect(ruleTermsOf(rule("ucuz", "memory"))).toEqual([]);
    expect(ruleTermsOf(rule('avoid "ucuz"', "memory"))).toEqual(["ucuz"]);
  });
});

describe("checkText: literal terms and quoted spans", () => {
  it("blocks a literal term and echoes the wording as written", () => {
    const flags = checkText(
      "Bu hafta KESİN GARANTİ veriyoruz",
      set(["kesin garanti"]),
    );
    expect(flags).toEqual([
      {
        kind: "never-term",
        severity: "block",
        matched: "KESİN GARANTİ",
        rule: "kesin garanti",
      },
    ]);
  });

  it("blocks a quoted span of a sentence rule", () => {
    const flags = checkText(
      "Ucuz ve hızlı",
      set(['Never say "ucuz" about our service']),
    );
    expect(blocksOf(flags)).toHaveLength(1);
    expect(flags[0]?.matched).toBe("Ucuz");
  });

  it("matches across punctuation and an apostrophe suffix (Botoks'u)", () => {
    const flags = checkText("Botoks'u artık herkes biliyor", set(["botoks"]));
    expect(flags[0]?.matched).toBe("Botoks");
    expect(checkText("Botoks, filler ve lazer", set(["botoks"]))).toHaveLength(
      1,
    );
  });

  it("folds Turkish letters: İNDİRİM, ışık, çocuğu / çocuk, kitabı / kitap", () => {
    expect(checkText("İNDİRİM başladı", set(["indirim"]))).toHaveLength(1);
    expect(checkText("INDIRIM basladi", set(["İndirim"]))).toHaveLength(1);
    expect(checkText("Işık ve gölge", set(["ışık"]))).toHaveLength(1);
    expect(checkText("Çocuğu için", set(["çocuk"]))).toHaveLength(1);
    expect(checkText("Çocuklar için", set(["çocuk"]))).toHaveLength(1);
    expect(checkText("Kitabı okuyun", set(["kitap"]))).toHaveLength(1);
    expect(checkText("Kitaplar burada", set(["kitap"]))).toHaveLength(1);
  });

  it("uses word boundaries: hasta does not hit hastane", () => {
    const rules = set(["hasta"]);
    expect(checkText("Yeni hastane açıldı", rules)).toEqual([]);
    expect(checkText("Hasta ziyareti", rules)).toHaveLength(1);
    expect(checkText("Hastalar ve hastaya", rules)).toHaveLength(1);
  });

  it("matches a short term exactly only", () => {
    expect(checkText("zaman geçiyor", set(["zam"]))).toEqual([]);
    expect(checkText("Zam geldi", set(["zam"]))).toHaveLength(1);
  });

  it("matches English inflections but not other words", () => {
    const rules = set(["cheap"], { language: "en" });
    expect(checkText("Cheaper than ever", rules)).toHaveLength(1);
    expect(checkText("Cheapskate deals", rules)).toEqual([]);
    expect(checkText("A cheap trick", rules)).toHaveLength(1);
    expect(
      checkText("Heal fast", set(["heal"], { language: "en" })),
    ).toHaveLength(1);
    expect(
      checkText("Healing hands", set(["heal"], { language: "en" })),
    ).toHaveLength(1);
    expect(
      checkText("Healthy food", set(["heal"], { language: "en" })),
    ).toEqual([]);
  });

  it("matches a Cyrillic term, with prefix matching for a non-Latin script", () => {
    const rules = set(["скидка"], { language: "ru" });
    expect(checkText("Большая СКИДКА сегодня", rules)).toHaveLength(1);
    expect(
      checkText("Только со скидками", set(["скидк"], { language: "ru" })),
    ).toHaveLength(1);
    expect(checkText("Просто текст", rules)).toEqual([]);
  });

  it("matches Arabic by substring after the fold", () => {
    expect(
      checkText("عرض خصم كبير", set(["خصم"], { language: "ar" })),
    ).toHaveLength(1);
  });

  it("matches symbol terms with boundaries", () => {
    const rules = set(["#1"], { language: "en" });
    const flags = checkText("We are #1 in town", rules);
    expect(flags.map((flag) => flag.kind)).toEqual(["never-term", "absolute"]);
    expect(checkText("Item 21 of 100", rules)).toEqual([]);
  });

  it("uses prefix matching for a language other than tr and en", () => {
    const rules = set(["jeftin"], { language: "hr" });
    expect(checkText("Jeftino i brzo", rules)).toHaveLength(1);
  });
});

describe("checkText: presets", () => {
  const cases: [PresetId, string, string, string][] = [
    [
      "no_prices",
      "Bu ay %40 indirim var",
      "Bugün ücretsiz deneme",
      "Get 50% off our sale",
    ],
    [
      "no_guarantees",
      "Kesin sonuç garantili",
      "Risksiz başlangıç",
      "Guaranteed results, risk-free",
    ],
    [
      "no_health",
      "Kanseri tedavi eder",
      "Ağrısız ameliyatsız çözüm",
      "Cure your pain, no cancer",
    ],
    [
      "no_politics",
      "Seçim sonuçları üzerine",
      "Cumhurbaşkanı konuştu",
      "The election and religion",
    ],
    ["no_slang", "Amk ne güzel", "Salak iş", "This is bullshit, wtf"],
  ];

  it.each(cases)("%s fires in Turkish and English", (id, tr1, tr2, en) => {
    const rules = preset(id);
    for (const text of [tr1, tr2, en]) {
      const flags = checkText(text, rules);
      expect(flags.length, text).toBeGreaterThan(0);
      expect(flags.every((flag) => flag.kind === "preset")).toBe(true);
      expect(flags[0]?.rule).toBe(PRESET_RULE_LABELS[id]);
    }
  });

  it("fires no_competitors with the competitors of the rule set only", () => {
    const rules = preset("no_competitors", {
      competitors: ["Acme Corp", "Beta"],
    });
    const flags = checkText("Acme Corp'tan daha iyisi", rules);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      kind: "preset",
      severity: "block",
      matched: "Acme Corp",
    });
    expect(checkText("Acmeist plans", rules)).toEqual([]);
    expect(checkText("Hiçbir isim yok", preset("no_competitors"))).toEqual([]);
  });

  it("is not active unless the exact label is a rule", () => {
    const flags = checkText("%40 indirim", set(["Never state something else"]));
    expect(flags.some((flag) => flag.kind === "preset")).toBe(false);
    // punctuation and case of the stored label do not matter
    expect(
      checkText("%40 indirim", set(["never state prices or discounts."])),
    ).not.toHaveLength(0);
  });

  it("recognises price figures", () => {
    const rules = preset("no_prices");
    for (const text of [
      "Sadece ₺500",
      "Just $9",
      "50€ den başlayan",
      "199 TL",
      "100 liradan",
      "20% off",
      "%20 off",
    ]) {
      expect(blocksOf(checkText(text, rules)).length, text).toBeGreaterThan(0);
    }
    expect(checkText("Yeni koleksiyon geldi", rules)).toEqual([]);
  });

  it("recognises inflected lexicon words (iyileşme, iyileştirir)", () => {
    const rules = preset("no_health");
    expect(checkText("Hızlı iyileşme", rules)).toHaveLength(1);
    expect(checkText("Cildi iyileştirir", rules)).toHaveLength(1);
  });

  it("severity: tight lexicons block, heuristics warn", () => {
    const severity = (id: PresetId, text: string) =>
      checkText(text, preset(id))[0]?.severity;
    expect(severity("no_prices", "indirim")).toBe("block");
    expect(severity("no_guarantees", "garanti")).toBe("block");
    expect(severity("no_health", "tedavi")).toBe("block");
    expect(severity("no_politics", "seçim")).toBe("warn");
    expect(severity("no_slang", "amk")).toBe("warn");
    expect(severity("no_slang", "Harika 🎉")).toBe("block");
    expect(PRESET_DETECTORS.no_competitors.severity).toBe("block");
  });

  it("flags an emoji but not (c) (R) or TM", () => {
    const rules = preset("no_slang");
    expect(checkText("Merhaba 😀", rules)[0]).toMatchObject({
      kind: "preset",
      severity: "block",
      matched: "😀",
    });
    expect(checkText("Acme® ve Beta™ © 2026", rules)).toEqual([]);
  });

  it("uses only the English lexicon outside Turkish projects", () => {
    expect(
      checkText("indirim", preset("no_prices", { language: "en" })),
    ).toEqual([]);
    expect(
      checkText("discount", preset("no_prices", { language: "en" })),
    ).toHaveLength(1);
  });
});

describe("checkText: figures and absolutes", () => {
  const rules = set(["kesin garanti"]);

  it("warns on a figure that is not an approved claim", () => {
    const flags = checkText("Sadece 250 TL ye", rules);
    expect(flags).toEqual([
      { kind: "figure", severity: "warn", matched: "250 TL" },
    ]);
  });

  it("accepts a figure found in approvedClaims, digit-normalised", () => {
    const approved = set(["kesin garanti"], {
      approvedClaims: ["Starting at 1.000 TL", "Save 20% on annual plans"],
    });
    expect(checkText("Fiyat 1,000 TL", approved)).toEqual([]);
    expect(checkText("Fiyat 1 000 TL", approved)).toEqual([]);
    expect(checkText("Fiyat 1.000 TL", approved)).toEqual([]);
    expect(checkText("%20 tasarruf", approved)).toEqual([]);
    expect(checkText("%30 tasarruf", approved)).toHaveLength(1);
    expect(checkText("Fiyat 2.000 TL", approved)).toHaveLength(1);
  });

  it("does not repeat a figure the no_prices preset already flagged", () => {
    const both = set([PRESET_RULE_LABELS.no_prices]);
    const flags = checkText("Sadece 250 TL", both);
    expect(flags.every((flag) => flag.kind === "preset")).toBe(true);
  });

  it("warns on absolute wording", () => {
    const flags = checkText("Türkiye'nin en iyi kahvesi, bir numara", rules);
    expect(
      flags.map((flag) => [flag.kind, flag.severity, flag.matched]),
    ).toEqual([
      ["absolute", "warn", "en iyi"],
      ["absolute", "warn", "bir numara"],
    ]);
    expect(
      checkText("We are #1", set(["x1"], { language: "en" }))[0],
    ).toMatchObject({
      kind: "absolute",
      matched: "#1",
    });
    expect(blocksOf(flags)).toEqual([]);
  });
});

describe("fail open", () => {
  it("returns nothing for a null or empty rule set", () => {
    expect(checkText("kesin garanti %40", null)).toEqual([]);
    expect(checkText("kesin garanti %40", undefined)).toEqual([]);
    expect(checkText("kesin garanti %40", set([]))).toEqual([]);
    expect(
      checkText(
        "%40 indirim en iyi",
        set([], { approvedClaims: ["a"], competitors: ["Acme"] }),
      ),
    ).toEqual([]);
    expect(checkItems([{ topic: "garanti" }], null)).toEqual([]);
    expect(checkItems([{ topic: "garanti" }], set([]))).toEqual([]);
  });

  it("returns nothing for empty text", () => {
    expect(checkText("", set(["garanti"]))).toEqual([]);
    expect(checkText("   ", set(["garanti"]))).toEqual([]);
  });
});

describe("checkItems, flagsForItem, blocksOf", () => {
  const rules = set(["garanti"]);
  const items = [
    { topic: "Hafta başı", captionIdea: "Merhaba" },
    { topic: "Garanti belgesi", captionIdea: "Yine garanti, en iyi" },
    { topic: null, captionIdea: undefined },
  ];

  it("flags per item and field", () => {
    const hits = checkItems(items, rules);
    expect(hits.map((hit) => [hit.index, hit.field, hit.flag.kind])).toEqual([
      [1, "topic", "never-term"],
      [1, "captionIdea", "never-term"],
      [1, "captionIdea", "absolute"],
    ]);
  });

  it("dedupes by kind and wording for one item", () => {
    const hits = checkItems(items, rules);
    expect(flagsForItem(hits, 1).map((flag) => flag.kind)).toEqual([
      "never-term",
      "absolute",
    ]);
    expect(flagsForItem(hits, 0)).toEqual([]);
  });

  it("blocksOf keeps blocks only, for items and for flags", () => {
    const hits = checkItems(items, rules);
    expect(blocksOf(hits)).toHaveLength(2);
    expect(blocksOf(hits.map((hit) => hit.flag))).toHaveLength(2);
    expect(blocksOf(null)).toEqual([]);
  });
});

describe("brandCheckOf", () => {
  it("reports skipped only when the rules could not be loaded", () => {
    expect(brandCheckOf(null)).toEqual({ state: "skipped" });
    expect(brandCheckOf(undefined)).toEqual({ state: "skipped" });
  });

  it("a loaded set without rules is a real check of zero rules, not a failure", () => {
    expect(brandCheckOf(set([]))).toEqual({ state: "checked", rules: 0 });
    expect(brandCheckOf(set([], { approvedClaims: ["x"] }))).toEqual({
      state: "checked",
      rules: 0,
    });
  });

  it("reports the number of rules when checked", () => {
    expect(
      brandCheckOf(
        set(["garanti", PRESET_RULE_LABELS.no_prices, 'Never say "x"']),
      ),
    ).toEqual({ state: "checked", rules: 3 });
  });
});

describe("brandRepairMessage", () => {
  const describeItem = (index: number) =>
    `Item ${index + 1} (2026-10-05, instagram.post)`;
  const block = (
    index: number,
    matched: string,
    ruleText?: string,
  ): ItemFlag => ({
    index,
    field: "captionIdea",
    flag: { kind: "never-term", severity: "block", matched, rule: ruleText },
  });

  it("returns null without a block", () => {
    expect(
      brandRepairMessage([], describeItem, "propose_content_plan"),
    ).toBeNull();
    const warn: ItemFlag = {
      index: 0,
      field: "topic",
      flag: { kind: "absolute", severity: "warn", matched: "best" },
    };
    expect(
      brandRepairMessage([warn], describeItem, "propose_content_plan"),
    ).toBeNull();
  });

  it("builds the aggregated message with the default closing", () => {
    const hits = checkItems(
      [{ topic: "x" }, { topic: "x" }, { captionIdea: "kesin garanti" }],
      set(["garanti"]),
    );
    const message = brandRepairMessage(
      hits,
      describeItem,
      "propose_content_plan",
    );
    expect(message).toBe(
      [
        "Brand rules: the plan breaks 1 rule.",
        '- Item 3 (2026-10-05, instagram.post), captionIdea: contains "garanti", against the brand rule "garanti".',
        "Rewrite only those fields without the flagged wording (keep date, time, channel and formatKey of every item), then call propose_content_plan again with the FULL plan. If the client themselves asked for this wording, do not repeat the plan: tell them the brand rule blocks it and ask whether to change the rule.",
      ].join("\n"),
    );
  });

  it("replaces the whole closing when options.closing is given", () => {
    const closing =
      "Rewrite the caption, headline and copy without the flagged wording, then call generate_image again with the same design. If the client themselves asked for this wording, tell them the brand rule blocks it.";
    const message = brandRepairMessage(
      [block(0, "garanti", "garanti")],
      describeItem,
      "generate_image",
      { closing },
    );
    expect(message?.split("\n").at(-1)).toBe(closing);
    expect(message).not.toContain("FULL plan");
    expect(message).not.toContain("propose_content_plan");
  });

  it("clips the rule echo to 120 characters and keeps one line per hit", () => {
    const longRule = `Never say "garanti" ${"x ".repeat(100)}\nsecond "line"`;
    const message =
      brandRepairMessage([block(0, "garanti", longRule)], describeItem, "t") ??
      "";
    const line = message.split("\n")[1] ?? "";
    const echoed = /against the brand rule "(.*)"\.$/.exec(line)?.[1] ?? "";
    expect(echoed.length).toBeLessThanOrEqual(MAX_RULE_ECHO);
    expect(echoed.endsWith("…")).toBe(true);
    expect(line).not.toContain("\n");
    expect(message.split("\n")).toHaveLength(3);
  });

  it("caps the listed hits at 5 lines", () => {
    const hits = Array.from({ length: 9 }, (_, index) =>
      block(index, `w${index}`, `rule ${index}`),
    );
    const message =
      brandRepairMessage(hits, describeItem, "propose_content_plan") ?? "";
    const lines = message.split("\n");
    expect(lines[0]).toBe("Brand rules: the plan breaks 9 rules.");
    expect(lines.filter((line) => line.startsWith("- "))).toHaveLength(5);
    expect(lines).toHaveLength(1 + 5 + 1);
  });

  it("does not echo hits that only warn", () => {
    const warn: ItemFlag = {
      index: 4,
      field: "topic",
      flag: { kind: "figure", severity: "warn", matched: "%50" },
    };
    const message =
      brandRepairMessage(
        [block(0, "garanti", "garanti"), warn],
        describeItem,
        "t",
      ) ?? "";
    expect(message).not.toContain("%50");
  });
});
