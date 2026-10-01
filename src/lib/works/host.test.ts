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
  it("has no starter cards until a channel is chosen, but offers the chooser's options", () => {
    const host = buildWorkHost(input([]));
    expect(host.starterCards).toEqual([]);
    expect(host.channelOptions).toHaveLength(6);
    expect(host.anyConnected).toBe(true);
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

  it("with today it builds the brief message, without it the old text", () => {
    const withToday = buildWorkHost({ ...input(["instagram"]), today: "2026-10-01" });
    const action = withToday.starterCards[0]?.primary.action;
    expect(action?.kind === "send" && action.text).toContain("\n[Plan brief] ");
    const plain = buildWorkHost(input(["instagram"]));
    const old = plain.starterCards[0]?.primary.action;
    expect(old).toEqual({ kind: "send", text: "Plan the week for Instagram." });
  });

  it("passes the Work id on to the connect link and exposes the timezone", () => {
    const host = buildWorkHost({ ...input(["instagram"], false), timezone: "Europe/Skopje" });
    const connect = host.starterCards.find((c) => c.id === "connect");
    expect(connect?.primary.action).toEqual({
      kind: "link",
      href: "/projects/p1/integrations?integration=instagram&from=w1",
    });
    expect(host.timezone).toBe("Europe/Skopje");
  });

  it("a channel-less Work stays unchanged even with the new inputs", () => {
    const host = buildWorkHost({ ...input([]), today: "2026-10-01", aiOff: true });
    expect(host.starterCards).toEqual([]);
    expect("timezone" in host).toBe(false);
  });
});
