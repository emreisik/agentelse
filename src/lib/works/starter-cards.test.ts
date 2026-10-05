import { describe, expect, it } from "vitest";

import { gateWorkChannels } from "./work";

import {
  MAX_STARTER_CARDS,
  chatDefaultChannels,
  integrationsHref,
  moduleStarterCards,
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
  it("with no channel and an account connected there is nothing to suggest (the picker is in the composer)", () => {
    expect(
      starterCards(facts([], { instagram: { connected: true } })),
    ).toEqual([]);
  });

  it("with no channel and nothing connected, the one suggestion is connecting a channel", () => {
    const cards = starterCards(
      facts([], {}, { fromWorkId: "w1" }),
    );
    expect(cards.map((c) => c.id)).toEqual(["connect-first"]);
    expect(cards[0]?.line).toBe("Connect a channel");
    expect(cards[0]?.action).toEqual({
      kind: "link",
      href: "/projects/p1/integrations?from=w1",
    });
  });

  it("every card has one sentence for the list, naming the channels where it helps", () => {
    const cards = starterCards(
      facts(
        ["instagram", "linkedin"],
        { instagram: { connected: true }, linkedin: { connected: true } },
        { pendingApprovals: 2 },
      ),
    );
    const lines = Object.fromEntries(cards.map((c) => [c.id, c.line]));
    expect(lines["plan-week"]).toBe("Plan the week for Instagram and LinkedIn");
    expect(lines["ideas"]).toBe("Find content ideas for Instagram and LinkedIn");
    expect(lines["make-post"]).toBe("Make one post for Instagram");
    expect(lines["decisions"]).toBe("2 decisions waiting for you");
    for (const card of cards) {
      expect(card.line.trim()).not.toBe("");
      expect(card.line).not.toMatch(/[.!?]$/);
    }
  });

  it("the connect and performance lines read as a sentence too", () => {
    const connect = starterCards(
      facts(["tiktok"], { tiktok: { connected: false } }),
    ).find((c) => c.id === "connect");
    expect(connect?.line).toBe("Connect TikTok to publish");
    const performance = starterCards(
      facts(["instagram"], { instagram: { connected: true } }, { hasAnalytics: true }),
    ).find((c) => c.id === "performance");
    expect(performance?.line).toBe("Check how your content is performing");
  });

  it("always opens with planning for the Work's channels", () => {
    const [first] = starterCards(
      facts(["instagram", "linkedin"], {
        instagram: { connected: true },
        linkedin: { connected: true },
      }),
    );
    expect(first?.id).toBe("plan-week");
    expect(first?.action).toEqual({
      kind: "send",
      text: "Plan the week for Instagram and LinkedIn.",
    });
  });

  it("offers a decisions card only when something waits, pointing at Outputs", () => {
    const base = facts(["instagram"], { instagram: { connected: true } });
    expect(starterCards(base).some((c) => c.id === "decisions")).toBe(false);
    const cards = starterCards({ ...base, pendingApprovals: 3 });
    const decisions = cards.find((c) => c.id === "decisions");
    expect(decisions?.line).toBe("3 decisions waiting for you");
    expect(decisions?.action).toEqual({ kind: "tab", tab: "outputs" });
    expect(
      starterCards({ ...base, pendingApprovals: 1 }).find((c) => c.id === "decisions")
        ?.line,
    ).toBe("1 decision waiting for you");
  });

  it("an unconnected channel gets a Connect card linking to that channel", () => {
    const cards = starterCards(
      facts(["tiktok"], { tiktok: { connected: false } }),
    );
    const connect = cards.find((c) => c.id === "connect");
    expect(connect?.line).toBe("Connect TikTok to publish");
    expect(connect?.action).toEqual({
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
  it("integrationsHref without a channel is the plain page", () => {
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

  it("chatDefaultChannels: the connected publishing channels (at most 3), else Instagram", () => {
    const opt = (n: number) =>
      (["instagram", "tiktok", "linkedin", "x"] as const).map((key, i) => ({
        key,
        connected: i < n,
      }));
    expect(chatDefaultChannels(opt(0))).toEqual(["instagram"]);
    expect(chatDefaultChannels(opt(1))).toEqual(["instagram"]);
    expect(chatDefaultChannels(opt(3))).toEqual(["instagram", "tiktok", "linkedin"]);
    // Four connected: the first three, never a guess of all four.
    expect(chatDefaultChannels(opt(4))).toEqual(["instagram", "tiktok", "linkedin"]);
    // Blog/SEO and Ads are not publishing channels of a plan's default.
    expect(
      chatDefaultChannels([
        { key: "seo", connected: true },
        { key: "ads", connected: true },
      ]),
    ).toEqual(["instagram"]);
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

  it("plan-week sends one plain sentence: the plan comes back at once, with defaults for the rest", () => {
    const cards = starterCards(
      facts(["instagram", "ads"], connected, { today: "2026-10-01", theme: "Autumn" }),
    );
    expect(cards.find((c) => c.id === "plan-week")?.action).toEqual({
      kind: "send",
      text: "Plan the week for Instagram and Ads.",
    });
  });

  it("says the same without today", () => {
    const [plan] = starterCards(facts(["instagram"], connected));
    expect(plan?.action).toEqual({
      kind: "send",
      text: "Plan the week for Instagram.",
    });
  });

  it("make-post targets the first social channel and is absent for seo only", () => {
    const cards = starterCards(facts(["seo", "linkedin", "instagram"], connected));
    const post = cards.find((c) => c.id === "make-post");
    expect(post?.action).toEqual({
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
    expect(cards[0]?.action).toEqual({ kind: "tab", tab: "calendar" });
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
    expect(cards.find((c) => c.id === "connect")?.action).toEqual({
      kind: "link",
      href: "/projects/p1/integrations?integration=tiktok&from=w9",
    });
  });
});

// Modules on (MODULES_UI): the module tiles start the planning, the ideas, a post
// and the performance report, so only the rows no module covers stay.
describe("moduleStarterCards", () => {
  const ids = (cards: ReturnType<typeof starterCards>) =>
    moduleStarterCards(cards).map((c) => c.id);

  it("keeps a decision waiting and drops what the tiles start", () => {
    const cards = starterCards(
      facts(["instagram", "linkedin"], { instagram: { connected: true } }, {
        pendingApprovals: 2,
        hasAnalytics: true,
      }),
    );
    expect(cards.map((c) => c.id)).toEqual([
      "plan-week",
      "ideas",
      "make-post",
      "decisions",
    ]);
    expect(ids(cards)).toEqual(["decisions"]);
  });

  it("keeps the way to connect a channel, with its link", () => {
    const cards = starterCards(
      facts(["tiktok"], { tiktok: { connected: false } }, { fromWorkId: "w1" }),
    );
    expect(moduleStarterCards(cards)).toEqual([
      expect.objectContaining({
        id: "connect",
        action: {
          kind: "link",
          href: "/projects/p1/integrations?integration=tiktok&from=w1",
        },
      }),
    ]);
    expect(ids(starterCards(facts([], {})))).toEqual(["connect-first"]);
  });

  it("keeps AI switched off, and drops the performance report", () => {
    const connected = { instagram: { connected: true } };
    expect(
      ids(starterCards(facts(["instagram"], connected, { aiOff: true }))),
    ).toEqual(["ai-off"]);
    expect(
      ids(starterCards(facts(["instagram"], connected, { hasAnalytics: true }))),
    ).toEqual([]);
  });
});
