import { describe, expect, it } from "vitest";

import {
  buildRulePayload,
  buildRulesJson,
  bytesChoiceLabel,
  choiceForBytes,
  formatDay,
  healthLabel,
  healthTone,
  parsePatternPreview,
  ruleProblem,
  siteHref,
  splitFormToFormData,
  usagePercent,
  type EditableRule,
  type PatternSample,
} from "./form-helpers";

const sample: PatternSample = {
  title: "Blue shoes",
  h1: "Shoes",
  site: "example.com",
  year: 2026,
};

describe("parsePatternPreview", () => {
  it("boş kalıp geçerli ve önizlemesi boş", () => {
    expect(parsePatternPreview("", sample)).toEqual({
      ok: true,
      tokens: [],
      preview: "",
      message: null,
    });
  });

  it("belirteçleri örnek değerlerle doldurur", () => {
    const result = parsePatternPreview("{title} | {site} {year}", sample);
    expect(result.ok).toBe(true);
    expect(result.tokens).toEqual(["title", "site", "year"]);
    expect(result.preview).toBe("Blue shoes | example.com 2026");
  });

  it("bilinmeyen belirteci, açık süslü parantezi ve fazla belirteci reddeder", () => {
    expect(parsePatternPreview("{price}", sample).message).toBe(
      "Unknown token {price}.",
    );
    expect(parsePatternPreview("{title", sample).ok).toBe(false);
    expect(parsePatternPreview("title}", sample).ok).toBe(false);
    expect(parsePatternPreview("{ti{title}", sample).ok).toBe(false);
    const many = parsePatternPreview("{title}{h1}{site}{year}", sample);
    expect(many.ok).toBe(false);
    expect(many.message).toContain("at most 3");
  });

  it("uzunluk sınırını aşan kalıbı reddeder", () => {
    expect(parsePatternPreview("a".repeat(71), sample, 70).ok).toBe(false);
    expect(parsePatternPreview("a".repeat(70), sample, 70).ok).toBe(true);
  });
});

describe("bytesChoiceLabel / choiceForBytes / usagePercent", () => {
  it("GB ve TB etiketleri", () => {
    expect(bytesChoiceLabel(5)).toBe("5 GB");
    expect(bytesChoiceLabel(300)).toBe("300 GB");
    expect(bytesChoiceLabel(1000)).toBe("1 TB");
    expect(bytesChoiceLabel(2000)).toBe("2 TB");
  });

  it("kayıtlı bayt değerine en yakın seçimi bulur", () => {
    const gib = 1024 ** 3;
    expect(choiceForBytes(10 * gib, [5, 10, 25, 50, 100])).toBe(10);
    expect(choiceForBytes(30 * gib, [5, 10, 25, 50, 100])).toBe(25);
    expect(choiceForBytes(0, [5, 10, 25])).toBe(5);
  });

  it("kullanım yüzdesi 0..100 aralığında kalır", () => {
    expect(usagePercent(0, 100)).toBe(0);
    expect(usagePercent(50, 200)).toBe(25);
    expect(usagePercent(500, 100)).toBe(100);
    expect(usagePercent(10, 0)).toBe(0);
    expect(usagePercent(Number.NaN, 10)).toBe(0);
  });
});

describe("formatDay", () => {
  it("gün anahtarını ve ISO değerini UTC olarak biçimler", () => {
    expect(formatDay("2026-10-07")).toBe("Oct 7, 2026");
    expect(formatDay("2026-10-07T23:30:00.000Z")).toBe("Oct 7, 2026");
    expect(formatDay(null)).toBe("-");
    expect(formatDay("not a date")).toBe("-");
  });
});

describe("splitFormToFormData", () => {
  it("sayfa gruplarını tekrarlayan alan olarak ekler, boş isteğe bağlıları atlar", () => {
    const data = splitFormToFormData({
      projectId: "p1",
      linkId: "l1",
      name: "  Title test ",
      changeKind: "TITLE_META",
      description: "",
      pageGroups: ["/blog", "/shop"],
      titlePattern: "{title} | {site}",
      metaPattern: "  ",
      schemaType: "",
      note: "",
    });
    expect(data.get("name")).toBe("Title test");
    expect(data.getAll("pageGroups")).toEqual(["/blog", "/shop"]);
    expect(data.get("titlePattern")).toBe("{title} | {site}");
    expect(data.has("description")).toBe(false);
    expect(data.has("metaPattern")).toBe(false);
    expect(data.has("schemaType")).toBe(false);
  });
});

describe("buildRulePayload / buildRulesJson", () => {
  const row = (
    key: string,
    group: string,
    pattern: string,
    match = "PREFIX",
  ): EditableRule => ({ key, group, match, pattern });

  it("tamamen boş satırları atar ve anahtarı göndermez", () => {
    const payload = buildRulePayload([
      row("a", "/blog", " /blog "),
      row("b", "", ""),
      row("c", "  ", "  "),
      row("d", "/shop", "", "GLOB"),
    ]);
    expect(payload).toEqual([
      { group: "/blog", match: "PREFIX", pattern: "/blog" },
      { group: "/shop", match: "GLOB", pattern: "" },
    ]);
    expect(JSON.parse(buildRulesJson([row("a", "/x", "/x")]))).toEqual([
      { group: "/x", match: "PREFIX", pattern: "/x" },
    ]);
  });

  it("40 kuraldan fazlasını göndermez", () => {
    const rows = Array.from({ length: 55 }, (_, i) =>
      row(`k${i}`, `/g${i}`, `/g${i}`),
    );
    expect(buildRulePayload(rows)).toHaveLength(40);
  });
});

describe("healthTone / siteHref", () => {
  it("sağlık değerlerini ton ve metne çevirir", () => {
    expect(healthTone("AUTH")).toBe("bad");
    expect(healthTone("DEGRADED")).toBe("warn");
    expect(healthTone("OK")).toBe("ok");
    expect(healthTone("UNKNOWN")).toBe("idle");
    expect(healthLabel("GONE")).toBe("Needs attention");
  });

  it("site parametresini yalnız verilince yazar, boş değerleri atar", () => {
    expect(siteHref("/p/arama", null)).toBe("/p/arama");
    expect(siteHref("/p/arama", null, { period: "28d" })).toBe(
      "/p/arama?period=28d",
    );
    expect(siteHref("/p/arama", "l2", { period: "28d", q: "" })).toBe(
      "/p/arama?site=l2&period=28d",
    );
    expect(siteHref("/p/arama", null, { site: "x" })).toBe("/p/arama");
  });
});

describe("ruleProblem", () => {
  it("boş satırı ve geçerli kuralı sorunsuz sayar", () => {
    expect(ruleProblem({ group: "", match: "PREFIX", pattern: "" })).toBeNull();
    expect(
      ruleProblem({ group: "/blog", match: "PREFIX", pattern: "/blog" }),
    ).toBeNull();
    expect(
      ruleProblem({ group: "/shop", match: "GLOB", pattern: "/shop/*/reviews" }),
    ).toBeNull();
  });

  it("açık hataları yakalar", () => {
    expect(
      ruleProblem({ group: "blog", match: "PREFIX", pattern: "/blog" }),
    ).toContain("start with /");
    expect(
      ruleProblem({ group: "/Blog", match: "PREFIX", pattern: "/blog" }),
    ).toContain("lowercase");
    expect(
      ruleProblem({ group: "/blog", match: "PREFIX", pattern: "blog" }),
    ).toContain("Patterns start");
    expect(
      ruleProblem({ group: "/blog", match: "EXACT", pattern: "/blog/*" }),
    ).toContain("pattern match type");
  });
});
