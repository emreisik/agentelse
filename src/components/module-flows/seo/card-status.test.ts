import { describe, expect, it, vi } from "vitest";

import type { SeoCardStatus } from "@/server/modules/seo/card-status";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useParams: () => ({ projectId: "p1" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/seo-flow-actions", () => ({
  goToSeoStepAction: vi.fn(),
  researchSeoAction: vi.fn(),
  rewriteSeoArticleAction: vi.fn(),
  writeSeoArticleAction: vi.fn(),
  seoBriefDefaultsAction: vi.fn(),
}));
vi.mock("@/server/actions/seo-mode-actions", () => ({
  checkSeoNowAction: vi.fn(),
  confirmSeoLiveAction: vi.fn(),
  undoSeoAppliedAction: vi.fn(),
  researchRefreshAction: vi.fn(),
  suggestSnippetAction: vi.fn(),
}));

const { cardStatusView } = await import("./card-status");
const { parseCardStatus } = await import("./use-card-status");

type Action = NonNullable<SeoCardStatus["action"]>;

function status(overrides: Partial<Action> = {}): SeoCardStatus {
  return {
    piece: { status: "scheduled", label: "On calendar for Fri 9 Oct", at: null },
    action: {
      id: "a1",
      kind: "TITLE_META",
      status: "APPLIED",
      statusLabel: "Checking your site",
      headline: null,
      detail: null,
      ask: null,
      evaluateAfter: null,
      can: { confirmLive: false, checkNow: false, undo: false },
      ...overrides,
    },
    suggestion: null,
    removed: false,
  };
}

const MODES = { modes: true, timezone: "Europe/Istanbul" };

describe("cardStatusView", () => {
  it("nothing loaded yet: no view", () => {
    expect(cardStatusView(null, MODES)).toBeNull();
  });

  it("shows the piece line and the action's status label", () => {
    const view = cardStatusView(status(), MODES);
    expect(view?.piece).toEqual({ label: "On calendar for Fri 9 Oct" });
    expect(view?.action).toMatchObject({
      statusLabel: "Checking your site",
      tone: "waiting",
      headline: null,
      measuringUntil: null,
      buttons: [],
    });
  });

  it.each([
    ["PROPOSED", "neutral"],
    ["ACCEPTED", "neutral"],
    ["APPLIED", "waiting"],
    ["VERIFIED", "waiting"],
    ["EVALUATING", "waiting"],
    ["WORKED", "positive"],
    ["DIDNT", "neutral"],
    ["INCONCLUSIVE", "neutral"],
    ["DISMISSED", "neutral"],
    ["EXPIRED", "neutral"],
  ] as const)("status %s has the %s tone", (value, tone) => {
    expect(
      cardStatusView(status({ status: value }), MODES)?.action?.tone,
    ).toBe(tone);
  });

  it("carries the evaluated headline and detail as the server wrote them", () => {
    const view = cardStatusView(
      status({
        status: "WORKED",
        statusLabel: "Worked",
        headline: "Clicks +18%",
        detail: "Compared with 6 similar pages",
      }),
      MODES,
    );
    expect(view?.action).toMatchObject({
      headline: "Clicks +18%",
      detail: "Compared with 6 similar pages",
    });
  });

  it("measuring: 'Measuring until <day>' from evaluateAfter, only while measuring", () => {
    const measuring = cardStatusView(
      status({
        status: "EVALUATING",
        evaluateAfter: "2026-11-09T09:00:00.000Z",
      }),
      MODES,
    );
    expect(measuring?.action?.measuringUntil).toBe("Measuring until Mon 9 Nov");
    const waiting = cardStatusView(
      status({ status: "APPLIED", evaluateAfter: "2026-11-09T09:00:00.000Z" }),
      MODES,
    );
    expect(waiting?.action?.measuringUntil).toBeNull();
  });

  it("the ask text and the buttons follow what the server allows", () => {
    const asked = cardStatusView(
      status({
        ask: "Is the new title live on your site?",
        can: { confirmLive: true, checkNow: true, undo: true },
      }),
      MODES,
    );
    expect(asked?.action?.ask).toBe("Is the new title live on your site?");
    expect(asked?.action?.buttons.map((button) => button.label)).toEqual([
      "It's live",
      "Check again",
      "Not done yet",
    ]);

    const some = cardStatusView(
      status({ can: { confirmLive: false, checkNow: true, undo: true } }),
      MODES,
    );
    expect(some?.action?.buttons.map((button) => button.id)).toEqual([
      "check",
      "undo",
    ]);
    expect(
      cardStatusView(status(), MODES)?.action?.buttons,
    ).toHaveLength(0);
  });

  it("removed rows say so; there is no action then", () => {
    const view = cardStatusView(
      { piece: null, action: null, suggestion: null, removed: true },
      MODES,
    );
    expect(view).toMatchObject({ removed: true, action: null, piece: null });
  });

  it("the topic suggestion is offered only with features.modes", () => {
    const withSuggestion: SeoCardStatus = {
      piece: null,
      action: null,
      suggestion: { topic: "trail running shoes" },
      removed: false,
    };
    expect(cardStatusView(withSuggestion, MODES)?.suggestion).toBe(
      "trail running shoes",
    );
    expect(
      cardStatusView(withSuggestion, { modes: false })?.suggestion,
    ).toBeNull();
  });
});

describe("parseCardStatus", () => {
  it("reads the status route's JSON", () => {
    expect(
      parseCardStatus({
        piece: { status: "published", label: "Published", at: "2026-10-09" },
        action: {
          id: "a1",
          kind: "NEW_CONTENT",
          status: "EVALUATING",
          statusLabel: "Measuring",
          headline: null,
          detail: null,
          ask: null,
          evaluateAfter: "2026-12-01T00:00:00.000Z",
          can: { confirmLive: false, checkNow: false, undo: false },
        },
        suggestion: { topic: "x" },
        removed: false,
      }),
    ).toMatchObject({
      piece: { label: "Published" },
      action: { kind: "NEW_CONTENT", status: "EVALUATING" },
      suggestion: { topic: "x" },
      removed: false,
    });
  });

  it("drops what it does not know and refuses broken bodies", () => {
    expect(parseCardStatus(null)).toBeNull();
    expect(parseCardStatus([])).toBeNull();
    expect(
      parseCardStatus({
        action: { id: "a1", kind: "NOPE", status: "WORKED", statusLabel: "x" },
        removed: "yes",
      }),
    ).toEqual({ piece: null, action: null, suggestion: null, removed: false });
  });
});
