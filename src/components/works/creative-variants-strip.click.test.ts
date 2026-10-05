import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CreativeCardData } from "@/types/creative-card";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

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
      createElement(CreativeVariantsStrip, { card: CARD }),
    ),
  );
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
});
