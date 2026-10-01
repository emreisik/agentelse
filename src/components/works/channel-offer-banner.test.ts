import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/server/actions/work-actions", () => ({ openChannelWorkAction: vi.fn() }));

import { ChannelOfferBannerView } from "./channel-offer-banner";
import { offersFor } from "./channel-offers-for";
import { integrationParamOf } from "@/lib/works/work";
import type { ChannelConnections } from "@/lib/content-channels";

const connected = (...keys: string[]) =>
  Object.fromEntries(keys.map((k) => [k, { connected: true }])) as unknown as ChannelConnections;

describe("ChannelOfferBannerView", () => {
  const render = (props: Partial<Parameters<typeof ChannelOfferBannerView>[0]>) =>
    renderToStaticMarkup(
      createElement(ChannelOfferBannerView, {
        channels: ["instagram"],
        pendingKey: null,
        error: null,
        onOpen: () => {},
        ...props,
      }),
    );

  it("renders a row and a tall button per channel", () => {
    const html = render({ channels: ["instagram", "x"] });
    expect(html).toContain("Instagram is connected.");
    expect(html).toContain("Open a Work for Instagram");
    expect(html).toContain("Open a Work for X");
    expect(html).toContain("min-h-11");
  });

  it("shows the busy label and the error", () => {
    const html = render({ pendingKey: "instagram", error: "Couldn't open a Work. Try again." });
    expect(html).toContain("Opening…");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Couldn&#x27;t open a Work. Try again.");
  });

  it("renders nothing for an empty list", () => {
    expect(render({ channels: [] })).toBe("");
  });
});

describe("offersFor", () => {
  it("is empty with the flag off", () => {
    expect(offersFor(false, connected("instagram"), [])).toEqual([]);
  });

  it("offers a connected channel no Work covers", () => {
    expect(offersFor(true, connected("instagram"), [])).toEqual(["instagram"]);
  });

  it("does not offer a channel covered by an ACTIVE Work", () => {
    const coverage = [{ id: "w1", channels: ["instagram" as const], status: "ACTIVE" }];
    expect(offersFor(true, connected("instagram"), coverage)).toEqual([]);
  });

  it("still offers a channel only a DONE Work or a Today Work covers", () => {
    const coverage = [
      { id: "w1", channels: ["instagram" as const], status: "DONE" },
      { id: "today_2026-10-01", channels: ["instagram" as const], status: "ACTIVE" },
    ];
    expect(offersFor(true, connected("instagram"), coverage)).toEqual(["instagram"]);
  });

  it("ignores disconnected channels", () => {
    expect(offersFor(true, {} as ChannelConnections, [])).toEqual([]);
  });
});

describe("integrationParamOf", () => {
  it("maps ads to meta_ads", () => {
    expect(integrationParamOf("ads")).toBe("meta_ads");
  });
});
