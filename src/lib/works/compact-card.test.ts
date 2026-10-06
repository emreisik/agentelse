import { describe, expect, it } from "vitest";

import {
  sampleAlertCard,
  sampleMonthlyCard,
  samplePlanCard,
  samplePulseCard,
  sampleWeeklyCard,
} from "@/lib/website-analytics/reports/test-fixtures";
import type { IdeaEventCardData } from "@/types/idea-event-card";

import {
  COMPACT_COPY,
  channelKeysOf,
  compactSpecOf,
  dayRange,
  isSingleSlotPlan,
  shortDay,
} from "./compact-card";

const card = (value: unknown) => value as IdeaEventCardData;

const planOptions = (over: Record<string, unknown> = {}) =>
  card({
    kind: "content-plan-options",
    title: "BidUniq farkındalık haftası",
    reason: "Three angles.",
    timezone: "Europe/Istanbul",
    state: "open",
    slots: [
      { date: "2026-10-03", time: "10:00", channel: "instagram", formatKey: "instagram.post" },
      { date: "2026-10-05", time: "10:00", channel: "instagram", formatKey: "instagram.post" },
      { date: "2026-10-07", time: "10:00", channel: "instagram", formatKey: "instagram.post" },
    ],
    options: [
      { id: "a", label: "A", angle: "x", ideas: [] },
      { id: "b", label: "B", angle: "y", ideas: [] },
      { id: "c", label: "C", angle: "z", ideas: [] },
    ],
    ...over,
  });

const planDraft = (over: Record<string, unknown> = {}) =>
  card({
    kind: "content-plan-draft",
    title: "Autumn week",
    timezone: "Europe/Istanbul",
    state: "draft",
    items: [
      { date: "2026-10-03", time: "10:00", channel: "instagram", topic: "a", captionIdea: "a" },
      { date: "2026-10-09", time: "10:00", channel: "linkedin", topic: "b", captionIdea: "b" },
    ],
    ...over,
  });

describe("shortDay and dayRange", () => {
  it("writes a calendar day without a time zone", () => {
    expect(shortDay("2026-10-03")).toBe("Oct 3");
    expect(shortDay("2026-01-31")).toBe("Jan 31");
    expect(shortDay("2026-13-01")).toBeNull();
    expect(shortDay("soon")).toBeNull();
  });

  it("is a range, one day, or nothing", () => {
    expect(dayRange(["2026-10-09", "2026-10-03", "2026-10-05"])).toBe("Oct 3 – Oct 9");
    expect(dayRange(["2026-10-03", "2026-10-03"])).toBe("Oct 3");
    expect(dayRange(["", "later"])).toBeNull();
    expect(dayRange([])).toBeNull();
  });
});

describe("channelKeysOf", () => {
  it("lists the channels once each, in the order they come", () => {
    expect(channelKeysOf(["instagram", "instagram"])).toEqual(["instagram"]);
    expect(channelKeysOf(["linkedin", "instagram", "x", "linkedin"])).toEqual([
      "linkedin",
      "instagram",
      "x",
    ]);
  });

  it("leaves out keys the catalog does not have", () => {
    expect(channelKeysOf(["instagram", "myspace", ""])).toEqual(["instagram"]);
    expect(channelKeysOf([])).toEqual([]);
  });
});

describe("compactSpecOf: the long cards collapse", () => {
  it("plan directions: how many, how many posts, for which channel, and that one is to be picked", () => {
    expect(compactSpecOf(planOptions())).toEqual({
      icon: "directions",
      title: "BidUniq farkındalık haftası",
      subtitle: "3 directions · 3 posts",
      channels: ["instagram"],
      status: { label: "Pick a direction", tone: "waiting" },
    });
  });

  it("replaced directions say so, and one direction or post is singular", () => {
    const spec = compactSpecOf(
      planOptions({
        state: "superseded",
        slots: [{ date: "2026-10-03", time: "10:00", channel: "x", formatKey: "x.post" }],
        options: [{ id: "a", label: "A", angle: "x", ideas: [] }],
      }),
    );
    expect(spec?.subtitle).toBe("1 direction · 1 post");
    expect(spec?.channels).toEqual(["x"]);
    expect(spec?.status).toEqual({ label: COMPACT_COPY.replaced, tone: "neutral" });
  });

  it("idea options: the number of ideas, and how many are already planned", () => {
    const base = {
      kind: "idea-options",
      title: "3 ideas for Instagram",
      reason: "r",
      items: [
        { ideaId: "i1", title: "a", description: "a" },
        { ideaId: "i2", title: "b", description: "b" },
        { ideaId: "i3", title: "c", description: "c" },
      ],
    };
    expect(compactSpecOf(card(base))).toEqual({
      icon: "ideas",
      title: "3 ideas for Instagram",
      subtitle: "3 ideas",
    });
    const planned = compactSpecOf(
      card({ ...base, scheduled: { i1: { date: "2026-10-03", time: "10:00", channel: "instagram" } } }),
    );
    expect(planned?.subtitle).toBe("3 ideas · 1 planned");
    expect(planned?.status).toEqual({ label: "1 planned", tone: "positive" });
  });

  it("master content: the channels it is adapted for, and where it stands", () => {
    const master = (over: Record<string, unknown> = {}) =>
      card({
        kind: "master-content",
        title: "Launch message",
        state: "draft",
        master: { title: "t", message: "m" },
        targets: [
          { channel: "instagram", formatKey: "instagram.post", included: true },
          { channel: "linkedin", formatKey: "linkedin.post", included: true },
          { channel: "x", formatKey: "x.post", included: false },
        ],
        ...over,
      });
    expect(compactSpecOf(master())).toMatchObject({
      icon: "master",
      subtitle: "2 channels",
      channels: ["instagram", "linkedin"],
      status: { label: "Draft", tone: "waiting" },
    });
    expect(compactSpecOf(master({ state: "adapted" }))?.status).toEqual({
      label: "Adapted",
      tone: "positive",
    });
    expect(compactSpecOf(master({ state: "superseded" }))?.status?.label).toBe("Replaced");
    expect(
      compactSpecOf(master({ adapting: { startedAt: "2026-10-02T10:00:00Z" } }))?.status,
    ).toEqual({ label: "Adapting…", tone: "waiting" });
  });

  it("a plan of several posts: how many, which days, which channels, where it stands", () => {
    expect(compactSpecOf(planDraft())).toEqual({
      icon: "plan",
      // A plan is general: one name for every plan, never a platform's.
      title: "Social media plan",
      subtitle: "2 posts · Oct 3 – Oct 9",
      channels: ["instagram", "linkedin"],
      status: { label: "Draft", tone: "waiting" },
    });
    expect(compactSpecOf(planDraft({ state: "saved" }))?.status).toEqual({
      label: "Saved",
      tone: "positive",
    });
    expect(
      compactSpecOf(
        planDraft({
          state: "saved",
          production: { state: "running", creativeIds: [], startedAt: "2026-10-02T10:00:00Z" },
        }),
      )?.status?.label,
    ).toBe("Producing");
    expect(compactSpecOf(planDraft({ state: "superseded" }))?.status?.label).toBe("Replaced");
  });

  it("removed slots are not counted", () => {
    const spec = compactSpecOf(
      planDraft({
        items: [
          { date: "2026-10-03", time: "10:00", channel: "instagram", topic: "a", captionIdea: "a" },
          { date: "2026-10-04", time: "10:00", channel: "instagram", topic: "b", captionIdea: "b", removed: true },
          { date: "2026-10-05", time: "10:00", channel: "instagram", topic: "c", captionIdea: "c" },
        ],
      }),
    );
    expect(spec?.subtitle).toBe("2 posts · Oct 3 – Oct 5");
    expect(spec?.channels).toEqual(["instagram"]);
  });

  it("a content package: its topic, how many pieces, and what to do with it", () => {
    const pkg = (over: Record<string, unknown> = {}) =>
      card({
        kind: "content-package",
        topic: "Spring launch",
        state: "draft",
        items: [
          { id: "1", deliverable: "SOCIAL_POST", title: "a", angle: "a" },
          { id: "2", deliverable: "SEO_ARTICLE", title: "b", angle: "b" },
        ],
        ...over,
      });
    expect(compactSpecOf(pkg())).toEqual({
      icon: "package",
      title: "Spring launch",
      subtitle: "2 pieces",
      status: { label: "Pick pieces", tone: "waiting" },
    });
    expect(compactSpecOf(pkg({ state: "started", startedCount: 1 }))?.status).toEqual({
      label: "1 started",
      tone: "positive",
    });
    expect(compactSpecOf(pkg({ state: "superseded" }))?.status?.label).toBe("Replaced");
  });

  it("the Meta Ads card: its headline, and a decision when a budget change waits", () => {
    const ads = (over: Record<string, unknown> = {}) =>
      card({ kind: "ads-insight", state: "ok", chips: [], headline: "Spring: cost per lead is $4", ...over });
    expect(compactSpecOf(ads())).toEqual({
      icon: "ads",
      title: "Meta Ads",
      subtitle: "Spring: cost per lead is $4",
    });
    expect(
      compactSpecOf(
        ads({
          proposal: { taskId: "t", approvalId: "a", capability: "META_CAMPAIGN_UPDATE", state: "pending", changeText: "x" },
        }),
      )?.status,
    ).toEqual({ label: "Decision needed", tone: "waiting" });
    expect(compactSpecOf(ads({ state: "error" }))?.status?.tone).toBe("danger");
    expect(compactSpecOf(ads({ headline: undefined }))?.subtitle).toBe(
      "How your campaigns are doing",
    );
  });
});

describe("compactSpecOf: website reports", () => {
  const stored = (value: unknown) => card(JSON.parse(JSON.stringify(value)));

  it("collapses weekly, monthly and plan reports to the pane card", () => {
    expect(compactSpecOf(stored(sampleWeeklyCard({ preliminary: false })))).toMatchObject({
      icon: "website",
      title: "Weekly website report",
      subtitle: "Sep 28 – Oct 4",
    });
    expect(compactSpecOf(stored(sampleMonthlyCard()))?.title).toBe(
      "Monthly website report",
    );
    expect(compactSpecOf(stored(samplePlanCard()))?.title).toBe(
      "Next month plan",
    );
  });

  it("marks a preliminary report and leaves the others without a status", () => {
    expect(
      compactSpecOf(stored(sampleWeeklyCard({ preliminary: true })))?.status,
    ).toEqual({ label: "Preliminary", tone: "neutral" });
    expect(
      compactSpecOf(stored(sampleWeeklyCard({ preliminary: false })))?.status,
    ).toBeUndefined();
  });

  it("keeps pulse and alert cards in the chat, and so does an unreadable card", () => {
    expect(compactSpecOf(stored(samplePulseCard()))).toBeNull();
    expect(compactSpecOf(stored(sampleAlertCard()))).toBeNull();
    expect(compactSpecOf(card({ kind: "website-report", v: 99 }))).toBeNull();
  });
});

describe("compactSpecOf: short cards stay in the chat", () => {
  it("a plan of one post that came from an idea, a brief, a suggestion or generation is the planned-slot card", () => {
    for (const via of ["idea", "generate", "suggestion", "brief"]) {
      const one = planDraft({
        via,
        state: "saved",
        savedCreativeIds: ["c1"],
        items: [{ date: "2026-10-03", time: "10:00", channel: "instagram", topic: "a", captionIdea: "a" }],
      });
      expect(compactSpecOf(one)).toBeNull();
      expect(isSingleSlotPlan(one as Extract<IdeaEventCardData, { kind: "content-plan-draft" }>)).toBe(true);
    }
  });

  it("one post that is not on the calendar yet (a draft) is a plan card, whatever it came from", () => {
    const one = planDraft({
      via: "idea",
      items: [{ date: "2026-10-03", time: "10:00", channel: "instagram", topic: "a", captionIdea: "a" }],
    });
    expect(compactSpecOf(one)).not.toBeNull();
    expect(isSingleSlotPlan(one as Extract<IdeaEventCardData, { kind: "content-plan-draft" }>)).toBe(false);
  });

  it("one post that came from a plan's directions or the master is still a plan card", () => {
    const one = planDraft({
      via: "options",
      items: [{ date: "2026-10-03", time: "10:00", channel: "instagram", topic: "a", captionIdea: "a" }],
    });
    expect(compactSpecOf(one)).not.toBeNull();
  });

  it("decisions, results, creatives, the channel gate, the wizard and the daily brief are not collapsed", () => {
    for (const kind of [
      "signal",
      "approval-request",
      "task-result",
      "publish-result",
      "channel-select",
      "plan-brief",
      "question",
      "creative-ready",
      "creative-loading",
      "daily-brief",
    ]) {
      expect(compactSpecOf(card({ kind }))).toBeNull();
    }
  });

  it("never throws on a stored card with missing parts", () => {
    expect(() => compactSpecOf(card({ kind: "content-plan-options", title: "x", state: "open", slots: [], options: [] }))).not.toThrow();
  });
});
