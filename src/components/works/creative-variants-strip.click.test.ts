import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { encodeSseEvent } from "@/server/chat/sse";
import type { ChatStreamEvent } from "@/server/chat/types";
import type { CreativeCardData } from "@/types/creative-card";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const adopt = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/creative-variant-actions", () => ({
  adoptCreativeVariantAction: adopt,
}));

// Static markup cannot click: the Button records its onClick under its
// aria-label (or its text), and a test presses it like a tap would.
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
    Button: (props: {
      onClick?: () => void;
      children?: unknown;
      "aria-label"?: string;
    }) => {
      const label = props["aria-label"] ?? textOf(props.children).trim();
      if (props.onClick) clicks.set(label, props.onClick);
      return h("button", null, props.children as ReactNode);
    },
  };
});

const { CreativeVariantsStrip } = await import("./creative-variants-strip");
const { WorkCardHostProvider } = await import("./work-card-host");

type ReadyCard = Extract<CreativeCardData, { kind: "creative-ready" }>;

const CARD: ReadyCard = {
  kind: "creative-ready",
  title: "Post",
  creativeId: "c1",
  assetId: "a0",
  status: "IN_REVIEW",
  contentFormat: "FEED_SQUARE",
  alternatives: [{ assetId: "a1" }, { assetId: "a2" }],
};

function render(): void {
  clicks.clear();
  renderToStaticMarkup(
    createElement(
      WorkCardHostProvider,
      {
        value: {
          projectId: "p1",
          workId: "w1",
          workTitle: "Launch",
          active: true,
          busy: false,
          producing: new Set<string>(),
          channels: [],
          openTab: () => undefined,
          runNextStep: () => undefined,
        },
      },
      createElement(CreativeVariantsStrip, {
        card: CARD,
        planCommandId: "plan1",
      }),
    ),
  );
}

function sse(events: ChatStreamEvent[]): Response {
  return new Response(events.map(encodeSseEvent).join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  adopt.mockResolvedValue({ ok: true });
});

describe("CreativeVariantsStrip taps", () => {
  it("Use this one adopts exactly that picture of exactly this creative", async () => {
    render();
    clicks.get("Use visual 3 of 3")?.();
    await vi.waitFor(() => expect(adopt).toHaveBeenCalledTimes(1));
    expect(adopt).toHaveBeenCalledWith("c1", "a2");
  });

  it("Make 3 more posts the plan id, the creative id and more:true, then refreshes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sse([{ type: "package.done", started: 1, failed: 0 }]),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      render();
      clicks.get("Make 3 more")?.();
      await vi.waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/projects/p1/chat/variants");
      expect(JSON.parse(String(init.body))).toEqual({
        commandId: "plan1",
        creativeId: "c1",
        more: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a refusal that arrives as an SSE error on HTTP 200 does not refresh as if it worked", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sse([
          { type: "error", code: "BUDGET", message: "Daily budget reached." },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      render();
      clicks.get("Make 3 more")?.();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(router.refresh).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a second tap while the first run streams does not start a second paid run", async () => {
    let finish: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      render();
      const tap = clicks.get("Make 3 more");
      tap?.();
      tap?.();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      finish(sse([{ type: "package.done", started: 1, failed: 0 }]));
      await vi.waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
