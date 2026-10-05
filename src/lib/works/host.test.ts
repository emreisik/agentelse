import { afterEach, describe, expect, it, vi } from "vitest";

import { buildWorkHost } from "./host";
import type { WorkView } from "./work";

const work = (
  channels: WorkView["channels"],
  module: WorkView["module"] = null,
): WorkView => ({
  id: "w1",
  title: "New Work",
  summary: null,
  status: "ACTIVE",
  channels,
  acknowledgedUnconnected: [],
  module,
  lastActivityAt: "2026-10-01T10:00:00.000Z",
});

const input = (channels: WorkView["channels"], connected = true) => ({
  projectId: "p1",
  work: work(channels),
  connections: { instagram: { connected } },
  pendingApprovals: 0,
  hasAnalytics: false,
});

describe("buildWorkHost", () => {
  it("with no channel and an account connected, it suggests for the connected channel", () => {
    const host = buildWorkHost(input([]));
    expect(host.starterCards[0]?.id).toBe("plan-week");
    expect(host.defaultChannels).toEqual(["instagram"]);
    expect(host.channelOptions).toHaveLength(7);
    expect(host.anyConnected).toBe(true);
  });

  it("with no channel and nothing connected, it still plans for Instagram and offers to connect it", () => {
    const host = buildWorkHost(input([], false));
    const ids = host.starterCards.map((c) => c.id);
    expect(ids).toContain("plan-week");
    expect(ids).toContain("connect");
  });

  it("reports that nothing is connected", () => {
    expect(buildWorkHost(input([], false)).anyConnected).toBe(false);
  });

  it("builds the cards from the chosen channels", () => {
    const host = buildWorkHost(input(["instagram"]));
    expect(host.starterCards[0]?.id).toBe("plan-week");
  });

  it("an unconnected chosen channel adds the Connect card", () => {
    const host = buildWorkHost(input(["instagram"], false));
    expect(host.starterCards.some((c) => c.id === "connect")).toBe(true);
  });

  it("passes the Work id on to the connect link and exposes the timezone", () => {
    const host = buildWorkHost({
      ...input(["instagram"], false),
      timezone: "Europe/Skopje",
    });
    const connect = host.starterCards.find((c) => c.id === "connect");
    expect(connect?.action).toEqual({
      kind: "link",
      href: "/projects/p1/integrations?integration=instagram&from=w1",
    });
    expect(host.timezone).toBe("Europe/Skopje");
  });

  it("with AI off the only suggestion is the calendar", () => {
    const host = buildWorkHost({
      ...input([]),
      today: "2026-10-01",
      aiOff: true,
    });
    expect(host.starterCards.map((c) => c.id)).toEqual(["ai-off"]);
    expect("timezone" in host).toBe(false);
  });
});

// What a new plan starts from (the Social Media Planner's Brief reads it): the
// project's day as the server read it, and the brand's current focus.
describe("buildWorkHost: the project's day and the brand's focus", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes the day and the focus the page passes", () => {
    const host = buildWorkHost({
      ...input([]),
      today: "2026-10-05",
      theme: "Autumn menu",
    });
    expect(host.today).toBe("2026-10-05");
    expect(host.theme).toBe("Autumn menu");
  });

  it("without the page's day, the day in the project's timezone; no focus, none", () => {
    vi.useFakeTimers();
    // Late evening in UTC is already the next day in Skopje (UTC+2).
    vi.setSystemTime(new Date("2026-10-05T22:30:00Z"));
    const host = buildWorkHost({ ...input([]), timezone: "Europe/Skopje" });
    expect(host.today).toBe("2026-10-06");
    expect("theme" in host).toBe(false);
    expect("theme" in buildWorkHost({ ...input([]), theme: "" })).toBe(false);
  });
});

// A chat with no stored channel starts with the connected publishing channels
// (at most three, else Instagram): the suggestions name them, and the chat route
// stores them with the first message. Defaults only: a chat is not bound.
describe("buildWorkHost of a chat with no stored channel", () => {
  const fresh = (over: Record<string, unknown> = {}) =>
    buildWorkHost({ ...input([]), ...over });

  it("starts with the connected publishing channels and suggests for them", () => {
    const host = fresh();
    expect(host.defaultChannels).toEqual(["instagram"]);
    expect(host.starterCards[0]?.id).toBe("plan-week");
    expect(host.starterCards[0]?.line).toBe("Plan the week for Instagram");
    // The Work itself stores nothing yet.
    expect(host.work.channels).toEqual([]);
  });

  it("with no account connected it still plans for Instagram and offers to connect it", () => {
    const host = fresh({ connections: { instagram: { connected: false } } });
    expect(host.defaultChannels).toEqual(["instagram"]);
    const ids = host.starterCards.map((c) => c.id);
    expect(ids).toContain("plan-week");
    expect(ids).toContain("connect");
  });

  it("with four accounts connected the defaults are the first three", () => {
    const host = fresh({
      connections: {
        instagram: { connected: true },
        tiktok: { connected: true },
        linkedin: { connected: true },
        x: { connected: true },
      },
    });
    expect(host.defaultChannels).toEqual(["instagram", "tiktok", "linkedin"]);
  });

  it("a stored choice wins: no defaults, the suggestions follow the stored channels", () => {
    const host = buildWorkHost({
      ...input(["linkedin"], true),
      connections: {
        instagram: { connected: true },
        linkedin: { connected: false },
      },
    });
    expect(host.defaultChannels).toEqual([]);
    expect(host.starterCards[0]?.line).toBe("Plan the week for LinkedIn");
  });
});

// Modules (MODULES_UI): the page passes the flag; the chat reads the Work's
// module from the host, never while the flag is off.
describe("buildWorkHost and modules", () => {
  it("modules are off unless the page says they are on", () => {
    const host = buildWorkHost({ ...input([]), work: work([], "social") });
    expect(host.modulesUi).toBe(false);
    expect(host.module).toBeNull();
  });

  it("with modules on, the chat is for its Work's module", () => {
    const host = buildWorkHost({
      ...input(["instagram"]),
      work: work(["instagram"], "social"),
      modulesUi: true,
    });
    expect(host.modulesUi).toBe(true);
    expect(host.module).toBe("social");
    expect(host.work.module).toBe("social");
  });

  it("a general chat has no module, with modules on or off", () => {
    expect(buildWorkHost({ ...input([]), modulesUi: true }).module).toBeNull();
    expect(buildWorkHost({ ...input([]), modulesUi: false }).module).toBeNull();
  });

  it("a Work read without its module is a general chat", () => {
    // A row read before the column existed (or a test double without it).
    const legacy: Partial<WorkView> = work([]);
    delete legacy.module;
    const host = buildWorkHost({
      ...input([]),
      work: legacy as WorkView,
      modulesUi: true,
    });
    expect(host.module).toBeNull();
  });

  it("the module does not change what the empty screen suggests", () => {
    const plain = buildWorkHost(input(["instagram"]));
    const social = buildWorkHost({
      ...input(["instagram"]),
      work: work(["instagram"], "social"),
      modulesUi: true,
    });
    expect(social.starterCards).toEqual(plain.starterCards);
    expect(social.defaultChannels).toEqual(plain.defaultChannels);
  });
});
