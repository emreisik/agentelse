import { describe, expect, it } from "vitest";

import {
  captionIdeaOf,
  clampHeadline,
  ideaFingerprint,
  isExpired,
  isNearDuplicate,
  parseIdeaConcept,
  socialChannelsOf,
  type SocialIdeaConcept,
} from "./concept";
import {
  normalizeSeoIdea,
  normalizeSeoIdeas,
  normalizeSocialIdea,
  normalizeSocialIdeas,
  type NormalizeContext,
} from "./normalize";
import {
  DEFAULT_FILTERS,
  boardStatusOf,
  countByStatus,
  filterIdeas,
  sortIdeas,
  type BoardIdea,
} from "./board";

const SOCIAL: SocialIdeaConcept = {
  v: 2,
  module: "social",
  source: "season",
  why: "Autumn starts this week.",
  strength: 3,
  draft: {
    hook: "Five new cups for colder mornings",
    headline: "The autumn menu is here",
    highlight: "autumn menu",
    visual: "A maple oat latte on a wooden bar, morning light",
    caption:
      "Maple oat latte, cardamom cortado and more. Come try them Thursday.",
    channels: ["instagram", "facebook"],
    formatKey: "instagram.post",
    layoutId: "headline-top",
    pillar: "Product",
  },
};

describe("typed idea concepts", () => {
  it("reads a v2 concept and leaves an older one untyped", () => {
    expect(parseIdeaConcept(SOCIAL)?.module).toBe("social");
    expect(
      parseIdeaConcept({
        bigIdea: "x",
        executionSketch: "y",
        departmentsInvolved: [],
      }),
    ).toBeNull();
    expect(parseIdeaConcept(null)).toBeNull();
  });

  it("keeps the words on the picture to six, without a full stop", () => {
    expect(clampHeadline("One two three four five six seven eight.")).toBe(
      "One two three four five six",
    );
    expect(clampHeadline("Hello there.")).toBe("Hello there");
  });

  it("writes the planner's captionIdea: quoted headline | scene | caption", () => {
    expect(captionIdeaOf(SOCIAL.draft)).toBe(
      `"The autumn menu is here" | ${SOCIAL.draft.visual} | ${SOCIAL.draft.caption}`,
    );
  });

  it("fingerprints by module and folded hook words", () => {
    expect(ideaFingerprint(SOCIAL)).toBe(
      "social:five new cups for colder mornings",
    );
  });

  it("sees a reworded repeat as the same idea, a different one as new", () => {
    expect(
      isNearDuplicate("Five new cups for the colder mornings", [
        SOCIAL.draft.hook,
      ]),
    ).toBe(true);
    expect(
      isNearDuplicate("Meet the barista behind your morning cup", [
        SOCIAL.draft.hook,
      ]),
    ).toBe(false);
  });

  it("expires on its date, never on an unreadable one", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    expect(
      isExpired({ ...SOCIAL, expiresAt: "2026-10-09T20:59:00.000Z" }, now),
    ).toBe(true);
    expect(
      isExpired({ ...SOCIAL, expiresAt: "2026-10-31T20:59:00.000Z" }, now),
    ).toBe(false);
    expect(isExpired({ ...SOCIAL, expiresAt: "soon" }, now)).toBe(false);
  });

  it("keeps social channels only, in catalogue order, within the allowed ones", () => {
    expect(socialChannelsOf(["facebook", "seo", "instagram"])).toEqual([
      "instagram",
      "facebook",
    ]);
    expect(socialChannelsOf(["facebook", "instagram"], ["instagram"])).toEqual([
      "instagram",
    ]);
  });
});

const CTX: NormalizeContext = {
  channels: ["instagram", "facebook"],
  layoutIds: ["classic", "headline-top"],
  signals: [
    { title: "Pumpkin spice is trending", url: "https://example.com/trend" },
  ],
  today: "2026-10-06",
  timezone: "Europe/Istanbul",
};

const RAW = {
  hook: "Five new cups for colder mornings",
  headline: "The autumn menu is here, finally, for everyone",
  highlight: "autumn menu",
  visual: "A maple oat latte on a wooden bar",
  caption: "Come try them Thursday.",
  channels: ["instagram", "tiktok"],
  format: "carousel",
  layoutId: "headline-top",
  source: "trend",
  why: "Pumpkin season.",
  strength: 5,
  expiresOn: "2026-10-31",
  signal: 1,
};

describe("normalizing the model's post ideas", () => {
  it("cleans, bounds and checks every field against the brand", () => {
    const concept = normalizeSocialIdea(RAW, CTX)!;
    expect(concept.module).toBe("social");
    expect(concept.draft.headline).toBe("The autumn menu is here, finally");
    expect(concept.draft.highlight).toBe("autumn menu");
    // TikTok is not one of the brand's channels.
    expect(concept.draft.channels).toEqual(["instagram"]);
    expect(concept.draft.formatKey).toBe("instagram.carousel");
    expect(concept.draft.layoutId).toBe("headline-top");
    expect(concept.strength).toBe(3);
    expect(concept.source).toBe("trend");
    expect(concept.expiresAt).toBeDefined();
    // The link comes from the server's signal, never from the model.
    expect(concept.evidence).toEqual([
      { title: "Pumpkin spice is trending", url: "https://example.com/trend" },
    ]);
  });

  it("drops an unknown layout, a highlight not in the headline and a far expiry", () => {
    const concept = normalizeSocialIdea(
      {
        ...RAW,
        layoutId: "made-up",
        highlight: "pumpkin",
        expiresOn: "2027-12-31",
      },
      CTX,
    )!;
    expect(concept.draft.layoutId).toBeUndefined();
    expect(concept.draft.highlight).toBeUndefined();
    expect(concept.expiresAt).toBeUndefined();
  });

  it("drops an idea missing what a post needs", () => {
    expect(normalizeSocialIdea({ ...RAW, visual: "" }, CTX)).toBeNull();
    expect(normalizeSocialIdea({ ...RAW, caption: "   " }, CTX)).toBeNull();
  });

  it("falls back to the brand's first channel and its plain post", () => {
    const concept = normalizeSocialIdea(
      { ...RAW, channels: ["x-y"], format: "reel" },
      CTX,
    )!;
    expect(concept.draft.channels).toEqual(["instagram"]);
    expect(concept.draft.formatKey).toBe("instagram.post");
  });

  it("keeps no repeat of the pool, a recent post or itself", () => {
    const kept = normalizeSocialIdeas(
      [
        RAW,
        { ...RAW, hook: "Five new cups for the colder mornings" },
        { ...RAW, hook: "Meet the barista behind your morning cup" },
        { ...RAW, hook: "Our oat milk, explained in one minute" },
      ],
      { ...CTX, avoid: ["Our oat milk explained in a minute"] },
    );
    expect(kept.map((concept) => concept.draft.hook)).toEqual([
      "Five new cups for colder mornings",
      "Meet the barista behind your morning cup",
    ]);
  });
});

describe("normalizing the model's article ideas", () => {
  const SEO = {
    keyword: "  oat milk latte  ",
    intent: "Commercial",
    title: "Oat milk latte: how we make ours",
    description: "The beans, the milk and the steam, step by step.",
    angle: "From the people who pour a thousand a week.",
    source: "search",
    strength: 9,
  };

  it("cleans the fields and falls back on an unknown intent", () => {
    const concept = normalizeSeoIdea(SEO)!;
    expect(concept.module).toBe("seo");
    expect(concept.draft.keyword).toBe("oat milk latte");
    expect(concept.draft.intent).toBe("commercial");
    expect(concept.strength).toBe(3);
    expect(concept.source).toBe("search");
    expect(normalizeSeoIdea({ ...SEO, intent: "curious" })!.draft.intent).toBe(
      "informational",
    );
    expect(normalizeSeoIdea({ ...SEO, angle: " " })).toBeNull();
  });

  it("keeps no repeat of an article, the pool or itself", () => {
    const kept = normalizeSeoIdeas(
      [SEO, { ...SEO, keyword: "Oat milk latte" }, { ...SEO, keyword: "cold brew at home" }],
      ["best oat milk latte"],
    );
    expect(kept.map((concept) => concept.draft.keyword)).toEqual([
      "cold brew at home",
    ]);
  });
});

function idea(id: string, extra: Partial<BoardIdea>): BoardIdea {
  return {
    id,
    status: "VALIDATED",
    createdAt: "2026-10-01T10:00:00.000Z",
    title: id,
    description: "",
    concept: SOCIAL,
    ...extra,
  };
}

describe("the board's tabs, filters and order", () => {
  const now = new Date("2026-10-06T10:00:00Z");
  const ideas = [
    idea("fresh", {}),
    idea("saved", { status: "APPROVED" }),
    idea("planned", { status: "MEASURING" }),
    idea("done", { status: "LEARNED" }),
    idea("archived", { status: "REJECTED" }),
    idea("expired", {
      concept: { ...SOCIAL, expiresAt: "2026-10-01T00:00:00.000Z" },
    }),
    idea("older", { concept: null, status: "SHORTLISTED" }),
  ];

  it("puts each idea in one tab; expired ones under Archived", () => {
    expect(boardStatusOf(ideas[0]!, now)).toBe("fresh");
    expect(boardStatusOf(ideas[1]!, now)).toBe("saved");
    expect(boardStatusOf(ideas[2]!, now)).toBe("planned");
    expect(boardStatusOf(ideas[3]!, now)).toBe("done");
    expect(boardStatusOf(ideas[5]!, now)).toBe("expired");
    expect(countByStatus(ideas, now)).toMatchObject({
      fresh: 2,
      saved: 1,
      archived: 2,
    });
    expect(
      filterIdeas(ideas, { ...DEFAULT_FILTERS, status: "archived" }, now).map(
        (i) => i.id,
      ),
    ).toEqual(["archived", "expired"]);
  });

  it("filters by module, source, channel and words", () => {
    const fresh = { ...DEFAULT_FILTERS, status: "fresh" as const };
    expect(
      filterIdeas(ideas, { ...fresh, module: "untyped" }, now).map((i) => i.id),
    ).toEqual(["older"]);
    expect(filterIdeas(ideas, { ...fresh, source: "trend" }, now)).toEqual([]);
    expect(
      filterIdeas(ideas, { ...fresh, channel: "facebook" }, now).map(
        (i) => i.id,
      ),
    ).toEqual(["fresh"]);
    expect(
      filterIdeas(ideas, { ...fresh, query: "MAPLE" }, now).map((i) => i.id),
    ).toEqual(["fresh"]);
  });

  it("sorts saved first, then typed by strength, older ideas last", () => {
    const weak = idea("weak", {
      concept: { ...SOCIAL, strength: 1 },
      createdAt: "2026-10-05T10:00:00.000Z",
    });
    const order = sortIdeas(
      [ideas[6]!, weak, ideas[0]!, ideas[1]!],
      "best",
    ).map((i) => i.id);
    expect(order).toEqual(["saved", "fresh", "weak", "older"]);
  });
});
