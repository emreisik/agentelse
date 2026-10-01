import { describe, expect, it } from "vitest";

import {
  channelListText,
  channelsWithoutWork,
  channelOptions,
  gateWorkChannels,
  parseChannelKeys,
  isTodayWork,
  primaryPlatformOf,
  resolveWorkParam,
  todayDayKeyOf,
  todayWorkId,
  todayWorkTitle,
  workSummaryFrom,
  workTitleFrom,
} from "./work";
import { channelOffers } from "./channel-offers";
import type { ChannelConnections } from "@/lib/content-channels";

describe("parseChannelKeys", () => {
  it("keeps known keys once, in catalog order, and ignores junk", () => {
    expect(
      parseChannelKeys(["x", "instagram", "instagram", "nope", 3]),
    ).toEqual(["instagram", "x"]);
    expect(parseChannelKeys(null)).toEqual([]);
    expect(parseChannelKeys({})).toEqual([]);
  });
});

describe("workTitleFrom", () => {
  it("uses the first sentence, collapses whitespace", () => {
    expect(workTitleFrom("  Plan the   week.  Then more ")).toBe(
      "Plan the week.",
    );
  });
  it("cuts a long title on a word boundary with an ellipsis", () => {
    const title = workTitleFrom(
      "Create a detailed launch plan for our new autumn cardiology screening campaign across every channel",
    );
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toMatch(/\s…$/);
  });
  it("never returns an empty title", () => {
    expect(workTitleFrom("   ")).toBe("New Work");
  });
});

describe("workSummaryFrom", () => {
  it("is null for blank text and capped otherwise", () => {
    expect(workSummaryFrom("  ")).toBeNull();
    expect(workSummaryFrom("x".repeat(200))?.length).toBe(90);
  });
});

describe("gateWorkChannels", () => {
  it("refuses an empty selection", () => {
    expect(gateWorkChannels([], {})).toEqual({
      ok: false,
      reason: "NO_CHANNEL",
    });
  });

  it("opens for a connected channel with nothing locked", () => {
    const gate = gateWorkChannels(["instagram"], {
      instagram: { connected: true, accountLabel: "@clinic" },
    });
    expect(gate).toMatchObject({ ok: true, locked: [] });
  });

  it("opens for an unconnected channel but locks its publishing", () => {
    const gate = gateWorkChannels(["instagram", "linkedin"], {
      instagram: { connected: true },
      linkedin: { connected: false },
    });
    expect(gate).toMatchObject({ ok: true, locked: ["linkedin"] });
  });

  it("treats SEO as always ready (nothing to connect)", () => {
    const gate = gateWorkChannels(["seo"], {});
    expect(gate).toMatchObject({ ok: true, locked: [] });
  });

  it("a missing connection entry means not connected", () => {
    expect(gateWorkChannels(["tiktok"], {})).toMatchObject({
      ok: true,
      locked: ["tiktok"],
    });
  });
});

describe("channelOptions / helpers", () => {
  it("lists every channel with its live state", () => {
    const options = channelOptions({ x: { connected: true } });
    expect(options.map((o) => o.key)).toEqual([
      "instagram",
      "tiktok",
      "linkedin",
      "x",
      "seo",
      "ads",
    ]);
    expect(options.find((o) => o.key === "x")?.connected).toBe(true);
    expect(options.find((o) => o.key === "instagram")?.connected).toBe(false);
    expect(options.find((o) => o.key === "seo")?.connected).toBe(true);
  });

  it("joins labels and resolves the primary platform", () => {
    expect(channelListText(["instagram", "linkedin", "x"])).toBe(
      "Instagram, LinkedIn and X",
    );
    expect(channelListText(["seo"])).toBe("Blog / SEO");
    expect(primaryPlatformOf(["seo", "linkedin"])).toBe("LINKEDIN");
    expect(primaryPlatformOf(["seo", "ads"])).toBeUndefined();
  });
});

describe("workChannelsSummary", () => {
  it("lists the channels and flags the unconnected ones", async () => {
    const { workChannelStates, workChannelsSummary } = await import("./work");
    const states = workChannelStates(["instagram", "linkedin", "seo"], {
      instagram: { connected: true },
    });
    expect(workChannelsSummary(states)).toBe(
      "Instagram · LinkedIn (not connected) · Blog / SEO",
    );
    expect(workChannelsSummary([])).toBe("");
  });
});

describe("integrationParamOf", () => {
  it("maps channels to the integrations page provider values", async () => {
    const { integrationParamOf } = await import("./work");
    expect(integrationParamOf("instagram")).toBe("instagram");
    expect(integrationParamOf("ads")).toBe("meta_ads");
    expect(integrationParamOf("tiktok")).toBe("tiktok");
    expect(integrationParamOf("linkedin")).toBe("linkedin");
    expect(integrationParamOf("x")).toBe("x");
    expect(integrationParamOf("seo")).toBeUndefined();
  });
});

describe("Today Work helpers", () => {
  it("round-trips the id", () => {
    const id = todayWorkId("p1", "2026-10-01");
    expect(id).toBe("today_p1_2026-10-01");
    expect(todayDayKeyOf(id)).toBe("2026-10-01");
    expect(isTodayWork({ id })).toBe(true);
    expect(todayWorkTitle()).toBe("Today");
  });

  it("rejects cuids and invalid dates", () => {
    expect(todayDayKeyOf("clx1abc2def3ghi4jkl5mno6p")).toBeNull();
    expect(todayDayKeyOf("today_p1_2026-02-30")).toBeNull();
    expect(todayDayKeyOf("today_p1_2026-13-01")).toBeNull();
    expect(isTodayWork({ id: "today_p1" })).toBe(false);
  });

  it("anchors both ends: a prefix or trailing text is not a Today id", () => {
    expect(todayDayKeyOf("today_p1_2026-10-01x")).toBeNull();
    expect(todayDayKeyOf("today_p1_2026-10-01_extra")).toBeNull();
    expect(todayDayKeyOf("xtoday_p1_2026-10-01")).toBeNull();
    expect(todayDayKeyOf("today_p1_2026-10-011")).toBeNull();
    // A project id that itself contains underscores still parses.
    expect(todayDayKeyOf("today_p_1_2026-10-01")).toBe("2026-10-01");
  });

  it("resolves the work param", () => {
    expect(resolveWorkParam(undefined, "2026-10-01")).toEqual({ kind: "none" });
    expect(resolveWorkParam("", "2026-10-01")).toEqual({ kind: "none" });
    expect(resolveWorkParam("today", "2026-10-01")).toEqual({ kind: "today" });
    expect(resolveWorkParam("abc", "2026-10-01")).toEqual({
      kind: "id",
      id: "abc",
    });
  });
});

describe("channelsWithoutWork", () => {
  const conn: ChannelConnections = {
    instagram: { connected: true },
    linkedin: { connected: true },
    x: { connected: true },
  };
  const works = [
    { id: "w1", channels: ["instagram"] as const, status: "ACTIVE" as const },
    {
      id: "today_p_2026-10-01",
      channels: ["linkedin"] as const,
      status: "ACTIVE" as const,
    },
    { id: "w2", channels: ["x"] as const, status: "DONE" as const },
  ];

  it("ignores Today, DONE and ARCHIVED Works", () => {
    expect(channelsWithoutWork(conn, works)).toEqual(["linkedin", "x"]);
    expect(
      channelsWithoutWork(conn, [
        { id: "w3", channels: ["x"], status: "ARCHIVED" },
      ]),
    ).toEqual(["instagram", "linkedin", "x"]);
  });

  it("equals channelOffers(...).open", () => {
    const offers = channelOffers(
      conn,
      works.map((w) => ({ ...w, title: "t" })),
    ).open;
    expect(channelsWithoutWork(conn, works)).toEqual(offers);
  });
});
