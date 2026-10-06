import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildBrandKit } from "@/lib/brand-kit";
import type { BoardIdea } from "@/lib/ideas/board";
import { buildPresetLayouts } from "@/lib/layout-templates";
import { IDEAS_COPY } from "./copy";
import { IdeaCardView, type IdeaCardContext } from "./idea-card";

const base = buildBrandKit({
  legacyColors: [],
  fonts: ["Inter"],
  logoAssetId: "logo-light",
  darkLogoAssetId: "logo-dark",
  identity: null,
});
const kit = { ...base, layouts: buildPresetLayouts(base.template) };

const ctx: IdeaCardContext = {
  kit,
  brandName: "Mira Coffee",
  handle: "@miracoffee",
  timezone: "Europe/Istanbul",
  now: new Date("2026-10-06T10:00:00Z"),
};

const handlers = {
  onOpen: () => {},
  onMake: () => {},
  onSave: () => {},
  onWriteArticle: () => {},
  onBoost: () => {},
  onConvert: () => {},
};

function card(idea: BoardIdea): string {
  return renderToStaticMarkup(
    createElement(IdeaCardView, { idea, ctx, handlers }),
  );
}

const at = "2026-10-05T10:00:00.000Z";

describe("idea cards look like what they become", () => {
  it("a post idea is the post: account, the words on the picture, hook, caption", () => {
    const html = card({
      id: "i1",
      status: "VALIDATED",
      createdAt: at,
      title: "Five new cups for colder mornings",
      description: "Come try them Thursday.",
      concept: {
        v: 2,
        module: "social",
        source: "season",
        strength: 3,
        why: "Autumn starts this week.",
        draft: {
          hook: "Five new cups for colder mornings",
          headline: "The autumn menu is here",
          visual: "A latte on a wooden bar",
          caption: "Come try them Thursday.",
          channels: ["instagram", "facebook"],
          formatKey: "instagram.post",
          layoutId: "headline-top",
        },
      },
    });
    expect(html).toContain('data-module="social"');
    expect(html).toContain("@miracoffee");
    expect(html).toContain('data-part="headline-text"');
    expect(html).toContain("The autumn menu is here");
    expect(html).toContain("Five new cups for colder mornings");
    expect(html).toContain("A latte on a wooden bar");
    // The Instagram post's real 3:4 shape.
    expect(html).toContain("aspect-ratio:0.75");
    expect(html).toContain(IDEAS_COPY.make);
    expect(html).toContain(IDEAS_COPY.strong);
    expect(html).toContain(IDEAS_COPY.source.season);
  });

  it("a planned post idea shows where it went instead of Make this post", () => {
    const html = card({
      id: "i2",
      status: "MEASURING",
      createdAt: at,
      title: "x",
      description: "y",
      link: { workId: "w1", scheduledFor: "2026-10-08T06:00:00.000Z" },
      concept: {
        v: 2,
        module: "social",
        source: "brand",
        draft: {
          hook: "x hook",
          headline: "x",
          visual: "y",
          caption: "z",
          channels: ["instagram"],
        },
      },
    });
    expect(html).toContain("Planned");
    expect(html).not.toContain(IDEAS_COPY.make);
  });

  it("an article idea is its search result", () => {
    const html = card({
      id: "i3",
      status: "VALIDATED",
      createdAt: at,
      title: "t",
      description: "d",
      concept: {
        v: 2,
        module: "seo",
        source: "search",
        draft: {
          keyword: "oat milk latte",
          intent: "informational",
          title: "Oat milk latte: how we make ours",
          description:
            "Why oat milk foams differently and how to get it right.",
          angle: "A barista's how-to",
        },
      },
    });
    expect(html).toContain("Oat milk latte: how we make ours");
    expect(html).toContain(IDEAS_COPY.articleFor("oat milk latte"));
    expect(html).toContain(IDEAS_COPY.writeArticle);
  });

  it("an ad idea is the sponsored post", () => {
    const html = card({
      id: "i4",
      status: "VALIDATED",
      createdAt: at,
      title: "t",
      description: "d",
      concept: {
        v: 2,
        module: "ads",
        source: "results",
        draft: {
          creativeId: "c1",
          assetId: "a1",
          angle: "Your launch post worked: show it to more people nearby.",
          objective: "engagement",
        },
      },
    });
    expect(html).toContain(IDEAS_COPY.sponsored);
    expect(html).toContain("/api/assets/a1?w=768");
    expect(html).toContain(IDEAS_COPY.boost);
  });

  it("an older, untyped idea offers to become a post idea", () => {
    const html = card({
      id: "i5",
      status: "SHORTLISTED",
      createdAt: at,
      title: "A partnership with a local bakery",
      description: "Co-branded breakfast box.",
      concept: null,
    });
    expect(html).toContain(IDEAS_COPY.olderIdea);
    expect(html).toContain(IDEAS_COPY.convert);
  });
});
