import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleKey } from "@/lib/modules/catalog";
import { buildWorkHost } from "@/lib/works/host";
import type { WorkView } from "@/lib/works/work";

// ProjectChat with modules on (plan P4; owner's decision of 5 Oct): a new
// chat's suggestions become the module tiles (plus the rows no module covers),
// and a module goes on INSIDE the chat: the Social Media Planner sends its
// first message (or the client's own words) once stored, the flow modules write
// their card, and no panel or Brief ever hangs under the composer. Neighbours
// are stubbed as in project-chat.works.test.ts.

const state = vi.hoisted(() => ({
  runtime: null as unknown,
  setModule: vi.fn(),
  startFlow: vi.fn(),
  refresh: vi.fn(),
  setText: vi.fn(),
  toastError: vi.fn(),
  launcher: null as null | { onChoose: (module: ModuleKey) => void },
}));

// A server render refuses transitions and optimistic updates.
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useTransition: () =>
      [false, (callback: () => unknown) => void callback()] as ReturnType<
        typeof actual.useTransition
      >,
    useOptimistic: <T>(value: T) => [value, vi.fn()] as const,
  };
});
vi.mock("sonner", () => ({
  toast: { error: state.toastError, info: vi.fn(), success: vi.fn() },
}));
vi.mock("@/server/actions/work-approve-actions", () => ({
  approvePlansAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: state.refresh,
    push: vi.fn(),
    replace: vi.fn(),
  }),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: ReactNode }) => children,
  useExternalStoreRuntime: (options: unknown) => {
    state.runtime = options;
    return {};
  },
  useAuiState: () => 0,
  useAui: () => ({ composer: { setText: state.setText } }),
}));
vi.mock("@/server/actions/module-flow-actions", () => ({
  startModuleFlowAction: state.startFlow,
}));
vi.mock("@/server/actions/work-actions", () => ({
  setWorkChannelsAction: vi.fn(),
  setWorkModuleAction: state.setModule,
}));
vi.mock("@/server/actions/command-actions", () => ({
  submitChatMessageAction: vi.fn(),
}));
vi.mock("@/server/actions/post-result-actions", () => ({
  recordPostVerdictAction: vi.fn(),
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
vi.mock("@/lib/works/work-activity", () => ({
  announceWorkActivity: vi.fn(),
  announceWorkSettled: vi.fn(),
}));
vi.mock("@/components/commands/composer-plus-menu", () => ({
  ComposerPlusMenu: () => null,
}));
vi.mock("@/components/workspace/workspace-panel-toggle", () => ({
  useWorkspacePanelToggle: () => ({ openTab: vi.fn() }),
  useWorkspaceDetail: () => null,
}));
vi.mock("@/components/guide/guided-setup-entry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/guide/guided-setup-entry")
  >()),
  ConnectedGuidedSetupChip: () => null,
}));
vi.mock("@/components/assistant-ui/thread", () => ({
  // Only the slot under the composer matters here.
  Thread: (props: { components: { StartSuggestions?: ComponentType } }) =>
    props.components.StartSuggestions
      ? createElement(props.components.StartSuggestions)
      : null,
}));
// The real tiles, with their tap kept for the test to press.
vi.mock("@/components/modules/module-launcher", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/components/modules/module-launcher")
    >();
  return {
    ...actual,
    ModuleLauncher: (props: Parameters<typeof actual.ModuleLauncher>[0]) => {
      state.launcher = props;
      return actual.ModuleLauncher(props);
    },
  };
});

const { ProjectChat } = await import("@/components/commands/project-chat");
const { SOCIAL_START_MESSAGE } =
  await import("@/components/modules/use-module-choice");
const { announceWorkActivity } = await import("@/lib/works/work-activity");

type RuntimeOptions = {
  onNew: (message: {
    content: { type: "text"; text: string }[];
  }) => Promise<void>;
};

const work = (module: ModuleKey | null): WorkView => ({
  id: "w1",
  title: "New Chat",
  summary: null,
  status: "ACTIVE",
  channels: [],
  acknowledgedUnconnected: [],
  module,
  lastActivityAt: "2026-10-05T10:00:00.000Z",
});

const render = (
  options: {
    module?: ModuleKey | null;
    modulesUi?: boolean;
    connected?: boolean;
    pendingApprovals?: number;
  } = {},
) =>
  renderToStaticMarkup(
    createElement(ProjectChat, {
      projectId: "p1",
      projectName: "Acme",
      turns: [],
      publishTargets: [],
      userFirstName: "Emre",
      chatEngine: "agent",
      workHost: buildWorkHost({
        projectId: "p1",
        work: work(options.module ?? null),
        connections: { instagram: { connected: options.connected ?? true } },
        pendingApprovals: options.pendingApprovals ?? 0,
        hasAnalytics: true,
        timezone: "Europe/Skopje",
        modulesUi: options.modulesUi ?? true,
      }),
    }),
  );

describe("ProjectChat new chat with modules on", () => {
  it("shows the module tiles and only the rows no module covers", () => {
    const html = render({ connected: false });
    expect(html).toContain('aria-label="Start with a module"');
    for (const label of [
      "Social Media Planner",
      "Ads Manager",
      "Analytics",
      "SEO Manager",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Connect Instagram to publish");
    expect(html).not.toContain("Plan the week for Instagram");
    expect(html).not.toContain("Find content ideas");
    expect(html).not.toContain("Make one post");
    expect(html).not.toContain("Check how your content is performing");
  });

  it("a decision waiting stays a row under the tiles", () => {
    const html = render({ pendingApprovals: 2 });
    expect(html).toContain("2 decisions waiting for you");
  });

  it("a Social Media Planner chat with nothing sent offers its first message as one row: no Brief, no panel", () => {
    const html = render({ module: "social" });
    expect(html).toContain("Plan next week&#x27;s posts from my idea pool.");
    expect(html).toContain('aria-label="Suggestions for this chat"');
    expect(html).not.toContain("What is this plan for?");
    expect(html).not.toContain("Social Media Planner steps");
    expect(html).not.toContain("Back to the modules");
    expect(html).not.toContain('aria-label="Start with a module"');
  });

  it("a flow module whose card is not in the chat shows the tiles again (a tap retries), never a panel", () => {
    for (const key of ["ads", "analytics", "seo"] as const) {
      const html = render({ module: key });
      expect(html).toContain('aria-label="Start with a module"');
      expect(html).not.toContain(" steps");
      expect(html).not.toContain("coming soon");
      expect(html).not.toContain("What is this plan for?");
    }
  });

  it("modules off: exactly today's rows, no tiles, whatever the Work says", () => {
    const html = render({ modulesUi: false, module: "social" });
    expect(html).toContain("Plan the week for Instagram");
    expect(html).toContain("Suggestions for this chat");
    expect(html).not.toContain("Start with a module");
    expect(html).not.toContain("Plan next week&#x27;s posts");
  });
});

describe("ProjectChat modules go on inside the chat", () => {
  const sse = `event: x\ndata: ${JSON.stringify({
    type: "done",
    commandId: "c",
    status: "ANSWERED",
    reply: "ok",
  })}\n\n`;
  let fetchMock: ReturnType<typeof vi.fn>;
  const send = (text: string) =>
    (state.runtime as RuntimeOptions).onNew({
      content: [{ type: "text", text }],
    });
  // The text of the n-th chat request.
  const sentText = (call = 0) =>
    (
      (fetchMock.mock.calls[call]?.[1] as RequestInit | undefined)
        ?.body as FormData
    ).get("text");
  const tap = (module: ModuleKey) => {
    if (!state.launcher) throw new Error("no tiles on screen");
    state.launcher.onChoose(module);
  };

  beforeEach(() => {
    state.launcher = null;
    state.setModule
      .mockReset()
      .mockImplementation(
        async (_p: string, _w: string, module: ModuleKey) => ({
          ok: true,
          module,
        }),
      );
    state.startFlow
      .mockReset()
      .mockResolvedValue({ ok: true, commandId: "cmd-flow" });
    state.refresh.mockReset();
    state.setText.mockReset();
    state.toastError.mockReset();
    vi.mocked(announceWorkActivity).mockReset();
    fetchMock = vi.fn(
      async () =>
        new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tapping the Social Media Planner stores it, then sends its first message as a chat message", async () => {
    render();
    tap("social");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(state.setModule).toHaveBeenCalledWith("p1", "w1", "social");
    // Stored first: the turn runs as the module's chat.
    expect(state.setModule.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(sentText()).toBe(SOCIAL_START_MESSAGE);
    expect(SOCIAL_START_MESSAGE).toBe(
      "Plan next week's posts from my idea pool.",
    );
    // The Recents row shows the module's icon at once.
    expect(announceWorkActivity).toHaveBeenCalledWith(
      expect.objectContaining({ module: "social" }),
    );
    expect(state.startFlow).not.toHaveBeenCalled();
    expect(state.setText).not.toHaveBeenCalled();
  });

  it("a refused Social tap sends nothing and leaves the message in the composer", async () => {
    state.setModule.mockResolvedValue({
      ok: false,
      message: "This chat has already started.",
    });
    render();
    tap("social");
    await vi.waitFor(() =>
      expect(state.setText).toHaveBeenCalledWith(SOCIAL_START_MESSAGE),
    );
    expect(state.toastError).toHaveBeenCalledWith(
      "This chat has already started.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["ads", "analytics", "seo"] as const)(
    "tapping %s stores it and writes its flow card: nothing is sent, the page refreshes",
    async (module) => {
      render();
      tap(module);
      await vi.waitFor(() => expect(state.refresh).toHaveBeenCalled());
      expect(state.setModule).toHaveBeenCalledWith("p1", "w1", module);
      expect(state.startFlow).toHaveBeenCalledWith("p1", "w1", module);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(state.setText).not.toHaveBeenCalled();
    },
  );

  it("a flow card that cannot be written says why", async () => {
    state.startFlow.mockResolvedValue({ ok: false, message: "No access." });
    render();
    tap("ads");
    await vi.waitFor(() =>
      expect(state.toastError).toHaveBeenCalledWith("No access."),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("words for the Social Media Planner store it, then are sent as they are", async () => {
    render();
    await send("3 instagram posts for next week");
    expect(state.setModule).toHaveBeenCalledWith("p1", "w1", "social");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentText()).toBe("3 instagram posts for next week");
    expect(state.setModule.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("words that cannot be stored as the module's chat are still sent", async () => {
    state.setModule.mockResolvedValue({ ok: false, message: "Slow down." });
    render();
    await send("Plan 3 Instagram posts a week for Black Friday");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentText()).toBe("Plan 3 Instagram posts a week for Black Friday");
    expect(state.toastError).not.toHaveBeenCalled();
  });

  it("a question is sent as a chat message, as before", async () => {
    render();
    await send("What should I post this week?");
    expect(state.setModule).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("words for Ads, Analytics or SEO are sent (the agent answers; their card opens from a tile)", async () => {
    render();
    await send("Launch a Meta ads campaign with a 500 budget");
    expect(state.setModule).not.toHaveBeenCalled();
    expect(state.startFlow).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a chat that already has its module, or modules off, sends the words", async () => {
    render({ module: "social" });
    await send("Plan 3 Instagram posts a week");
    render({ modulesUi: false });
    await send("Plan 3 Instagram posts a week");
    expect(state.setModule).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
