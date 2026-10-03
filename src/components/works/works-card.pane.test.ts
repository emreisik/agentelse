import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { IdeaEventCardData } from "@/types/idea-event-card";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useParams: () => ({ projectId: "proj-1" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
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
for (const file of [
  "agency-work-actions",
  "approval-actions",
  "command-actions",
  "content-plan-actions",
  "creative-actions",
  "facebook-share-actions",
  "human-action-actions",
  "master-content-actions",
  "work-ads-actions",
  "creative-variant-actions",
  "plan-options-actions",
  "plan-progress-actions",
  "publish-actions",
  "schedule-slots-actions",
  "slot-suggest-actions",
  "work-actions",
]) {
  vi.doMock(`@/server/actions/${file}`, inert);
}
vi.mock("@/components/workspace/output-preview-dialog", () => ({
  OutputPreviewDialog: () => null,
}));

// Whether the page has the workspace pane (the project's chat) or not.
const pane = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/components/workspace/workspace-panel-toggle", () => ({
  useWorkspaceDetail: () => pane.value,
}));

const { IdeaEventCard } = await import("@/components/commands/idea-event-card");
const { ChatPackageProvider } =
  await import("@/components/commands/chat-package-context");
const { WorkCardHostProvider } = await import("./work-card-host");
const { PaneCard } = await import("./pane-card");
const { inPane, renderWorksCard } = await import("./works-card");

import type { WorkCardHostInput } from "./work-card-host";

const HOST: WorkCardHostInput = {
  projectId: "proj-1",
  workId: "w1",
  workTitle: "Launch week",
  active: true,
  busy: false,
  producing: new Set<string>(),
  channels: [],
  openTab: () => undefined,
  runNextStep: () => undefined,
};
const chat = { start: vi.fn(), startPlan: vi.fn(), runs: {} };

const card = (value: unknown) => value as IdeaEventCardData;

const options = card({
  kind: "content-plan-options",
  title: "BidUniq farkındalık haftası",
  reason: "Three angles.",
  timezone: "Europe/Istanbul",
  state: "open",
  slots: [
    {
      date: "2026-10-03",
      time: "10:00",
      channel: "instagram",
      formatKey: "instagram.post",
    },
  ],
  options: [
    {
      id: "a",
      label: "A",
      angle: "x",
      ideas: [{ topic: "t", captionIdea: "c" }],
    },
    {
      id: "b",
      label: "B",
      angle: "y",
      ideas: [{ topic: "t", captionIdea: "c" }],
    },
  ],
});
const ideas = card({
  kind: "idea-options",
  title: "3 ideas for Instagram",
  reason: "r",
  items: [{ ideaId: "i1", title: "a", description: "a" }],
});
const master = card({
  kind: "master-content",
  title: "Launch message",
  state: "draft",
  master: { title: "t", message: "m" },
  targets: [
    { channel: "instagram", formatKey: "instagram.post", included: true },
  ],
});
const ads = card({
  kind: "ads-insight",
  state: "ok",
  chips: [],
  headline: "Spring: cost per lead is $4",
});
const pkg = card({
  kind: "content-package",
  topic: "Spring launch",
  state: "draft",
  items: [{ id: "1", deliverable: "SOCIAL_POST", title: "a", angle: "a" }],
});
const planItem = (date: string) => ({
  date,
  time: "10:00",
  channel: "instagram",
  platform: "INSTAGRAM",
  format: "post",
  topic: "t",
  captionIdea: "c",
});
const multiPlan = card({
  kind: "content-plan-draft",
  title: "Autumn week",
  timezone: "Europe/Istanbul",
  state: "draft",
  items: [planItem("2026-10-03"), planItem("2026-10-05")],
});
const slotPlan = card({
  kind: "content-plan-draft",
  title: "One post",
  timezone: "Europe/Istanbul",
  state: "draft",
  via: "idea",
  items: [planItem("2026-10-03")],
});

const render = (c: IdeaEventCardData, workspacePane: unknown) => {
  pane.value = workspacePane;
  return renderToStaticMarkup(
    createElement(
      ChatPackageProvider,
      { value: chat },
      createElement(
        WorkCardHostProvider,
        { value: HOST },
        createElement(IdeaEventCard, { card: c, commandId: "cmd1" }),
      ),
    ),
  );
};

const PANE = {
  detail: null,
  detailContainer: null,
  openDetail: () => undefined,
  closeDetail: () => undefined,
  registerCard: () => () => undefined,
};

describe("long cards in a chat with a pane are one compact card", () => {
  const cases: [string, IdeaEventCardData, string][] = [
    ["plan directions", options, "2 directions · 1 post · Instagram"],
    ["idea options", ideas, "1 idea"],
    ["master content", master, "1 channel · Instagram"],
    ["the Meta Ads card", ads, "Spring: cost per lead is $4"],
    ["a content package", pkg, "1 piece"],
    [
      "a plan of several posts",
      multiPlan,
      "2 posts · Oct 3 – Oct 5 · Instagram",
    ],
  ];

  for (const [name, c, subtitle] of cases) {
    it(`${name}: a compact card in the chat, the whole card not`, () => {
      const html = render(c, PANE);
      expect(html).toContain("data-card-compact");
      expect(html).toContain(subtitle);
      // A compact card is one button; the whole card has many.
      expect(html.match(/<button/g)).toHaveLength(1);
    });
  }

  it("the card the pane has open is rendered into the pane, not into the chat", () => {
    const html = render(master, {
      ...PANE,
      detail: { id: "cmd1", title: "Launch message" },
      detailContainer: null,
    });
    expect(html).toContain('aria-expanded="true"');
    expect(html.match(/<button/g)).toHaveLength(1);
  });
});

describe("what stays in the chat", () => {
  it("a plan of one post from an idea is the planned-slot card, not a compact card", () => {
    const html = render(slotPlan, PANE);
    expect(html).not.toContain("data-card-compact");
    // The planned-slot card itself: its own receipt line, in the chat.
    expect(html).toContain("Added to your calendar");
  });

  it("short cards are untouched", () => {
    for (const short of [
      card({ kind: "signal", title: "T", summary: "S" }),
      card({ kind: "finding", title: "T", statement: "S" }),
    ]) {
      const html = render(short, PANE);
      expect(html).not.toContain("data-card-compact");
      expect(html).toContain(">T<");
    }
  });
});

describe("without a pane (any page but the project's chat) the cards are shown in full, as before", () => {
  for (const [name, c, inside] of [
    ["plan directions", options, "Use this direction"],
    ["idea options", ideas, "Plan it"],
    ["master content", master, "Draft"],
    ["a content package", pkg, "Create selected"],
    ["a plan of several posts", multiPlan, "Autumn week"],
  ] as const) {
    it(name, () => {
      const html = render(c, null);
      expect(html).not.toContain("data-card-compact");
      // The whole card, with what only it has.
      expect(html).toContain(inside);
    });
  }
});

// A card that changes in place (directions -> plan, same Command) must keep its
// wrapper, or an open pane would close under the person's hands.
describe("inPane", () => {
  const body = createElement("div", null, "full");

  it("returns the element itself for a card that stays in the chat", () => {
    expect(inPane(slotPlan, "cmd1", body)).toBe(body);
    expect(inPane(card({ kind: "task-result" }), "cmd1", body)).toBe(body);
  });

  it("wraps a long card in a PaneCard keyed by its Command", () => {
    const wrapped = inPane(options, "cmd1", body) as ReactElement<{
      cardId: string;
    }>;
    expect(wrapped.type).toBe(PaneCard);
    expect(wrapped.key).toBe("pane-cmd1");
    expect(wrapped.props.cardId).toBe("cmd1");
  });

  it("keeps the same wrapper identity when the card changes kind in place", () => {
    const before = inPane(options, "cmd1", body) as ReactElement;
    const after = inPane(
      multiPlan,
      "cmd1",
      createElement("span"),
    ) as ReactElement;
    expect(after.type).toBe(before.type);
    expect(after.key).toBe(before.key);
  });

  it("falls back to the card's title while the Command is not known yet (a streamed card)", () => {
    const wrapped = inPane(options, undefined, body) as ReactElement<{
      cardId: string;
    }>;
    expect(wrapped.props.cardId).toBe("BidUniq farkındalık haftası");
  });

  it("renderWorksCard wraps directions, ideas, master and ads; the daily brief stays", () => {
    const host = HOST as never;
    for (const c of [options, ideas, master, ads]) {
      const out = renderWorksCard(c, {
        commandId: "cmd1",
        host,
      }) as ReactElement;
      expect(out.type).toBe(PaneCard);
    }
    const brief = renderWorksCard(card({ kind: "daily-brief", title: "t" }), {
      commandId: "cmd1",
      host,
    }) as ReactElement;
    expect(brief.type).not.toBe(PaneCard);
  });
});
