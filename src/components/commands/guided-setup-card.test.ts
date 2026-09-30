import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Static markup cannot click: the mocked Button records its handler so the
// tests can press it.
const pressed = vi.hoisted(() => ({
  handlers: new Map<string, () => void>(),
}));
vi.mock("@/components/ui/button", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui/button")>(
    "@/components/ui/button",
  );
  return {
    ...actual,
    Button: (props: {
      children?: ReactNode;
      onClick?: () => void;
      disabled?: boolean;
      className?: string;
    }) => {
      if (props.onClick) pressed.handlers.set(String(props.children), props.onClick);
      return createElement(
        "button",
        { disabled: props.disabled, className: props.className },
        props.children,
      );
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useParams: () => ({ projectId: "p1" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/guide/guided-setup-client", () => ({
  api: () => ({ draftPlan: vi.fn() }),
}));
vi.mock("@/server/actions/command-actions", () => ({
  submitChatMessageAction: vi.fn(),
}));

const { GuidedSetupCard, requestFirstPlan } = await import(
  "./guided-setup-card"
);
const { GuidedSetupProvider } = await import(
  "@/components/guide/guided-setup-context"
);
const { ChatSendProvider } = await import("./chat-send-context");

import type { GuidedSetupApi } from "@/components/guide/guided-setup-context";
import {
  entryOf,
  type GuidedSetupCardData,
  type GuidedSetupSummary,
} from "@/lib/guided-setup/contract";
import {
  CARDS_THAT_KEEP_TEXT,
  isIdeaEventCardData,
} from "@/types/idea-event-card";

const summaryOf = (over: Partial<GuidedSetupSummary> = {}): GuidedSetupSummary => ({
  status: "NONE",
  answered: 0,
  total: 5,
  position: 1,
  started: false,
  hasProfile: false,
  ...over,
});

const apiOf = (
  over: Partial<GuidedSetupApi> = {},
  summary: GuidedSetupSummary = summaryOf(),
): GuidedSetupApi => ({
  isOpen: false,
  open: vi.fn(),
  close: vi.fn(),
  summary,
  entry: entryOf(summary),
  canDraftPlan: true,
  ...over,
});

const openCard: GuidedSetupCardData = {
  kind: "guided-setup",
  projectId: "p1",
  state: "open",
  sourceCommandId: "c1",
};

const doneCard = (
  summary: Partial<NonNullable<GuidedSetupCardData["summary"]>> = {},
): GuidedSetupCardData => ({
  kind: "guided-setup",
  projectId: "p1",
  state: "done",
  summary: {
    goal: "Sales",
    goalProposed: false,
    channels: ["Instagram", "LinkedIn"],
    unconnected: ["linkedin"],
    saved: ["Brand profile", "Goal", "Channel focus"],
    canDraftPlan: true,
    ...summary,
  },
});

// send defaults to a function: the plan button needs the chat's send path.
function render(
  card: GuidedSetupCardData,
  api: GuidedSetupApi | null,
  send: ((text: string) => Promise<void>) | null = async () => {},
): string {
  const tree: ReactNode = createElement(
    ChatSendProvider,
    { value: send },
    createElement(GuidedSetupCard, { card }),
  );
  return renderToStaticMarkup(
    createElement(GuidedSetupProvider, { value: api }, tree),
  );
}

describe("guided-setup card kind (G41)", () => {
  it("is a known kind and keeps the model's lead-in text", () => {
    expect(isIdeaEventCardData({ kind: "guided-setup" })).toBe(true);
    expect(CARDS_THAT_KEEP_TEXT.has("guided-setup")).toBe(true);
    for (const kind of ["content-plan-draft", "plan-brief", "content-package"]) {
      expect(CARDS_THAT_KEEP_TEXT.has(kind)).toBe(true);
    }
    expect(CARDS_THAT_KEEP_TEXT.has("question")).toBe(false);
  });

  it("renders the launcher for state open, labelled from live context", () => {
    const start = render(openCard, apiOf());
    expect(start).toContain("Guided setup");
    expect(start).toContain("<button");
    expect(start).toContain("Set up your brand");

    const cont = render(
      openCard,
      apiOf({}, summaryOf({ status: "OPEN", answered: 2, position: 3 })),
    );
    expect(cont).toContain("Continue setup · question 3 of 5");

    const update = render(
      openCard,
      apiOf({}, summaryOf({ status: "DONE", hasProfile: true })),
    );
    expect(update).toContain("Update your setup");
  });

  it("opens the sheet from the launcher with the asking message as seed", () => {
    pressed.handlers.clear();
    const api = apiOf();
    render(openCard, api);
    pressed.handlers.get("Set up your brand")?.();
    expect(api.open).toHaveBeenCalledTimes(1);
    expect(api.open).toHaveBeenCalledWith("card", { seedCommandId: "c1" });
  });

  it("opens the sheet from the receipt's Edit setup", () => {
    pressed.handlers.clear();
    const api = apiOf();
    render(doneCard(), api);
    pressed.handlers.get("Edit setup")?.();
    expect(api.open).toHaveBeenCalledTimes(1);
  });

  it("renders the receipt for state done with every button", () => {
    const html = render(doneCard(), apiOf());
    expect(html).toContain("Setup saved");
    expect(html).toContain("Goal: Sales");
    expect(html).not.toContain("waiting for your approval");
    expect(html).toContain("Channels: Instagram, LinkedIn");
    expect(html).toContain("Saved: Brand profile, Goal, Channel focus");
    expect(html).toContain("Draft my first plan");
    expect(html).toContain("You review the plan before anything is saved.");
    expect(html).toContain('href="/projects/p1/integrations"');
    expect(html).toContain("Connect accounts");
    expect(html).toContain("Edit setup");
  });

  it("every card button and link is finger-sized on touch devices", () => {
    for (const html of [render(openCard, apiOf()), render(doneCard(), apiOf())]) {
      const tags = html.match(/<(?:button|a)\b[^>]*>/g) ?? [];
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(tag).toContain("any-pointer-coarse:min-h-11");
      }
    }
  });

  it("has no Connect button when nothing is unconnected", () => {
    for (const unconnected of [[], undefined]) {
      const html = render(doneCard({ unconnected }), apiOf());
      expect(html).not.toContain("Connect accounts");
      expect(html).not.toContain("/integrations");
      expect(html).toContain("Edit setup");
    }
  });

  it("says when the goal waits for approval in Strategy", () => {
    const html = render(doneCard({ goalProposed: true }), apiOf());
    expect(html).toContain("Goal: Sales (waiting for your approval in Strategy)");
  });

  it("hides the plan button unless both the card and the context allow it", () => {
    expect(render(doneCard({ canDraftPlan: false }), apiOf())).not.toContain(
      "Draft my first plan",
    );
    expect(render(doneCard({ canDraftPlan: undefined }), apiOf())).not.toContain(
      "Draft my first plan",
    );
    expect(
      render(doneCard(), apiOf({ canDraftPlan: false })),
    ).not.toContain("Draft my first plan");
    // Outside the chat there is no send path: the button could not work.
    expect(render(doneCard(), apiOf(), null)).not.toContain(
      "Draft my first plan",
    );
    expect(render(doneCard(), apiOf())).toContain("Draft my first plan");
  });

  it("renders one inert static line, no button and no link, with a null context", () => {
    const open = render(openCard, null);
    expect(open).toContain("Guided setup isn&#x27;t available here.");
    expect(open).not.toContain("<button");
    expect(open).not.toContain("<a ");
    expect(open).not.toContain("Set up your brand");

    const done = render(doneCard(), null);
    expect(done).toContain("Setup saved");
    expect(done).not.toContain("<button");
    expect(done).not.toContain("<a ");
    expect(done).not.toContain("Draft my first plan");
  });

  it("tolerates a card with missing or malformed optional fields", () => {
    const bare = { kind: "guided-setup", projectId: "p1", state: "done" };
    expect(() =>
      render(bare as GuidedSetupCardData, apiOf()),
    ).not.toThrow();
    const wrong = {
      ...bare,
      summary: { goal: 7, channels: "x", saved: null, unconnected: {} },
    };
    const html = render(wrong as unknown as GuidedSetupCardData, apiOf());
    expect(html).toContain("Setup saved");
    expect(html).not.toContain("Goal:");
    expect(html).not.toContain("Draft my first plan");
    expect(html).toContain("Edit setup");
  });
});

describe("draft my first plan request", () => {
  const brief = "Plan my content. Goal: Sales.\n[Plan brief] goal=sales";

  it("sends the server's message to the chat exactly once", async () => {
    const send = vi.fn(async () => {});
    const draft = vi.fn(async () => ({
      ok: true as const,
      data: { ok: true as const, message: brief },
    }));
    expect(await requestFirstPlan(draft, send)).toBeNull();
    expect(draft).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(brief);
  });

  it("shows the server's sentence and sends nothing when the draft is refused", async () => {
    const send = vi.fn(async () => {});
    const refused = await requestFirstPlan(
      async () => ({
        ok: true,
        data: {
          ok: false,
          code: "LEGACY_ENGINE",
          message: "Plans are drafted by the agent chat.",
        },
      }),
      send,
    );
    expect(refused).toBe("Plans are drafted by the agent chat.");
    expect(send).not.toHaveBeenCalled();
  });

  it("turns a failed request or a failed send into inline text, never a throw", async () => {
    const send = vi.fn(async () => {});
    const network = await requestFirstPlan(
      async () => ({ ok: false, kind: "NETWORK" }),
      send,
    );
    expect(network).toBe("Couldn't draft the plan. Try again.");
    expect(send).not.toHaveBeenCalled();

    const sendFails = await requestFirstPlan(
      async () => ({ ok: true, data: { ok: true, message: brief } }),
      async () => {
        throw new Error("boom");
      },
    );
    expect(sendFails).toBe("Couldn't draft the plan. Try again.");
  });
});
