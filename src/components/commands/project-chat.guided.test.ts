import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GuidedSetupHost } from "@/lib/guided-setup/contract";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// ProjectChat host wiring for the guided setup sheet (spec 4, 6.4, 10.3). The
// heavy neighbours are stubbed: Thread becomes a probe that prints what the
// host handed it, next/dynamic becomes a stub that prints the sheet's props.

type RuntimeOptions = {
  messages: unknown[];
  convertMessage: (message: unknown) => { content: unknown };
  onNew: (message: {
    content: { type: "text"; text: string }[];
  }) => Promise<void>;
};
type ThreadProps = {
  autoFocusComposer?: boolean;
  components: {
    Welcome: ComponentType;
    QuickActions: ComponentType;
  };
};

const state = vi.hoisted(() => ({
  runtime: null as unknown,
  messageCount: 0,
}));

vi.mock("@/server/actions/work-approve-actions", () => ({
  approvePlansAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("next/dynamic", () => ({
  default: () =>
    function SheetStub(props: Record<string, unknown>) {
      const pick = {
        projectId: props.projectId,
        brandName: props.brandName,
        languageCode: props.languageCode,
        chatEngine: props.chatEngine,
        seedCommandId: props.seedCommandId,
      };
      return createElement("div", {
        "data-sheet": JSON.stringify(pick),
      });
    },
}));
vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: ReactNode }) => children,
  useExternalStoreRuntime: (options: unknown) => {
    state.runtime = options;
    return {};
  },
  useAuiState: (select: (s: unknown) => unknown) =>
    select({ thread: { messages: { length: state.messageCount } } }),
}));
vi.mock("@/server/actions/work-actions", () => ({
  setWorkChannelsAction: vi.fn(),
}));
vi.mock("@/server/actions/command-actions", () => ({
  submitChatMessageAction: vi.fn(),
}));
vi.mock("@/server/actions/plan-progress-actions", () => ({
  approvePlanItemsAction: vi.fn(),
  enablePlanPublishingAction: vi.fn(),
  getManualPublishItemsAction: vi.fn(),
  getPlanResultsAction: vi.fn(),
  markCreativePublishedAction: vi.fn(),
}));
vi.mock("@/server/actions/composer-shortcut-actions", () => ({
  submitComposerShortcutAction: vi.fn(),
}));
vi.mock("@/components/commands/composer-plus-menu", () => ({
  ComposerPlusMenu: () => null,
}));
vi.mock("@/components/workspace/workspace-panel-toggle", () => ({
  useWorkspacePanelToggle: () => ({ openTab: vi.fn() }),
}));
vi.mock("@/components/guide/guided-setup-entry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/guide/guided-setup-entry")
  >()),
  // The real chip hides itself on the server (localStorage snapshot).
  ConnectedGuidedSetupChip: ({ projectId }: { projectId: string }) =>
    createElement("i", null, `chip-stub:${projectId}`),
}));
vi.mock("@/components/assistant-ui/thread", async () => {
  const { useGuidedSetup } =
    await import("@/components/guide/guided-setup-context");
  return {
    Thread: (props: ThreadProps) => {
      const guided = useGuidedSetup();
      return createElement(
        "div",
        {
          "data-autofocus": String(props.autoFocusComposer),
          "data-guided": guided
            ? JSON.stringify({
                isOpen: guided.isOpen,
                label: guided.entry.label,
              })
            : "null",
        },
        createElement(props.components.Welcome),
        createElement(props.components.QuickActions),
      );
    },
  };
});

const { ProjectChat } = await import("./project-chat");

const host = (over: Partial<GuidedSetupHost> = {}): GuidedSetupHost => ({
  summary: {
    status: "NONE",
    answered: 0,
    total: 5,
    position: 1,
    started: false,
    hasProfile: false,
  },
  seedFirst: false,
  languageCode: "en",
  requested: false,
  ...over,
});

const render = (props: {
  guidedSetup?: GuidedSetupHost;
  ideaId?: string;
  turns?: Parameters<typeof ProjectChat>[0]["turns"];
  chatEngine?: "agent" | "legacy";
  nextSteps?: Parameters<typeof ProjectChat>[0]["nextSteps"];
}) =>
  renderToStaticMarkup(
    createElement(ProjectChat, {
      projectId: "p1",
      projectName: "Acme",
      turns: [],
      publishTargets: [],
      ...props,
    }),
  );

const attr = (html: string, name: string) =>
  new RegExp(`${name}="([^"]*)"`).exec(html)?.[1]?.replaceAll("&quot;", '"');

beforeEach(() => {
  state.runtime = null;
  state.messageCount = 0;
});

describe("ProjectChat guided setup host", () => {
  it("flag off: no provider value, no sheet, composer autofocus as today", () => {
    const html = render({});
    expect(attr(html, "data-guided")).toBe("null");
    expect(html).not.toContain("data-sheet");
    expect(attr(html, "data-autofocus")).toBe("true");
    expect(html).not.toContain("Start setup");
    // No leftover wrapper from the Welcome card slot.
    expect(html).not.toContain("empty:hidden");
  });

  it("with a host: context is live, the sheet gets its props, Welcome card shows", () => {
    const html = render({ guidedSetup: host({ languageCode: "tr" }) });
    expect(JSON.parse(attr(html, "data-guided") ?? "null")).toEqual({
      isOpen: false,
      label: "Set up your brand",
    });
    expect(JSON.parse(attr(html, "data-sheet") ?? "null")).toEqual({
      projectId: "p1",
      brandName: "Acme",
      languageCode: "tr",
      chatEngine: "legacy",
    });
    expect(html).toContain("Set up Acme");
    expect(attr(html, "data-autofocus")).toBe("true");
  });

  it("an idea thread never mounts the sheet nor gives a context", () => {
    const html = render({
      guidedSetup: host({ requested: true }),
      ideaId: "i1",
    });
    expect(attr(html, "data-guided")).toBe("null");
    expect(html).not.toContain("data-sheet");
    expect(html).not.toContain("Start setup");
    expect(html).not.toContain("chip-stub");
  });

  it("?guide=setup opens the sheet at first render and keeps the composer quiet", () => {
    const html = render({ guidedSetup: host({ requested: true }) });
    expect(JSON.parse(attr(html, "data-guided") ?? "null").isOpen).toBe(true);
    expect(attr(html, "data-autofocus")).toBe("false");
  });

  it("the chip sits first in the quick actions row, for the root chat only", () => {
    const html = render({ guidedSetup: host() });
    const chip = html.indexOf("chip-stub:p1");
    expect(chip).toBeGreaterThan(-1);
    expect(chip).toBeLessThan(html.indexOf("Create a post"));
  });
});

describe("ProjectChat next-step bar", () => {
  const produce = {
    key: "produce",
    tone: "next" as const,
    label: "Produce 7",
    title: "7 planned pieces have no content yet.",
    action: { kind: "produce_plan" as const, planId: "plan-1", count: 7 },
  };
  const connect = {
    key: "connect-instagram",
    tone: "next" as const,
    label: "Connect Instagram",
    title: "Instagram is not connected.",
    quiet: true,
    action: { kind: "connect_channel" as const, channel: "instagram" as const },
  };

  it("the shortcuts stay next to the bar: something waiting never takes them away", () => {
    const html = render({ nextSteps: [produce] });
    expect(html).toContain('aria-label="Next steps"');
    expect(html).toContain("Produce 7");
    for (const label of ["Create a post", "Find a Reel idea", "Plan the week"]) {
      expect(html).toContain(label);
    }
  });

  it("only a quiet step leaves no bar, and the shortcuts are there as ever", () => {
    const html = render({ nextSteps: [connect] });
    expect(html).not.toContain('aria-label="Next steps"');
    expect(html).not.toContain("Connect Instagram");
    expect(html).toContain("Create a post");
  });

  it("an idea thread has neither", () => {
    const html = render({ nextSteps: [produce], ideaId: "i1" });
    expect(html).not.toContain('aria-label="Next steps"');
    expect(html).not.toContain("Create a post");
  });
});

describe("ProjectChat lead-in whitelist", () => {
  const cardTurn = (card: IdeaEventCardData) => ({
    commandId: "c1",
    source: "SYSTEM" as const,
    text: "",
    reply: "Let us set things up.",
    replyStatus: null,
    attachments: [],
    card,
    createdAt: "2026-09-30T10:00:00.000Z",
  });
  const contentOf = (card: IdeaEventCardData) => {
    render({ turns: [cardTurn(card)] });
    const options = state.runtime as RuntimeOptions;
    const assistant = options.messages.find(
      (m) =>
        (m as { role: string }).role === "assistant" && "card" in (m as object),
    );
    return options.convertMessage(assistant).content;
  };

  it("keeps the model's words above a guided-setup card", () => {
    expect(
      contentOf({ kind: "guided-setup", projectId: "p1", state: "open" }),
    ).toBe("Let us set things up.");
  });

  it("still keeps them for an older companion card, and drops them for others", () => {
    const loose = (kind: string) => ({ kind }) as unknown as IdeaEventCardData;
    expect(contentOf(loose("plan-brief"))).toBe("Let us set things up.");
    expect(contentOf(loose("creative-ready"))).toEqual([]);
  });
});

describe("ProjectChat live guided-setup card", () => {
  let activeElementReads = 0;

  beforeEach(() => {
    activeElementReads = 0;
    vi.stubGlobal("HTMLElement", class {});
    vi.stubGlobal("document", {
      get activeElement() {
        activeElementReads += 1;
        return null;
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const sse = (events: object[]) =>
    events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const streamOf = async (
    events: object[],
    props: { ideaId?: string; guidedSetup?: GuidedSetupHost },
  ) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(sse(events), {
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );
    render({ chatEngine: "agent", ...props });
    const options = state.runtime as RuntimeOptions;
    await options.onNew({ content: [{ type: "text", text: "set up" }] });
  };
  const open = (): IdeaEventCardData => ({
    kind: "guided-setup",
    projectId: "p1",
    state: "open",
    sourceCommandId: "cmd1",
  });
  const done: IdeaEventCardData = {
    kind: "guided-setup",
    projectId: "p1",
    state: "done",
  };

  it("an open card opens the sheet (once, even though done repeats it)", async () => {
    await streamOf(
      [
        { type: "card", card: open() },
        {
          type: "done",
          commandId: "c",
          status: "ANSWERED",
          reply: "ok",
          card: open(),
        },
      ],
      { guidedSetup: host() },
    );
    expect(activeElementReads).toBe(1);
  });

  it("a done card (the receipt) never opens the sheet", async () => {
    await streamOf([{ type: "card", card: done }], { guidedSetup: host() });
    expect(activeElementReads).toBe(0);
  });

  it("another card kind with state open never opens it", async () => {
    await streamOf(
      [
        {
          type: "card",
          card: { kind: "plan-brief", state: "open" },
        },
      ],
      { guidedSetup: host() },
    );
    expect(activeElementReads).toBe(0);
  });

  it("without a host, or in an idea thread, nothing opens", async () => {
    await streamOf([{ type: "card", card: open() }], {});
    await streamOf([{ type: "card", card: open() }], {
      guidedSetup: host(),
      ideaId: "i1",
    });
    expect(activeElementReads).toBe(0);
  });
});
