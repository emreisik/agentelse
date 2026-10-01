import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  DiscoveryStatus,
  DiscoveryView,
} from "@/lib/guided-discovery/contract";

vi.mock("@assistant-ui/react", () => ({ useAuiState: () => 0 }));

const { discoveryEntryOf } = await import("./discovery-entry");
const { DiscoveryChip, DiscoveryWelcomeCard } = await import(
  "./discovery-entry-view"
);

const view = (status: DiscoveryStatus): DiscoveryView => ({
  rev: "a".repeat(12),
  status,
  stages: { site: "done", identity: "done", research: "done", profile: "done" },
  identity: null,
  rows: [],
  host: null,
  failure: null,
  canRetry: false,
  brandName: "Acme",
});

describe("discoveryEntryOf", () => {
  it("no row: start", () => {
    expect(discoveryEntryOf(null, "Acme")).toEqual({
      label: "Set up your brand",
      kind: "start",
      welcome: true,
      chip: true,
    });
  });

  it("RUNNING carries the brand name", () => {
    expect(discoveryEntryOf(view("RUNNING"), "Acme")).toEqual({
      label: "Getting to know Acme…",
      kind: "running",
      welcome: true,
      chip: true,
    });
  });

  it("READY: review", () => {
    expect(discoveryEntryOf(view("READY"), "Acme")).toEqual({
      label: "Review your brand profile",
      kind: "review",
      welcome: true,
      chip: true,
    });
  });

  it("CONFIRMED: update, and neither welcome card nor chip", () => {
    expect(discoveryEntryOf(view("CONFIRMED"), "Acme")).toEqual({
      label: "Update your setup",
      kind: "update",
      welcome: false,
      chip: false,
    });
  });

  it("FAILED reads as start so the person can get back in", () => {
    const entry = discoveryEntryOf(view("FAILED"), "Acme");
    expect(entry.kind).toBe("start");
    expect(entry.welcome && entry.chip).toBe(true);
  });
});

describe("entry components: empty and non-empty thread", () => {
  const noop = () => {};
  const card = (status: DiscoveryStatus | null) =>
    renderToStaticMarkup(
      createElement(DiscoveryWelcomeCard, {
        entry: discoveryEntryOf(status ? view(status) : null, "Acme"),
        disabled: false,
        onOpen: noop,
      }),
    );
  const chip = (
    status: DiscoveryStatus | null,
    o: { threadEmpty: boolean; dismissed?: boolean },
  ) =>
    renderToStaticMarkup(
      createElement(DiscoveryChip, {
        entry: discoveryEntryOf(status ? view(status) : null, "Acme"),
        threadEmpty: o.threadEmpty,
        dismissed: o.dismissed ?? false,
        disabled: false,
        onOpen: noop,
        onDismiss: noop,
      }),
    );

  it("welcome card shows with every state but CONFIRMED", () => {
    expect(card(null)).toContain("Set up your brand");
    expect(card("RUNNING")).toContain("Getting to know Acme…");
    expect(card("READY")).toContain("Review your brand profile");
    expect(card("FAILED")).toContain("Set up your brand");
    expect(card("CONFIRMED")).toBe("");
  });

  it("chip shows only on a non-empty thread, not dismissed, not CONFIRMED", () => {
    expect(chip(null, { threadEmpty: false })).toContain("Set up your brand");
    expect(chip("READY", { threadEmpty: false })).toContain(
      "Review your brand profile",
    );
    expect(chip("RUNNING", { threadEmpty: true })).toBe("");
    expect(chip("READY", { threadEmpty: false, dismissed: true })).toBe("");
    expect(chip("CONFIRMED", { threadEmpty: false })).toBe("");
  });

  it("the welcome card and the chip are never both visible", () => {
    for (const status of [null, "RUNNING", "READY", "FAILED"] as const) {
      const empty = chip(status, { threadEmpty: true });
      const full = chip(status, { threadEmpty: false });
      expect(empty === "" || full === "").toBe(true);
    }
  });
});
