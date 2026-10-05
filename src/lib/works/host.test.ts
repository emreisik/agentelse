import { describe, expect, it } from "vitest";

import { buildWorkHost } from "./host";
import type { WorkView } from "./work";

const work = (channels: WorkView["channels"]): WorkView => ({
  id: "w1",
  title: "New Work",
  summary: null,
  status: "ACTIVE",
  channels,
  acknowledgedUnconnected: [],
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
    const host = buildWorkHost({ ...input(["instagram"], false), timezone: "Europe/Skopje" });
    const connect = host.starterCards.find((c) => c.id === "connect");
    expect(connect?.action).toEqual({
      kind: "link",
      href: "/projects/p1/integrations?integration=instagram&from=w1",
    });
    expect(host.timezone).toBe("Europe/Skopje");
  });

  it("with AI off the only suggestion is the calendar", () => {
    const host = buildWorkHost({ ...input([]), today: "2026-10-01", aiOff: true });
    expect(host.starterCards.map((c) => c.id)).toEqual(["ai-off"]);
    expect("timezone" in host).toBe(false);
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
      connections: { instagram: { connected: true }, linkedin: { connected: false } },
    });
    expect(host.defaultChannels).toEqual([]);
    expect(host.starterCards[0]?.line).toBe("Plan the week for LinkedIn");
  });
});
