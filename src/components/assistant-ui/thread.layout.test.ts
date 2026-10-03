import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The first screen of a chat (docs/works.md): what the Thread shows where, in a
// new chat, while someone types, and once the conversation has begun. The
// assistant-ui runtime is replaced by a state the test sets and primitives that
// only render what they are given; the Thread itself is the real one.

type AuiState = {
  thread: {
    messages: unknown[];
    isLoading: boolean;
    isRunning: boolean;
    capabilities: { dictation: boolean };
  };
  threads: { isLoading: boolean };
  composer: { isEmpty: boolean; dictation: unknown };
};

const aui = vi.hoisted(() => ({
  state: null as unknown as AuiState,
  viewports: [] as Record<string, unknown>[],
}));

vi.mock("next/navigation", () => ({ useParams: () => ({}) }));
vi.mock("@/components/assistant-ui/follow-up-suggestions", () => ({
  ThreadFollowupSuggestions: () => null,
}));
vi.mock("@/components/assistant-ui/attachment", () => ({
  ComposerAddAttachment: () => null,
  ComposerAttachments: () => null,
  UserMessageAttachments: () => null,
}));
vi.mock("@/components/assistant-ui/image-generation-preview", () => ({
  ImageGenerationPreview: () => null,
}));
vi.mock("@/components/assistant-ui/markdown-text", () => ({
  MarkdownText: () => null,
}));
vi.mock("@/components/commands/idea-event-card", () => ({
  IdeaEventCard: () => null,
}));
vi.mock("@/components/assistant-ui/tool-fallback", () => ({
  ToolFallback: () => null,
}));
vi.mock("@/components/assistant-ui/tooltip-icon-button", () => ({
  TooltipIconButton: () => null,
}));
vi.mock("@assistant-ui/react", async () => {
  const { createElement: h } = await import("react");
  type Props = { children?: ReactNode } & Record<string, unknown>;
  // A primitive renders what it is given (a function child is a render prop
  // for the runtime to call: nothing here).
  const pass = ({ children }: Props) =>
    typeof children === "function" ? null : (children ?? null);
  const family = (own: Record<string, unknown> = {}) =>
    new Proxy(own, { get: (target, key: string) => target[key] ?? pass });
  return {
    AuiIf: ({
      condition,
      children,
    }: {
      condition: (state: AuiState) => boolean;
      children?: ReactNode;
    }) => (condition(aui.state) ? children : null),
    useAuiState: (selector: (state: AuiState) => unknown) =>
      selector(aui.state),
    groupPartByType: () => [],
    ThreadPrimitive: family({
      Viewport: (props: Props) => {
        aui.viewports.push(props);
        return h("div", { "data-viewport": "" }, props.children);
      },
      // Keeps its classes: the docked layout is a footer that sticks.
      ViewportFooter: (props: Props) =>
        h("footer", { className: props.className as string }, props.children),
      Messages: () => null,
      ScrollToBottom: () => null,
      Suggestions: () => null,
    }),
    ComposerPrimitive: family({
      Input: () => h("textarea"),
      Dictate: () => null,
      StopDictation: () => null,
    }),
    ActionBarPrimitive: family(),
    ActionBarMorePrimitive: family(),
    BranchPickerPrimitive: family(),
    ErrorPrimitive: family(),
    MessagePrimitive: family(),
    SuggestionPrimitive: family(),
  };
});

const { Thread } = await import("./thread");

const base = (): AuiState => ({
  thread: {
    messages: [],
    isLoading: false,
    isRunning: false,
    capabilities: { dictation: false },
  },
  threads: { isLoading: false },
  composer: { isEmpty: true, dictation: null },
});

function slot(name: string) {
  function Slot() {
    return createElement("i", { "data-slot-of": name });
  }
  return Slot;
}
const SLOTS = {
  Welcome: slot("welcome"),
  QuickActions: slot("quick"),
  ComposerPlusMenu: slot("plus"),
  StartSuggestions: slot("rows"),
};

const render = (components: Record<string, unknown> = SLOTS) =>
  renderToStaticMarkup(createElement(Thread, { components }));

beforeEach(() => {
  aui.state = base();
  aui.viewports = [];
});

describe("Thread: a new chat", () => {
  it("shows the suggestion rows under the composer (no channel chip: a chat is free)", () => {
    const html = render();
    expect(html).toContain('data-slot-of="rows"');
    expect(html.indexOf('data-slot-of="plus"')).toBeLessThan(
      html.indexOf('data-slot-of="rows"'),
    );
    expect(html).not.toContain('data-slot-of="channels"');
  });

  it("hangs the rows from a zero-height anchor, so they never count in the height of the centred block", () => {
    const html = render();
    expect(html).toMatch(
      /<div class="relative h-0"><div class="absolute inset-x-0 top-0"><i data-slot-of="rows"><\/i><\/div><\/div>/,
    );
  });

  it("while something is typed the rows are gone and the anchor (the layout) stays", () => {
    aui.state.composer.isEmpty = false;
    const html = render();
    expect(html).not.toContain('data-slot-of="rows"');
    expect(html).toContain(
      '<div class="relative h-0"><div class="absolute inset-x-0 top-0"></div></div>',
    );
  });

  it("the composer's action row lets its left side shrink and keeps its right side whole (context label and Send)", () => {
    const html = render();
    expect(html).toContain('<div class="flex min-w-0 items-center gap-1.5">');
    expect(html).toContain('<div class="flex shrink-0 items-center gap-1.5">');
    expect(html).toMatch(/aui-composer-action-wrapper relative flex items-center justify-between gap-2/);
  });

  it("is centred and opens at the top (no following the content to the bottom)", () => {
    const html = render();
    expect(html).toContain("justify-center");
    expect(aui.viewports[0]?.autoScroll).toBe(false);
  });

  it("the placeholder thread of startup counts as a new chat; a load after startup does not", () => {
    aui.state.thread.isLoading = true;
    aui.state.threads.isLoading = true;
    expect(render()).toContain('data-slot-of="rows"');
    aui.state.threads.isLoading = false;
    const later = render();
    expect(later).not.toContain('data-slot-of="rows"');
    expect(later).not.toContain('data-slot-of="channels"');
  });

  it("the built-in suggestion strip leaves no empty box (and no gap) behind", () => {
    const html = render();
    expect(html).toMatch(
      /class="aui-thread-welcome-suggestions [^"]*empty:hidden"/,
    );
  });
});

describe("Thread: a chat that has begun", () => {
  beforeEach(() => {
    aui.state.thread.messages = [{ id: "m1" }];
    aui.state.composer.isEmpty = true;
  });

  it("neither the chip nor the rows nor their anchor", () => {
    const html = render();
    expect(html).not.toContain('data-slot-of="channels"');
    expect(html).not.toContain('data-slot-of="rows"');
    expect(html).not.toContain("relative h-0");
    // The rest of the composer is there.
    expect(html).toContain('data-slot-of="plus"');
  });

  it("is docked, not centred, and follows the content as before", () => {
    const html = render();
    expect(html).not.toContain("justify-center");
    expect(html).toContain("sticky bottom-0");
    expect(aui.viewports[0]?.autoScroll).toBeUndefined();
  });
});

describe("Thread without the new-chat slots (Works off)", () => {
  it("renders no chip, no rows and no anchor", () => {
    const html = render({
      Welcome: SLOTS.Welcome,
      QuickActions: SLOTS.QuickActions,
      ComposerPlusMenu: SLOTS.ComposerPlusMenu,
    });
    expect(html).not.toContain('data-slot-of="channels"');
    expect(html).not.toContain('data-slot-of="rows"');
    expect(html).not.toContain("relative h-0");
    expect(html).toContain('data-slot-of="welcome"');
    expect(html).toContain('data-slot-of="quick"');
  });
});
