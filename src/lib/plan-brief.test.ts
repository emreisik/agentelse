import { describe, expect, it } from "vitest";

import {
  briefRotation,
  channelsLeftOut,
  parsePlanBrief,
  serializePlanBrief,
  stripPlanBriefMarker,
  totalBriefItems,
  validatePlanAgainstBrief,
  type PlanBrief,
} from "./plan-brief";

const brief: PlanBrief = {
  goal: "leads",
  channels: [
    { channel: "instagram", formats: ["instagram.carousel", "instagram.reel"] },
    { channel: "seo", formats: ["seo.article"] },
  ],
  perWeek: 5,
  weeks: 2,
  start: "2026-09-30",
  theme: "Kommo CRM; health tourism = growth",
};

describe("plan brief message", () => {
  it("round-trips through the chat message, theme punctuation included", () => {
    expect(parsePlanBrief(serializePlanBrief(brief))).toEqual(brief);
  });

  it("puts a readable sentence first and the machine line last", () => {
    const message = serializePlanBrief(brief);
    const [sentence, marker] = message.split("\n");
    expect(sentence).toContain("Goal: Leads & bookings");
    expect(sentence).toContain("Instagram (Carousel, Reel)");
    expect(marker).toMatch(
      /^\[Plan brief\] goal=leads; channels=instagram:carousel\+reel,seo:article;/,
    );
  });

  it("hides the machine line from the chat bubble", () => {
    const visible = stripPlanBriefMarker(serializePlanBrief(brief));
    expect(visible).not.toContain("[Plan brief]");
    expect(visible).toContain("Plan my content.");
    expect(stripPlanBriefMarker("just a normal message")).toBe(
      "just a normal message",
    );
  });

  it("returns null for messages without a valid brief", () => {
    expect(parsePlanBrief("plan my week")).toBeNull();
    expect(
      parsePlanBrief("[Plan brief] goal=nonsense; channels=x:y"),
    ).toBeNull();
    // A format that does not belong to its channel.
    expect(
      parsePlanBrief(
        "[Plan brief] goal=leads; channels=instagram:article; perWeek=3; weeks=1; start=2026-10-01",
      ),
    ).toBeNull();
    // Out-of-range rhythm.
    expect(
      parsePlanBrief(
        "[Plan brief] goal=leads; channels=instagram:post; perWeek=99; weeks=1; start=2026-10-01",
      ),
    ).toBeNull();
    // A duplicated channel.
    expect(
      parsePlanBrief(
        "[Plan brief] goal=leads; channels=instagram:post,instagram:reel; perWeek=3; weeks=1; start=2026-10-01",
      ),
    ).toBeNull();
  });

  it("counts perWeek x weeks pieces", () => {
    expect(totalBriefItems(brief)).toBe(10);
  });

  it("round-trips the Instagram Story switch", () => {
    const storied: PlanBrief = {
      goal: "awareness",
      channels: [
        { channel: "instagram", formats: ["instagram.post"] },
        { channel: "facebook", formats: ["facebook.post"] },
      ],
      story: true,
      perWeek: 3,
      weeks: 1,
      start: "2026-10-06",
    };
    const message = serializePlanBrief(storied);
    expect(message).toContain(
      "Channels: Instagram (Post) + Story; Facebook (Post).",
    );
    expect(message).toMatch(/; story=1; perWeek=3;/);
    expect(parsePlanBrief(message)).toEqual(storied);
    // Off: no field, nothing in the sentence.
    const off = serializePlanBrief({ ...storied, story: false });
    expect(off).not.toContain("story=");
    expect(off).not.toContain("+ Story");
    expect(parsePlanBrief(off)?.story).toBeUndefined();
  });

  it("drops the Story switch without Instagram", () => {
    const line =
      "[Plan brief] goal=leads; channels=linkedin:post; story=1; perWeek=3; weeks=1; start=2026-10-01";
    const parsed = parsePlanBrief(line);
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("story");
    expect(serializePlanBrief({ ...parsed!, story: true })).not.toContain(
      "story=1",
    );
  });
});

describe("posts and channels", () => {
  const social: PlanBrief = {
    goal: "awareness",
    channels: [
      { channel: "instagram", formats: ["instagram.post", "instagram.reel"] },
      { channel: "facebook", formats: ["facebook.post"] },
      { channel: "seo", formats: ["seo.article"] },
    ],
    perWeek: 1,
    weeks: 1,
    start: "2026-10-06",
  };

  it("gives the social channels one place: the first one's formats", () => {
    expect(briefRotation(social.channels)).toEqual([
      { channel: "instagram", formatKey: "instagram.post" },
      { channel: "instagram", formatKey: "instagram.reel" },
      { channel: "seo", formatKey: "seo.article" },
    ]);
  });

  it("names the channels a count too small leaves out", () => {
    // One slot: a post, which reaches Instagram and Facebook.
    expect(channelsLeftOut(social)).toEqual(["seo"]);
    expect(channelsLeftOut({ ...social, perWeek: 3 })).toEqual([]);
    expect(
      channelsLeftOut({ ...social, channels: social.channels.slice(0, 2) }),
    ).toEqual([]);
  });
});

describe("validatePlanAgainstBrief", () => {
  const item = (channel: string, formatKey: string, date = "2026-10-01") => ({
    channel,
    formatKey,
    date,
  });

  it("accepts a plan that follows the brief", () => {
    expect(
      validatePlanAgainstBrief(
        [item("instagram", "instagram.reel"), item("seo", "seo.article")],
        brief,
      ),
    ).toBeNull();
  });

  it("rejects channels and formats the client did not pick", () => {
    expect(
      validatePlanAgainstBrief(
        [item("tiktok", "tiktok.video"), item("seo", "seo.article")],
        brief,
      ),
    ).toMatch(/not in the client's brief/);
    expect(
      validatePlanAgainstBrief(
        [item("instagram", "instagram.story"), item("seo", "seo.article")],
        brief,
      ),
    ).toMatch(/was not chosen for instagram/);
  });

  it("rejects too many items, early dates and items without channel", () => {
    const many = Array.from({ length: 11 }, () =>
      item("instagram", "instagram.reel"),
    );
    expect(validatePlanAgainstBrief(many, brief)).toMatch(/at most 10/);
    expect(
      validatePlanAgainstBrief(
        [
          item("instagram", "instagram.reel", "2026-09-29"),
          item("seo", "seo.article"),
        ],
        brief,
      ),
    ).toMatch(/before the client's start date/);
    expect(validatePlanAgainstBrief([{ date: "2026-10-01" }], brief)).toMatch(
      /channel/,
    );
  });

  it("requires every chosen channel to appear when the total allows it", () => {
    expect(
      validatePlanAgainstBrief([item("instagram", "instagram.reel")], brief),
    ).toMatch(/no item for it/);
  });

  it("counts any post for every social channel; Blog/SEO needs its own", () => {
    const wide: PlanBrief = {
      ...brief,
      channels: [
        { channel: "instagram", formats: ["instagram.reel"] },
        { channel: "linkedin", formats: ["linkedin.post"] },
        { channel: "seo", formats: ["seo.article"] },
      ],
    };
    expect(
      validatePlanAgainstBrief(
        [item("instagram", "instagram.reel"), item("seo", "seo.article")],
        wide,
      ),
    ).toBeNull();
    const missing = validatePlanAgainstBrief(
      [item("instagram", "instagram.reel")],
      wide,
    );
    expect(missing).toMatch(/includes seo but/);
    expect(missing).not.toContain("linkedin");
  });

  it("does not demand more channels than the total can hold", () => {
    const tight: PlanBrief = { ...brief, perWeek: 1, weeks: 1 };
    expect(
      validatePlanAgainstBrief([item("instagram", "instagram.reel")], tight),
    ).toBeNull();
  });
});
