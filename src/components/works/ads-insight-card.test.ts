import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AdsInsightCardData } from "@/lib/works/ads-insight";
import type { WorkCardHostInput } from "./work-card-host";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/server/actions/approval-actions", () => ({
  approveApprovalAction: vi.fn(),
  rejectApprovalAction: vi.fn(),
}));
vi.mock("@/server/actions/work-ads-actions", () => ({
  refreshAdsPulseAction: vi.fn(),
}));

const { AdsInsightCard } = await import("./ads-insight-card");
const { WorkCardHostProvider } = await import("./work-card-host");

const HOST: WorkCardHostInput = {
  projectId: "p1",
  workId: "w1",
  workTitle: "Today",
  active: true,
  busy: false,
  producing: new Set<string>(),
  channels: [],
  openTab: () => undefined,
  runNextStep: () => undefined,
};

function render(
  card: AdsInsightCardData,
  withHost = true,
  initialView?: "review" | "dismissed",
): string {
  const node = createElement(AdsInsightCard, { card, initialView });
  return renderToStaticMarkup(
    withHost
      ? createElement(WorkCardHostProvider, { value: HOST }, node)
      : node,
  );
}

const OK: AdsInsightCardData = {
  kind: "ads-insight",
  state: "ok",
  asOf: "2026-10-01T08:00:00.000Z",
  currency: "TRY",
  headline: "Spring: cost per Leads is 38.20 TRY",
  campaignId: "c1",
  campaignName: "Spring",
  chips: [{ label: "CPL", value: "38.20 TRY", tone: "neutral" }],
};

const PROPOSAL: NonNullable<AdsInsightCardData["proposal"]> = {
  taskId: "t1",
  approvalId: "a1",
  capability: "META_CAMPAIGN_UPDATE",
  currentDailyBudgetCents: 40000,
  proposedDailyBudgetCents: 50000,
  state: "pending",
  changeText: "Raise the daily budget from 400 TRY to 500 TRY",
};

const primaries = (html: string) =>
  (html.match(/data-emphasis="primary"/g) ?? []).length;

describe("AdsInsightCard guard W110 (ads-card-ui)", () => {
  it("renders nothing without a host", () => {
    expect(render(OK, false)).toBe("");
  });

  it("ok without a proposal: Check performance is the one primary", () => {
    const html = render(OK);
    expect(html).toContain("Meta Ads");
    expect(html).toContain("Spring: cost per Leads is 38.20 TRY");
    expect(html).toContain("Check performance");
    expect(html).toContain("Preview campaign");
    expect(html).toContain("Open Ads Manager");
    expect(html).toContain("As of Oct 1");
    expect(html).toContain("campaignDetail=c1");
    expect(primaries(html)).toBe(1);
  });

  it("pending proposal: the primary is the verb and the row is closed", () => {
    const html = render({ ...OK, proposal: PROPOSAL });
    expect(html).toContain("Review budget change");
    expect(html).not.toContain("Approve spend");
    expect(html).not.toContain("Check performance");
    expect(primaries(html)).toBe(1);
  });

  it("a pause proposal says pause on the button and in the row", () => {
    const pause: NonNullable<AdsInsightCardData["proposal"]> = {
      ...PROPOSAL,
      proposedDailyBudgetCents: undefined,
      proposedStatus: "PAUSED",
      changeText: "Pause this campaign (waiting for your approval)",
    };
    const closed = render({ ...OK, proposal: pause });
    expect(closed).toContain("Review pause");
    expect(closed).not.toContain("Review budget change");
    const open = render({ ...OK, proposal: pause }, true, "review");
    expect(open).toContain("Pause this campaign (waiting for your approval)");
    expect(open).toContain("Approve pause");
    expect(open).not.toContain("Approve spend");
    expect(open).not.toContain("daily budget");
    expect(primaries(open)).toBe(1);
  });

  it("changed proposal: note plus only Dismiss", () => {
    const html = render({
      ...OK,
      proposal: { ...PROPOSAL, state: "changed" },
    });
    expect(html).toContain("The budget changed since this was proposed.");
    expect(html).toContain("Dismiss");
    expect(html).not.toContain("Review budget change");
    expect(html).not.toContain("Approve spend");
    expect(primaries(html)).toBe(1);
  });

  const states: [AdsInsightCardData["state"], string, string][] = [
    ["needs-connect", "Connect Meta Ads to see cost per lead", "Connect Meta Ads"],
    ["needs-account", "no ad account is selected", "Pick an ad account"],
    ["no-data", "The first check runs within a few hours", "Check performance"],
    ["nothing", "No active campaign with spend", "Check performance"],
    ["stale", "These numbers are from Oct 1", "Check performance"],
    ["error", "read Meta Ads", "Check performance"],
  ];
  it.each(states)("%s has its text and exactly one primary", (state, text, action) => {
    const html = render({
      kind: "ads-insight",
      state,
      asOf: "2026-10-01T08:00:00.000Z",
      chips: [],
    });
    expect(html).toContain(text);
    expect(html).toContain(action);
    expect(primaries(html)).toBe(1);
  });

  it("connect links use ?integration=meta_ads, never ?connect=", () => {
    for (const state of ["needs-connect", "needs-account"] as const) {
      const html = render({ kind: "ads-insight", state, chips: [] });
      expect(html).toContain("/projects/p1/integrations?integration=meta_ads");
      expect(html).not.toContain("connect=");
    }
  });

  it("the open row names the change with amounts for a cents currency", () => {
    const html = render({ ...OK, proposal: PROPOSAL }, true, "review");
    expect(html).toContain("Raise the daily budget from 400 TRY to 500 TRY");
    expect(html).toContain("Approve spend");
    expect(html).toContain("Dismiss");
    expect(html).not.toContain("Review budget change");
    expect(primaries(html)).toBe(1);
  });

  it("the open row prints no amount for JPY or an unknown currency", () => {
    for (const currency of ["JPY", undefined]) {
      const html = render(
        { ...OK, currency, proposal: PROPOSAL },
        true,
        "review",
      );
      expect(html).toContain(
        "Change the daily budget (waiting for your approval)",
      );
      expect(html).not.toContain("Raise the daily budget");
      expect(html).not.toMatch(/\b(400|500|40000|50000)\b/);
    }
  });

  it("after Dismiss the person is told it may come back", () => {
    const html = render({ ...OK, proposal: PROPOSAL }, true, "dismissed");
    expect(html).toContain("Dismissed. It may come back after the next check.");
    expect(html).not.toContain("Review budget change");
    expect(html).toContain("Check performance");
    expect(primaries(html)).toBe(1);
  });

  it("the review row never prints an amount without a usable currency", async () => {
    // The row is local state; test the same helper the row renders.
    const { proposalChangeText } = await import("@/lib/works/ads-insight");
    expect(proposalChangeText(40000, 50000, "TRY")).toBe(
      "Raise the daily budget from 400 TRY to 500 TRY",
    );
    for (const currency of ["JPY", undefined, ""]) {
      const text = proposalChangeText(40000, 50000, currency);
      expect(text).toBe("Change the daily budget (waiting for your approval)");
    }
  });

  it("the card source asks proposalChangeText with the card currency", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("./ads-insight-card.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/proposalChangeText\(/);
    expect(source).toMatch(/card\.currency/);
    expect(source).not.toMatch(/proposal\.changeText/);
  });
});
