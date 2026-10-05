import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { IdeaEventCardData } from "@/types/idea-event-card";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/command-actions", () => ({
  submitChatMessageAction: vi.fn(),
}));

const {
  PlanBriefWizard,
  coverageLine,
  initialBriefChoices,
  prefillTags,
  rhythmChoices,
} = await import("./plan-brief-wizard");

type BriefCard = Extract<IdeaEventCardData, { kind: "plan-brief" }>;

const card = (over: Partial<BriefCard> = {}): BriefCard => ({
  kind: "plan-brief",
  projectId: "proj-1",
  today: "2026-10-05",
  connections: {
    instagram: { connected: true, accountLabel: "@webhealth" },
    linkedin: { connected: true },
  },
  theme: "Brand focus",
  ...over,
});

const PREFILL = {
  channels: ["facebook", "instagram"] as const,
  story: true,
  perWeek: 4,
  weeks: 1,
  topic: "summer sale",
};

describe("initialBriefChoices", () => {
  it("starts from the connected social channels and the usual rhythm", () => {
    expect(initialBriefChoices(card())).toEqual({
      goal: null,
      picked: {
        instagram: ["instagram.post"],
        linkedin: ["linkedin.post"],
      },
      story: false,
      perWeek: 3,
      weeks: 2,
      theme: "Brand focus",
    });
  });

  it("preselects what the client's words named", () => {
    expect(initialBriefChoices(card(), PREFILL)).toEqual({
      goal: null,
      picked: {
        instagram: ["instagram.post"],
        facebook: ["facebook.post"],
      },
      story: true,
      perWeek: 4,
      weeks: 1,
      theme: "summer sale",
    });
  });

  it("keeps the formats of the last plan for a named channel", () => {
    const choices = initialBriefChoices(
      card({
        continuation: {
          goal: "sales",
          formats: { instagram: ["instagram.reel", "not-a-format"] },
        },
      }),
      { channels: ["instagram"] },
    );
    expect(choices.goal).toBe("sales");
    expect(choices.picked).toEqual({ instagram: ["instagram.reel"] });
  });

  // The chat's default channels (the New Chat module start passes them): what a
  // project with nothing connected starts on.
  it("with nothing connected, starts on the chat's default channels", () => {
    const fresh = card({ connections: { instagram: { connected: false } } });
    expect(initialBriefChoices(fresh).picked).toEqual({});
    expect(initialBriefChoices(fresh, {}, ["instagram"]).picked).toEqual({
      instagram: ["instagram.post"],
    });
  });

  it("the defaults come after the client's words and the last plan, before the connected channels", () => {
    // Before the connected ones (Instagram and LinkedIn here).
    expect(initialBriefChoices(card(), {}, ["tiktok"]).picked).toEqual({
      tiktok: ["tiktok.video"],
    });
    // The client's words win.
    expect(
      initialBriefChoices(card(), { channels: ["x"] }, ["tiktok"]).picked,
    ).toEqual({ x: ["x.post"] });
    // So does the last plan.
    expect(
      initialBriefChoices(
        card({ continuation: { formats: { linkedin: ["linkedin.post"] } } }),
        {},
        ["tiktok"],
      ).picked,
    ).toEqual({ linkedin: ["linkedin.post"] });
    // And a Work's own channels, the only ones it offers.
    expect(
      initialBriefChoices(card({ workChannels: ["linkedin"] }), {}, [
        "instagram",
      ]).picked,
    ).toEqual({ linkedin: ["linkedin.post"] });
  });

  it("clips a long brand focus to what a brief takes", () => {
    const long = "Autumn ".repeat(40);
    const { theme } = initialBriefChoices(card({ theme: long }));
    expect(theme).toHaveLength(200);
    expect(long.startsWith(theme)).toBe(true);
    expect(initialBriefChoices(card({ theme: "  Focus  " })).theme).toBe(
      "Focus",
    );
  });

  it("offers only the Work's channels and ignores an out-of-range rhythm", () => {
    const choices = initialBriefChoices(card({ workChannels: ["linkedin"] }), {
      channels: ["instagram"],
      perWeek: 12,
      weeks: 0,
      topic: "  ",
    });
    // Instagram is not this Work's: the Work's own channels stay.
    expect(choices.picked).toEqual({ linkedin: ["linkedin.post"] });
    expect(choices.perWeek).toBe(3);
    expect(choices.weeks).toBe(2);
    expect(choices.theme).toBe("Brand focus");
  });
});

describe("rhythmChoices", () => {
  it("adds a prefilled count in its place, once", () => {
    expect(rhythmChoices([3, 5, 7], 4)).toEqual([3, 4, 5, 7]);
    expect(rhythmChoices([3, 5, 7], 5)).toEqual([3, 5, 7]);
    expect(rhythmChoices([1, 2, 4], 3)).toEqual([1, 2, 3, 4]);
  });
});

describe("coverageLine", () => {
  const instagram = {
    channel: "instagram" as const,
    formats: ["instagram.post"],
  };
  const facebook = { channel: "facebook" as const, formats: ["facebook.post"] };
  const seo = { channel: "seo" as const, formats: ["seo.article"] };

  it("counts posts, each on every social channel", () => {
    expect(
      coverageLine({
        channels: [instagram, facebook],
        story: true,
        perWeek: 3,
        weeks: 2,
      }),
    ).toBe("About 6 posts, each on Instagram + Story and Facebook.");
    expect(coverageLine({ channels: [instagram], perWeek: 1, weeks: 1 })).toBe(
      "About 1 post.",
    );
  });

  it("names a Blog/SEO channel the count leaves out", () => {
    expect(
      coverageLine({
        channels: [instagram, facebook, seo],
        perWeek: 1,
        weeks: 1,
      }),
    ).toBe(
      "About 1 piece. Each post goes to Instagram and Facebook. Blog / SEO won't get one at this count: raise the weekly count to cover it.",
    );
    expect(
      coverageLine({ channels: [instagram, seo], perWeek: 3, weeks: 1 }),
    ).toBe("About 3 pieces.");
  });
});

describe("PlanBriefWizard prefill", () => {
  it("shows what the client's words already set on the first step", () => {
    const choices = initialBriefChoices(card(), PREFILL);
    expect(prefillTags(PREFILL, choices)).toEqual([
      "Instagram + Story",
      "Facebook",
      "4/week",
      "1 week",
      "“summer sale”",
    ]);

    const html = renderToStaticMarkup(
      createElement(PlanBriefWizard, { card: card(), prefill: PREFILL }),
    );
    expect(html).toContain("What is this plan for?");
    expect(html).toContain("From your request:");
    for (const tag of ["Instagram + Story", "Facebook", "4/week", "1 week"]) {
      expect(html).toContain(tag);
    }
  });

  it("shows no request line without a prefill", () => {
    const html = renderToStaticMarkup(
      createElement(PlanBriefWizard, { card: card() }),
    );
    expect(html).toContain("What is this plan for?");
    expect(html).not.toContain("From your request");
    expect(prefillTags(undefined, initialBriefChoices(card()))).toEqual([]);
  });
});
