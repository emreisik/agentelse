import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IdeaEventCardData } from "@/types/idea-event-card";

// The server renderer refuses startTransition; a tap must still run its action.
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useTransition: () =>
      [false, (callback: () => void) => callback()] as ReturnType<
        typeof actual.useTransition
      >,
  };
});

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useParams: () => ({ projectId: "p1" }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// No server action module may reach a database from a static render.
const inert = vi.hoisted(
  () => () =>
    new Proxy(
      {},
      {
        get: (_target, key) =>
          key === "then" || key === "__esModule" ? undefined : () => undefined,
      },
    ),
);
vi.mock("@/server/actions/schedule-slots-actions", inert);
vi.mock("@/server/actions/slot-suggest-actions", inert);
vi.mock("@/server/actions/work-actions", inert);

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
      if (props.onClick)
        clicks.set(textOf(props.children).trim(), props.onClick);
      return h("button", null, props.children as ReactNode);
    },
  };
});

const { PlannedSlotCard } = await import("./planned-slot-card");
const { WorkCardHostProvider } = await import("./work-card-host");
const { ChatPackageProvider } =
  await import("@/components/commands/chat-package-context");

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;
type Slot = NonNullable<NonNullable<PlanCard["slots"]>[number]>;

const startPlan = vi.fn().mockResolvedValue({ ok: true });

function card(slot: Slot): PlanCard {
  return {
    kind: "content-plan-draft",
    title: "One post",
    timezone: "Europe/Istanbul",
    state: "saved",
    via: "idea",
    items: [
      {
        date: "2026-10-05",
        time: "10:00",
        platform: "INSTAGRAM",
        channel: "instagram",
        formatKey: "instagram.post",
        topic: "Studio",
        captionIdea: "Look",
      },
    ],
    slots: [slot],
  };
}

function render(plan: PlanCard): string {
  clicks.clear();
  return renderToStaticMarkup(
    createElement(
      ChatPackageProvider,
      { value: { start: vi.fn(), startPlan, runs: {} } },
      createElement(
        WorkCardHostProvider,
        {
          value: {
            projectId: "p1",
            workId: "w1",
            workTitle: "Week",
            active: true,
            busy: false,
            producing: new Set<string>(),
            channels: [],
            openTab: () => undefined,
            runNextStep: () => undefined,
          },
        },
        createElement(PlannedSlotCard, { card: plan, commandId: "plan-1" }),
      ),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  startPlan.mockResolvedValue({ ok: true });
});

describe("PlannedSlotCard Make post tap (one post, one picture)", () => {
  it("makes only this post, live through the chat's plan run, and calls no variants route", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const html = render(
        card({ id: "slot-creative-1", stage: "PLANNED", postId: "post-1" }),
      );
      // One picture: the old three-picture offer is gone.
      expect(html).not.toContain("Make 3 visuals");
      expect(html).not.toContain("Makes 3 pictures");
      expect(html).toContain("Making it costs about $0.08.");
      clicks.get("Make post")?.();
      await vi.waitFor(() => expect(startPlan).toHaveBeenCalledTimes(1));
      expect(startPlan).toHaveBeenCalledWith({
        commandId: "plan-1",
        postId: "post-1",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a plan saved before posts (no post id) makes the plan's one piece", async () => {
    render(card({ id: "slot-creative-1", stage: "PLANNED" }));
    clicks.get("Make post")?.();
    await vi.waitFor(() => expect(startPlan).toHaveBeenCalledTimes(1));
    expect(startPlan).toHaveBeenCalledWith({ commandId: "plan-1" });
  });

  it("Try again on a failed post makes the same post again", async () => {
    render(card({ id: "slot-creative-1", stage: "FAILED", postId: "post-1" }));
    clicks.get("Try again")?.();
    await vi.waitFor(() => expect(startPlan).toHaveBeenCalledTimes(1));
    expect(startPlan).toHaveBeenCalledWith({
      commandId: "plan-1",
      postId: "post-1",
    });
  });
});
