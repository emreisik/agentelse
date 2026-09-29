import { describe, expect, it } from "vitest";

import {
  CONFIRMED_AFTER,
  DEFAULT_CONFIDENCE,
  MEMORY_SOURCES,
  RELEVANT_LIMIT,
  STANDING_LIMIT,
  isConfirmed,
  memoryForPrompt,
  memorySourceOf,
  overlapCount,
  selectMemory,
  strongerSource,
  tokenize,
  tokensMatch,
  type MemoryItem,
} from "./relevance";

const NOW = new Date("2026-10-01T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

let counter = 0;
function item(overrides: Partial<MemoryItem> = {}): MemoryItem {
  counter += 1;
  return {
    id: `m${counter}`,
    text: "generic memory",
    polarity: "WORKS",
    source: "OUTPUT_ACCEPTED",
    confidence: 0.5,
    seen: 1,
    updatedAt: daysAgo(1),
    ...overrides,
  };
}

describe("tokenize", () => {
  it("lowercases, folds Turkish letters and drops short words and stopwords", () => {
    expect(tokenize("Görsel IŞIK, İZMİR için bir ve the")).toEqual([
      "gorsel",
      "isik",
      "izmir",
    ]);
  });

  it("keeps each word once", () => {
    expect(tokenize("neon neon NEON renk")).toEqual(["neon", "renk"]);
  });

  it("returns nothing for text with no usable words", () => {
    expect(tokenize("a an of ve")).toEqual([]);
    expect(tokenize("")).toEqual([]);
  });
});

describe("tokensMatch / overlapCount", () => {
  it("matches identical words", () => {
    expect(tokensMatch("neon", "neon")).toBe(true);
  });

  it("matches Turkish inflections through a shared 5-letter stem", () => {
    expect(tokensMatch("renkleri", "renklerde")).toBe(true);
    expect(tokensMatch("gorsel", "gorseller")).toBe(true);
  });

  it("does not match short words unless identical, or different stems", () => {
    expect(tokensMatch("bar", "bars")).toBe(false);
    expect(tokensMatch("premium", "pretty")).toBe(false);
  });

  it("counts each query word once when any memory word matches it", () => {
    expect(
      overlapCount(
        ["neon", "renkleri", "reklam"],
        ["neon", "renklerde", "kullanma"],
      ),
    ).toBe(2);
  });
});

describe("memorySourceOf", () => {
  it("recognises the known sources and calls everything else OTHER", () => {
    for (const source of MEMORY_SOURCES) {
      expect(memorySourceOf(source)).toBe(source);
    }
    expect(memorySourceOf("MEASUREMENT_PLAN")).toBe("OTHER");
    expect(memorySourceOf(null)).toBe("OTHER");
    expect(memorySourceOf(undefined)).toBe("OTHER");
  });
});

describe("strongerSource", () => {
  it("prefers the client's own words over corrections, outcomes and guesses", () => {
    expect(strongerSource("OUTPUT_ACCEPTED", "USER_EXPLICIT")).toBe(
      "USER_EXPLICIT",
    );
    expect(strongerSource("USER_EXPLICIT", "AI_INFERRED")).toBe(
      "USER_EXPLICIT",
    );
    expect(strongerSource("AI_INFERRED", "USER_CORRECTION")).toBe(
      "USER_CORRECTION",
    );
    expect(strongerSource("OTHER", "AI_INFERRED")).toBe("OTHER");
  });

  it("keeps the current source on a tie", () => {
    expect(strongerSource("OUTPUT_ACCEPTED", "OUTPUT_REJECTED")).toBe(
      "OUTPUT_ACCEPTED",
    );
  });
});

describe("DEFAULT_CONFIDENCE", () => {
  it("trusts the client's words far more than a single reaction or a guess", () => {
    expect(DEFAULT_CONFIDENCE.USER_EXPLICIT).toBeGreaterThan(0.9);
    expect(DEFAULT_CONFIDENCE.OUTPUT_ACCEPTED).toBeLessThan(0.7);
    expect(DEFAULT_CONFIDENCE.AI_INFERRED).toBeLessThan(
      DEFAULT_CONFIDENCE.OUTPUT_ACCEPTED,
    );
  });
});

describe("isConfirmed", () => {
  it("counts what the client said as confirmed straight away", () => {
    expect(isConfirmed({ source: "USER_EXPLICIT", seen: 1 })).toBe(true);
    expect(isConfirmed({ source: "LEGACY_DECISION", seen: 1 })).toBe(true);
  });

  it.each([
    "USER_CORRECTION",
    "OUTPUT_ACCEPTED",
    "OUTPUT_REJECTED",
    "OTHER",
  ] as const)(
    "does not count a single %s observation as confirmed, but a repeated one is",
    (source) => {
      expect(isConfirmed({ source, seen: 1 })).toBe(false);
      expect(isConfirmed({ source, seen: CONFIRMED_AFTER - 1 })).toBe(false);
      expect(isConfirmed({ source, seen: CONFIRMED_AFTER })).toBe(true);
    },
  );

  it("never counts an AI inference as confirmed, however often it was repeated", () => {
    expect(isConfirmed({ source: "AI_INFERRED", seen: 1 })).toBe(false);
    expect(isConfirmed({ source: "AI_INFERRED", seen: 50 })).toBe(false);
  });
});

describe("selectMemory", () => {
  it("always includes what the client explicitly said, even when the request shares no word with it", () => {
    const rule = item({
      text: "Never use neon colours",
      polarity: "AVOID",
      source: "USER_EXPLICIT",
    });

    const { standing, relevant } = selectMemory([rule], "make me a post", {
      now: NOW,
    });

    expect(standing).toEqual([rule]);
    expect(relevant).toEqual([]);
  });

  it("puts the newest explicit statements first and caps them", () => {
    const explicit = Array.from({ length: STANDING_LIMIT + 3 }, (_, i) =>
      item({
        text: `rule number ${i}`,
        source: "USER_EXPLICIT",
        updatedAt: daysAgo(i),
      }),
    );

    const { standing } = selectMemory(explicit, "", { now: NOW });

    expect(standing).toHaveLength(STANDING_LIMIT);
    expect(standing[0]!.text).toBe("rule number 0");
    expect(standing.at(-1)!.text).toBe(`rule number ${STANDING_LIMIT - 1}`);
  });

  it("lets an older explicit statement that missed the cap still compete on relevance", () => {
    const explicit = Array.from({ length: STANDING_LIMIT }, (_, i) =>
      item({
        text: `filler ${i}`,
        source: "USER_EXPLICIT",
        updatedAt: daysAgo(i),
      }),
    );
    const old = item({
      text: "Kampanyalarda indirim yüzdesi göster",
      source: "USER_EXPLICIT",
      updatedAt: daysAgo(400),
    });

    const { standing, relevant } = selectMemory(
      [...explicit, old],
      "kampanya için indirim postu",
      { now: NOW },
    );

    expect(standing).not.toContain(old);
    expect(relevant).toContain(old);
  });

  it("brings in other memories only when they overlap what is being asked", () => {
    const matching = item({ text: "Warm autumn photography was approved" });
    const unrelated = item({ text: "Minimal typography was approved" });

    const { relevant } = selectMemory(
      [matching, unrelated],
      "autumn photography for the sale",
      { now: NOW },
    );

    expect(relevant).toEqual([matching]);
  });

  it("matches across Turkish inflection and diacritics", () => {
    const memory = item({ text: "Sıcak tonlu görseller onaylandı" });

    const { relevant } = selectMemory([memory], "yeni görsel hazırla", {
      now: NOW,
    });

    expect(relevant).toEqual([memory]);
  });

  it("returns only the standing memories for a message with no usable words", () => {
    const explicit = item({ text: "Formal tone", source: "USER_EXPLICIT" });
    const other = item({ text: "Formal tone in emails was approved" });

    const { standing, relevant } = selectMemory([explicit, other], "ok", {
      now: NOW,
    });

    expect(standing).toEqual([explicit]);
    expect(relevant).toEqual([]);
  });

  it("does not repeat an explicit memory in both lists", () => {
    const explicit = item({
      text: "Premium editorial look",
      source: "USER_EXPLICIT",
    });

    const { standing, relevant } = selectMemory(
      [explicit],
      "premium editorial",
      {
        now: NOW,
      },
    );

    expect(standing).toEqual([explicit]);
    expect(relevant).toEqual([]);
  });

  it("ranks the better match first: more overlap, confirmed, repeated, recent", () => {
    const weak = item({ text: "Story format was approved" });
    const strong = item({
      text: "Story format with autumn photography approved",
      seen: 4,
      updatedAt: daysAgo(2),
    });

    const { relevant } = selectMemory(
      [weak, strong],
      "autumn photography story",
      { now: NOW },
    );

    expect(relevant).toEqual([strong, weak]);
  });

  it("prefers a fresh memory over an equally matching stale one", () => {
    const stale = item({
      text: "Autumn photography approved",
      updatedAt: daysAgo(200),
    });
    const fresh = item({
      text: "Autumn photography approved (again)",
      updatedAt: daysAgo(1),
    });

    const { relevant } = selectMemory([stale, fresh], "autumn photography", {
      now: NOW,
    });

    expect(relevant[0]).toBe(fresh);
  });

  it("caps the relevant list", () => {
    const many = Array.from({ length: RELEVANT_LIMIT + 5 }, (_, i) =>
      item({ text: `autumn photography variant ${i}`, seen: i + 1 }),
    );

    const { relevant } = selectMemory(many, "autumn photography", { now: NOW });

    expect(relevant).toHaveLength(RELEVANT_LIMIT);
  });

  it("honours custom limits", () => {
    const explicit = Array.from({ length: 5 }, () =>
      item({ source: "USER_EXPLICIT" }),
    );
    const others = Array.from({ length: 5 }, () =>
      item({ text: "autumn photography" }),
    );

    const { standing, relevant } = selectMemory(
      [...explicit, ...others],
      "autumn photography",
      { now: NOW, standingLimit: 2, relevantLimit: 3 },
    );

    expect(standing).toHaveLength(2);
    expect(relevant).toHaveLength(3);
  });

  it("does not modify the list it was given", () => {
    const items = [
      item({ text: "a b c", updatedAt: daysAgo(5) }),
      item({ text: "d e f", updatedAt: daysAgo(1) }),
    ];
    const before = items.map((entry) => entry.id);

    selectMemory(items, "anything", { now: NOW });

    expect(items.map((entry) => entry.id)).toEqual(before);
  });
});

describe("memoryForPrompt", () => {
  it("shows the text, marks an avoid rule and whether it is safe to state as fact", () => {
    const explicit = item({
      text: "Never use neon colours",
      polarity: "AVOID",
      source: "USER_EXPLICIT",
    });
    const hint = item({ text: "Client approved a warm autumn post", seen: 2 });

    const shown = memoryForPrompt({ standing: [explicit], relevant: [hint] });

    expect(shown).toEqual({
      standing: [{ text: "Never use neon colours", avoid: true, confirmed: true }],
      relevant: [
        { text: "Client approved a warm autumn post", confirmed: false, seen: 2 },
      ],
    });
  });

  it("omits the flags that do not apply", () => {
    const [entry] = memoryForPrompt({
      standing: [item({ source: "USER_EXPLICIT", polarity: "WORKS", seen: 1 })],
      relevant: [],
    }).standing;

    expect(entry).not.toHaveProperty("avoid");
    expect(entry).not.toHaveProperty("seen");
  });

  it("marks a repeatedly seen hint as confirmed, but never an AI guess", () => {
    const repeated = item({ source: "OUTPUT_ACCEPTED", seen: CONFIRMED_AFTER });
    const guess = item({ source: "AI_INFERRED", seen: 9 });

    const { relevant } = memoryForPrompt({
      standing: [],
      relevant: [repeated, guess],
    });

    expect(relevant.map((entry) => entry.confirmed)).toEqual([true, false]);
  });

  it("cuts a long memory", () => {
    const [entry] = memoryForPrompt({
      standing: [item({ text: "x".repeat(500), source: "USER_EXPLICIT" })],
      relevant: [],
    }).standing;

    expect(entry!.text.length).toBeLessThanOrEqual(201);
    expect(entry!.text.endsWith("…")).toBe(true);
  });
});
