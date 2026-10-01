import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { encodeSseEvent } from "@/server/chat/sse";
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
      if (props.onClick) clicks.set(textOf(props.children).trim(), props.onClick);
      return h("button", null, props.children as ReactNode);
    },
  };
});

const { PlannedSlotCard } = await import("./planned-slot-card");
const { WorkCardHostProvider } = await import("./work-card-host");
const { ChatPackageProvider } = await import(
  "@/components/commands/chat-package-context"
);

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;

const CARD: PlanCard = {
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
  slots: [{ id: "slot-creative-1", stage: "PLANNED" }],
};

function render(): void {
  clicks.clear();
  renderToStaticMarkup(
    createElement(
      ChatPackageProvider,
      { value: { start: vi.fn(), startPlan: vi.fn(), runs: {} } },
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
        createElement(PlannedSlotCard, { card: CARD, commandId: "plan-1" }),
      ),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PlannedSlotCard Make 3 visuals tap", () => {
  it("posts the plan id, this slot's creative id and more:false once", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        encodeSseEvent({ type: "package.done", started: 1, failed: 0 }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      render();
      const tap = clicks.get("Make 3 visuals");
      expect(tap).toBeTypeOf("function");
      tap?.();
      await vi.waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/projects/p1/chat/variants");
      expect(JSON.parse(String(init.body))).toEqual({
        commandId: "plan-1",
        creativeId: "slot-creative-1",
        more: false,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a budget refusal (SSE error on HTTP 200) does not refresh as if it worked", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        encodeSseEvent({
          type: "error",
          code: "BUDGET",
          message: "Daily budget reached.",
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      render();
      clicks.get("Make 3 visuals")?.();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(router.refresh).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
