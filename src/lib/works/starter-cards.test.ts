import { describe, expect, it } from "vitest";

import { gateWorkChannels } from "./work";
import { parsePlanBrief } from "@/lib/plan-brief";

import {
  MAX_STARTER_CARDS,
  channelChoiceFraming,
  defaultChannelSelection,
  integrationsHref,
  pendingHintFor,
  starterCards,
} from "./starter-cards";

function facts(
  channels: Parameters<typeof gateWorkChannels>[0],
  connections: Parameters<typeof gateWorkChannels>[1],
  over: Partial<Parameters<typeof starterCards>[0]> = {},
) {
  const gate = gateWorkChannels(channels, connections);
  return {
    projectId: "p1",
    channels: gate.ok ? gate.channels : [],
    anyConnected: Object.values(connections).some((c) => c?.connected),
    pendingApprovals: 0,
    hasAnalytics: false,
    ...over,
  };
}

describe("starterCards", () => {
  it("has no cards before a channel is chosen (the chooser comes first)", () => {
    expect(starterCards(facts([], {}))).toEqual([]);
  });

  it("always opens with planning for the Work's channels", () => {
    const [first] = starterCards(
      facts(["instagram", "linkedin"], {
        instagram: { connected: true },
        linkedin: { connected: true },
      }),
    );
    expect(first?.id).toBe("plan-week");
    expect(first?.primary.action).toEqual({
      kind: "send",
      text: "Plan the week for Instagram and LinkedIn.",
    });
  });

  it("offers a decisions card only when something waits, pointing at Outputs", () => {
    const base = facts(["instagram"], { instagram: { connected: true } });
    expect(starterCards(base).some((c) => c.id === "decisions")).toBe(false);
    const cards = starterCards({ ...base, pendingApprovals: 3 });
    const decisions = cards.find((c) => c.id === "decisions");
    expect(decisions?.title).toBe("3 decisions waiting");
    expect(decisions?.primary.action).toEqual({ kind: "tab", tab: "outputs" });
    expect(
      starterCards({ ...base, pendingApprovals: 1 }).find((c) => c.id === "decisions")
        ?.title,
    ).toBe("1 decision waiting");
  });

  it("an unconnected channel gets a Connect card linking to that channel", () => {
    const cards = starterCards(
      facts(["tiktok"], { tiktok: { connected: false } }),
    );
    const connect = cards.find((c) => c.id === "connect");
    expect(connect?.title).toBe("Connect TikTok");
    expect(connect?.primary.action).toEqual({
      kind: "link",
      href: "/projects/p1/integrations?integration=tiktok",
    });
    expect(connect?.reason).toContain("publishing starts once");
  });

  it("offers performance only when everything is connected and there is data", () => {
    const connected = facts(["instagram"], { instagram: { connected: true } });
    expect(starterCards(connected).some((c) => c.id === "performance")).toBe(false);
    expect(
      starterCards({ ...connected, hasAnalytics: true }).some(
        (c) => c.id === "performance",
      ),
    ).toBe(true);
    // A locked channel shows Connect instead of performance.
    const locked = starterCards(
      facts(["x"], { x: { connected: false } }, { hasAnalytics: true }),
    );
    expect(locked.some((c) => c.id === "performance")).toBe(false);
  });

  it("never exceeds the cap", () => {
    const cards = starterCards(
      facts(["instagram", "x"], { instagram: { connected: true } }, {
        pendingApprovals: 2,
        hasAnalytics: true,
      }),
    );
    expect(cards.length).toBeLessThanOrEqual(MAX_STARTER_CARDS);
  });
});

describe("helpers", () => {
  it("frames the channel choice by whether anything is connected", () => {
    expect(channelChoiceFraming(true).title).toContain("Which channel");
    expect(channelChoiceFraming(false).title).toContain("Connect a channel");
    expect(integrationsHref("p1")).toBe("/projects/p1/integrations");
  });

  it("integrationsHref uses the provider param and an optional way back", () => {
    expect(integrationsHref("p1", "ads")).toBe(
      "/projects/p1/integrations?integration=meta_ads",
    );
    expect(integrationsHref("p1", "seo")).toBe("/projects/p1/integrations");
    expect(integrationsHref("p1", "tiktok", { fromWorkId: "w1" })).toBe(
      "/projects/p1/integrations?integration=tiktok&from=w1",
    );
    expect(integrationsHref("p1", "seo", { fromWorkId: "w1" })).toBe(
      "/projects/p1/integrations?from=w1",
    );
  });

  it("defaultChannelSelection pre-selects 1 to 3 connected publishing channels", () => {
    const opt = (n: number) =>
      (["instagram", "tiktok", "linkedin", "x"] as const).map((key, i) => ({
        key,
        connected: i < n,
      }));
    expect(defaultChannelSelection(opt(0))).toEqual([]);
    expect(defaultChannelSelection(opt(1))).toEqual(["instagram"]);
    expect(defaultChannelSelection(opt(3))).toEqual([
      "instagram",
      "tiktok",
      "linkedin",
    ]);
    expect(defaultChannelSelection(opt(4))).toEqual([]);
    expect(
      defaultChannelSelection([
        { key: "seo", connected: true },
        { key: "ads", connected: true },
      ]),
    ).toEqual([]);
  });

  it("pendingHintFor tells plan, ideas and generic apart", () => {
    expect(pendingHintFor("Plan the week · from Fri 2 Oct\n[Plan brief] goal=awareness")).toBe("plan");
    expect(pendingHintFor("Give me content ideas for X.")).toBe("ideas");
    expect(pendingHintFor("hello")).toBe("generic");
  });
});

describe("starter cards of wave 1", () => {
  const connected = {
    instagram: { connected: true },
    linkedin: { connected: true },
    ads: { connected: true },
  };

  it("plan-week sends a friendly line plus a machine brief that round-trips", () => {
    const cards = starterCards(
      facts(["instagram", "ads"], connected, { today: "2026-10-01", theme: "Autumn" }),
    );
    const plan = cards.find((c) => c.id === "plan-week");
    const action = plan?.primary.action;
    if (action?.kind !== "send") throw new Error("expected send");
    const [first, machine, ...rest] = action.text.split("\n");
    expect(rest).toEqual([]);
    expect(first).toBe("Plan the week · from Fri 2 Oct");
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(machine).toMatch(/^\[Plan brief\] /);
    const brief = parsePlanBrief(action.text);
    expect(brief?.channels.map((c) => c.channel)).toEqual(["instagram"]);
    expect(brief?.start).toBe("2026-10-02");
    expect(brief?.perWeek).toBe(3);
    expect(brief?.weeks).toBe(1);
    expect(brief?.theme).toBe("Autumn");
    expect(plan?.secondary?.label).toBe("Customize");
    expect(plan?.secondary?.action).toEqual({
      kind: "send",
      text: "Plan the week for Instagram and Ads.",
    });
  });

  it("falls back to the old text without today", () => {
    const [plan] = starterCards(facts(["instagram"], connected));
    expect(plan?.primary.action).toEqual({
      kind: "send",
      text: "Plan the week for Instagram.",
    });
  });

  it("make-post targets the first social channel and is absent for seo only", () => {
    const cards = starterCards(facts(["seo", "linkedin", "instagram"], connected));
    const post = cards.find((c) => c.id === "make-post");
    expect(post?.primary.action).toEqual({
      kind: "send",
      text: "Make one post for LinkedIn.",
    });
    expect(
      starterCards(facts(["seo"], {})).some((c) => c.id === "make-post"),
    ).toBe(false);
  });

  it("aiOff replaces plan, ideas and make-post by one card", () => {
    const cards = starterCards(
      facts(["instagram"], connected, { aiOff: true, today: "2026-10-01" }),
    );
    expect(cards.map((c) => c.id)).toEqual(["ai-off"]);
    expect(cards[0]?.primary.action).toEqual({ kind: "tab", tab: "calendar" });
  });

  it("only one of decisions, connect, performance fills the fourth place", () => {
    const base = facts(["instagram", "tiktok"], { instagram: { connected: true } }, {
      pendingApprovals: 2,
      hasAnalytics: true,
    });
    const ids = starterCards(base).map((c) => c.id);
    expect(ids).toEqual(["plan-week", "ideas", "make-post", "decisions"]);
    const noDecisions = starterCards({ ...base, pendingApprovals: 0 }).map((c) => c.id);
    expect(noDecisions).toEqual(["plan-week", "ideas", "make-post", "connect"]);
  });

  it("the connect link carries the way back to the Work", () => {
    const cards = starterCards(
      facts(["tiktok"], { tiktok: { connected: false } }, { fromWorkId: "w9" }),
    );
    expect(cards.find((c) => c.id === "connect")?.primary.action).toEqual({
      kind: "link",
      href: "/projects/p1/integrations?integration=tiktok&from=w9",
    });
  });
});
