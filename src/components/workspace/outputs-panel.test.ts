import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  groupOutputs,
  type OutputDelivery,
  type OutputEntry,
  type OutputVerdict,
} from "@/lib/calendar/output-posts";
import { sourceOf } from "@/lib/calendar/source";

// Server actions (prisma, next-auth) never run in a static render.
const actions = vi.hoisted(() => ({
  approvePost: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
}));
vi.mock("@/server/actions/approval-actions", () => ({
  approveApprovalAction: actions.approve,
  rejectApprovalAction: actions.reject,
}));
vi.mock("@/server/actions/post-actions", () => ({
  approvePostAction: actions.approvePost,
}));
vi.mock("@/components/workspace/output-preview-dialog", () => ({
  OutputPreviewDialog: () => null,
}));

const { OutputCard, OutputsPanel, decideEntries } =
  await import("./outputs-panel");

function delivery(overrides: Partial<OutputDelivery> = {}): OutputDelivery {
  return {
    id: "c1",
    postId: "post-1",
    title: "Autumn launch",
    preview: "New season, new colours",
    text: "New season, new colours",
    status: "IN_REVIEW",
    phase: "review",
    kind: "post",
    label: "Instagram · Post",
    source: sourceOf("instagram", null),
    assetId: "a1",
    version: 1,
    approvalId: "ap1",
    createdAt: "2026-10-04T08:00:00.000Z",
    updatedAt: "2026-10-04T08:00:00.000Z",
    scheduledFor: null,
    scheduledLocal: null,
    ...overrides,
  };
}

// One post on Instagram (post + Story) and Facebook, as the server lists it.
const threeChannels = [
  delivery({
    id: "c3",
    label: "Facebook · Post",
    source: sourceOf("facebook", null),
    assetId: "a3",
    approvalId: "ap3",
    createdAt: "2026-10-04T08:00:00.002Z",
  }),
  delivery({
    id: "c2",
    kind: "story",
    label: "Instagram · Story",
    assetId: "a2",
    approvalId: "ap2",
    createdAt: "2026-10-04T08:00:00.001Z",
  }),
  delivery(),
];
const withoutPost = delivery({ id: "c9", postId: null, approvalId: "ap9" });

function only(items: OutputDelivery[]): OutputEntry {
  const entries = groupOutputs(items);
  expect(entries).toHaveLength(1);
  return entries[0]!;
}

function cardProps(
  item: OutputEntry,
  overrides: {
    selecting?: boolean;
    onDecide?: (to: OutputVerdict) => void;
  } = {},
) {
  return {
    item,
    projectId: "p1",
    todayKey: "2026-10-05",
    selecting: overrides.selecting ?? false,
    selected: false,
    deciding: false,
    onOpen: vi.fn(),
    onToggle: vi.fn(),
    onDecide: overrides.onDecide ?? vi.fn(),
  };
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return `${node}`;
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return textOf(node.props.children);
  }
  return "";
}

// Static markup cannot click: find the card's own <button> by its text and
// press it like a tap would.
function press(node: ReactNode, label: string): boolean {
  if (Array.isArray(node)) return node.some((child) => press(child, label));
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) {
    return false;
  }
  if (node.type === "button" && textOf(node.props.children).trim() === label) {
    node.props.onClick?.();
    return true;
  }
  return press(node.props.children, label);
}

function marks(html: string): number {
  return html.match(/data-delivery="/g)?.length ?? 0;
}

beforeEach(() => {
  vi.clearAllMocks();
  actions.approvePost.mockResolvedValue({ ok: true });
  actions.approve.mockResolvedValue({ ok: true });
  actions.reject.mockResolvedValue({ ok: true });
});

// The tab reads its own data client-side: the first paint is the shell with a
// skeleton, not a list baked into the project page.
describe("OutputsPanel", () => {
  it("renders the search, status strip and sort control", () => {
    const html = renderToStaticMarkup(
      createElement(OutputsPanel, { projectId: "p1", timezone: "UTC" }),
    );
    expect(html).toContain('aria-label="Search outputs"');
    expect(html).toContain('aria-label="Status"');
    expect(html).toContain("Newest");
    expect(html).toContain("animate-pulse");
  });
});

describe("OutputCard: one card per post", () => {
  it("shows a post's three channels as one card with their three icons", () => {
    const html = renderToStaticMarkup(
      createElement(OutputCard, cardProps(only(threeChannels))),
    );
    expect(marks(html)).toBe(3);
    // Each channel says its own state and opens on its own.
    expect(html).toContain(
      'aria-label="Open Instagram · Story · Needs review"',
    );
    expect(html).toContain('aria-label="Open Facebook · Post · Needs review"');
    expect(html).toContain("Approve post");
    // A channel is declined in its own preview, not for the whole post here.
    expect(html).not.toContain('aria-label="Reject"');
  });

  it("only shows the channels while selecting", () => {
    const html = renderToStaticMarkup(
      createElement(
        OutputCard,
        cardProps(only(threeChannels), { selecting: true }),
      ),
    );
    expect(marks(html)).toBe(3);
    expect(html).not.toContain('aria-label="Open Instagram · Story');
    expect(html).not.toContain("Approve post");
  });

  it("approves the whole post with one approvePostAction call", async () => {
    const entry = only(threeChannels);
    const decided: string[] = [];
    let running: Promise<unknown> | undefined;
    const onDecide = vi.fn((to: OutputVerdict) => {
      running = decideEntries([entry], to, (done) => decided.push(done.id));
    });

    expect(
      press(OutputCard(cardProps(entry, { onDecide })), "Approve post"),
    ).toBe(true);
    await running;

    expect(onDecide).toHaveBeenCalledWith("APPROVED");
    expect(actions.approvePost).toHaveBeenCalledTimes(1);
    expect(actions.approvePost).toHaveBeenCalledWith("post-1");
    expect(actions.approve).not.toHaveBeenCalled();
    expect(decided).toEqual(["c1"]);
  });

  it("keeps a piece without a post on its own approval and decline", async () => {
    const entry = only([withoutPost]);
    const html = renderToStaticMarkup(
      createElement(OutputCard, cardProps(entry)),
    );
    expect(marks(html)).toBe(0);
    expect(html).toContain('aria-label="Reject"');

    await decideEntries([entry], "APPROVED");
    await decideEntries([entry], "REJECTED");
    expect(actions.approvePost).not.toHaveBeenCalled();
    expect(actions.approve).toHaveBeenCalledTimes(1);
    expect(
      (actions.approve.mock.calls[0]?.[0] as FormData).get("approvalId"),
    ).toBe("ap9");
    expect(actions.reject).toHaveBeenCalledTimes(1);
  });

  it("reports a refusal and skips a card with no such decision", async () => {
    actions.approvePost.mockResolvedValue({
      ok: false,
      message: "Every channel of this post needs its content first.",
    });
    const post = only(threeChannels);
    expect(await decideEntries([post], "APPROVED")).toEqual({
      done: 0,
      failure: "Every channel of this post needs its content first.",
    });
    expect(await decideEntries([post], "REJECTED")).toEqual({
      done: 0,
      failure: null,
    });
    expect(actions.reject).not.toHaveBeenCalled();
  });
});
