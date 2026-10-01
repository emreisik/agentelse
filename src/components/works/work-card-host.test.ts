import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  WorkCardHostProvider,
  createHostRegistry,
  normalizeAnnouncement,
  useWorkCardHost,
  type WorkCardHostInput,
} from "./work-card-host";

const INPUT: WorkCardHostInput = {
  projectId: "p1",
  workId: "w1",
  workTitle: "Week",
  active: true,
  busy: false,
  producing: new Set<string>(),
  channels: [],
  openTab: () => undefined,
  runNextStep: () => undefined,
};

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("WorkCardHostProvider (W75 host-announce)", () => {
  it("renders ONE polite sr-only live region, outside any card", () => {
    const html = renderToStaticMarkup(
      createElement(
        WorkCardHostProvider,
        { value: INPUT },
        createElement("div", { "data-card": "x" }, "card"),
      ),
    );
    expect(count(html, 'role="status"')).toBe(1);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("sr-only");
    // The region is the provider's, a sibling of the card, never inside it.
    expect(html).toMatch(/<div data-card="x">card<\/div><div role="status"/);
  });

  it("shows an announcement in the region and hands the host to children", () => {
    function Probe() {
      const host = useWorkCardHost();
      host?.announce("Plan ready: Launch week.");
      return createElement("span", null, host ? host.workTitle : "no host");
    }
    const html = renderToStaticMarkup(
      createElement(WorkCardHostProvider, { value: INPUT }, createElement(Probe)),
    );
    expect(html).toContain("<span>Week</span>");
    expect(html).toContain(">Plan ready: Launch week.</div>");
  });

  it("is null outside a Work", () => {
    function Probe() {
      return createElement("span", null, useWorkCardHost() === null ? "null" : "set");
    }
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>null</span>");
  });
});

describe("host registry (W75 host-announce)", () => {
  it("announce sets the text and notifies subscribers", () => {
    const registry = createHostRegistry();
    let calls = 0;
    const off = registry.subscribe(() => {
      calls += 1;
    });
    expect(registry.getMessage()).toBe("");
    registry.announce("Idea swapped.");
    expect(registry.getMessage()).toBe("Idea swapped.");
    expect(calls).toBe(1);
    off();
    registry.announce("Other.");
    expect(calls).toBe(1);
  });

  it("falls back to Card updated. for an empty or missing message", () => {
    expect(normalizeAnnouncement("")).toBe("Card updated.");
    expect(normalizeAnnouncement("   ")).toBe("Card updated.");
    expect(normalizeAnnouncement(undefined)).toBe("Card updated.");
    expect(normalizeAnnouncement(null)).toBe("Card updated.");
    const registry = createHostRegistry();
    registry.announce(undefined);
    expect(registry.getMessage()).toBe("Card updated.");
  });

  it("a repeated message is still a change for the live region", () => {
    const registry = createHostRegistry();
    registry.announce("Card updated.");
    const first = registry.getMessage();
    registry.announce("Card updated.");
    expect(registry.getMessage()).not.toBe(first);
    expect(registry.getMessage().trim()).toBe("Card updated.");
  });

  it("a focus request is consumed by exactly one new card, once", () => {
    const registry = createHostRegistry();
    expect(registry.consumeFocus("c1")).toBe(false);
    registry.requestFocus("c1");
    expect(registry.consumeFocus("c2")).toBe(false);
    expect(registry.consumeFocus("c1")).toBe(true);
    expect(registry.consumeFocus("c1")).toBe(false);
  });
});
