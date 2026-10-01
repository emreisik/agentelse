import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdsInsightCardData } from "@/lib/works/ads-insight";
import type { WorkCardHostInput } from "./work-card-host";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const actions = vi.hoisted(() => ({
  approve: vi.fn(),
  reject: vi.fn(),
  refreshPulse: vi.fn(),
}));
vi.mock("@/server/actions/approval-actions", () => ({
  approveApprovalAction: actions.approve,
  rejectApprovalAction: actions.reject,
}));
vi.mock("@/server/actions/work-ads-actions", () => ({
  refreshAdsPulseAction: actions.refreshPulse,
}));

// Static markup cannot click: the Button records its onClick by label.
const clicks = vi.hoisted(() => new Map<string, () => void>());
vi.mock("@/components/ui/button", async () => {
  const { createElement: h } = await import("react");
  const textOf = (node: unknown): string =>
    typeof node === "string"
      ? node
      : Array.isArray(node)
        ? node.map(textOf).join("")
        : "";
  return {
    buttonVariants: () => "",
    Button: (props: { onClick?: () => void; children?: unknown }) => {
      if (props.onClick) clicks.set(textOf(props.children).trim(), props.onClick);
      return h("button", null, props.children as ReactNode);
    },
  };
});

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

const CARD: AdsInsightCardData = {
  kind: "ads-insight",
  state: "ok",
  asOf: "2026-10-01T08:00:00.000Z",
  currency: "TRY",
  headline: "Spring: cost per lead is 38.20 TRY",
  campaignId: "c1",
  campaignName: "Spring",
  chips: [],
  proposal: {
    taskId: "t1",
    approvalId: "approval-9",
    capability: "META_CAMPAIGN_UPDATE",
    currentDailyBudgetCents: 40000,
    proposedDailyBudgetCents: 50000,
    state: "pending",
    changeText: "Raise the daily budget from 400 TRY to 500 TRY",
  },
};

function render(
  card: AdsInsightCardData,
  initialView?: "review" | "dismissed",
): void {
  clicks.clear();
  renderToStaticMarkup(
    createElement(
      WorkCardHostProvider,
      { value: HOST },
      createElement(AdsInsightCard, { card, initialView }),
    ),
  );
}

const approvalIdSent = (mock: ReturnType<typeof vi.fn>): unknown =>
  (mock.mock.calls[0]?.[0] as FormData | undefined)?.get("approvalId");

beforeEach(() => {
  vi.clearAllMocks();
  actions.approve.mockResolvedValue({ ok: true });
  actions.reject.mockResolvedValue({ ok: true });
  actions.refreshPulse.mockResolvedValue({ ok: true, state: "refreshed" });
});

describe("AdsInsightCard taps (spend consent)", () => {
  it("Review budget change only opens the row: no approval, no rejection", async () => {
    render(CARD);
    const tap = clicks.get("Review budget change");
    expect(tap).toBeTypeOf("function");
    tap?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(actions.approve).not.toHaveBeenCalled();
    expect(actions.reject).not.toHaveBeenCalled();
  });

  it("Approve spend approves exactly this approval and never rejects", async () => {
    render(CARD, "review");
    clicks.get("Approve spend")?.();
    await vi.waitFor(() => expect(actions.approve).toHaveBeenCalledTimes(1));
    expect(approvalIdSent(actions.approve)).toBe("approval-9");
    expect(actions.reject).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
  });

  it("Dismiss rejects this approval and never approves spend", async () => {
    render(CARD, "review");
    clicks.get("Dismiss")?.();
    await vi.waitFor(() => expect(actions.reject).toHaveBeenCalledTimes(1));
    expect(approvalIdSent(actions.reject)).toBe("approval-9");
    expect(actions.approve).not.toHaveBeenCalled();
  });

  it("a refused approval does not refresh as if it worked", async () => {
    actions.approve.mockResolvedValue({ ok: false, message: "No longer valid." });
    render(CARD, "review");
    clicks.get("Approve spend")?.();
    await vi.waitFor(() => expect(actions.approve).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("Check performance reads this Work's pulse and decides nothing", async () => {
    render({ ...CARD, proposal: undefined });
    clicks.get("Check performance")?.();
    await vi.waitFor(() =>
      expect(actions.refreshPulse).toHaveBeenCalledWith("p1", "w1"),
    );
    expect(actions.approve).not.toHaveBeenCalled();
    expect(actions.reject).not.toHaveBeenCalled();
  });
});
