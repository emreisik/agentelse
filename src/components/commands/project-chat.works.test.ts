import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildWorkHost } from "@/lib/works/host";
import type { IdeaEventCardData } from "@/types/idea-event-card";
import type { WorkView } from "@/lib/works/work";

// ProjectChat in a Work (docs/works.md): the channel chooser comes first, the
// next-step cards after it, the quick-action chips never. Heavy neighbours are
// stubbed the same way as in the guided-setup host test.

type ThreadProps = {
  components: {
    Welcome: ComponentType;
    QuickActions: ComponentType;
    ComposerPlusMenu: ComponentType;
    ContextChip?: ComponentType;
    StartSuggestions?: ComponentType;
  };
};

type PlusProps = {
  works?: boolean;
  onShortcut: (capability: string, request: string) => unknown;
};
type ChatMessage = Record<string, unknown>;
type RuntimeOptions = {
  messages: ChatMessage[];
  convertMessage: (message: ChatMessage) => {
    content: unknown;
    metadata: { custom: Record<string, unknown> };
  };
  onNew: (message: {
    content: { type: "text"; text: string }[];
  }) => Promise<void>;
};

const state = vi.hoisted(() => ({
  runtime: null as unknown,
  plus: null as unknown,
  submitShortcut: vi.fn(),
  announce: vi.fn(),
  settled: vi.fn(),
  setChannels: vi.fn(),
}));

vi.mock("@/server/actions/work-approve-actions", () => ({
  approvePlansAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: ReactNode }) => children,
  useExternalStoreRuntime: (options: unknown) => {
    state.runtime = options;
    return {};
  },
  useAuiState: () => 0,
}));
vi.mock("@/server/actions/work-actions", () => ({
  setWorkChannelsAction: state.setChannels,
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
  submitComposerShortcutAction: state.submitShortcut,
}));
vi.mock("@/lib/works/work-activity", () => ({
  announceWorkActivity: state.announce,
  announceWorkSettled: state.settled,
}));
vi.mock("@/components/commands/composer-plus-menu", () => ({
  ComposerPlusMenu: (props: unknown) => {
    state.plus = props;
    return null;
  },
}));
vi.mock("@/components/workspace/workspace-panel-toggle", () => ({
  useWorkspacePanelToggle: () => ({ openTab: vi.fn() }),
  // No workspace pane around this chat: long cards stay in full.
  useWorkspaceDetail: () => null,
}));
vi.mock("@/components/guide/guided-setup-entry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/guide/guided-setup-entry")
  >()),
  ConnectedGuidedSetupChip: () => null,
}));
vi.mock("@/components/assistant-ui/thread", async () => {
  const { useWorkCardHost } = await import("@/components/works/work-card-host");
  return {
  Thread: (props: ThreadProps) => {
    const host = useWorkCardHost();
    return createElement(
      "div",
      {
        "data-host": host
          ? JSON.stringify({
              projectId: host.projectId,
              workId: host.workId,
              workTitle: host.workTitle,
              active: host.active,
              busy: host.busy,
              producing: [...host.producing],
              timezone: host.timezone,
              channels: host.channels,
              hasRun: typeof host.runNextStep === "function",
              hasOpenTab: typeof host.openTab === "function",
            })
          : "null",
      },
      createElement(props.components.Welcome),
      createElement(props.components.QuickActions),
      createElement(props.components.ComposerPlusMenu),
      props.components.ContextChip
        ? createElement(props.components.ContextChip)
        : null,
      props.components.StartSuggestions
        ? createElement(props.components.StartSuggestions)
        : null,
    );
  },
  };
});

const { ProjectChat, buildWorkHostValue, producingPlanIds } = await import("./project-chat");

const work = (channels: WorkView["channels"]): WorkView => ({
  id: "w1",
  title: "New Work",
  summary: null,
  status: "ACTIVE",
  channels,
  acknowledgedUnconnected: [],
  lastActivityAt: "2026-10-01T10:00:00.000Z",
});

const render = (channels: WorkView["channels"], connected = true) =>
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
        work: work(channels),
        connections: { instagram: { connected } },
        pendingApprovals: 0,
        hasAnalytics: false,
      }),
    }),
  );

// The new chat's first screen, like ChatGPT's: one centered line, the composer,
// the suggestions as one-line rows. A chat is free: no channel chip, no picker.
describe("ProjectChat in a Work: the new chat's first screen", () => {
  it("suggests for the connected channel by default: no chip, no picker card", () => {
    const html = render([], true);
    expect(html).toContain("Plan the week for Instagram");
    expect(html).toContain("Find content ideas for Instagram");
    expect(html).not.toContain("Channels for this chat");
    expect(html).not.toContain("Choose channel");
    expect(html).not.toContain("Which channel is this Work for?");
    expect(html).not.toContain("What do you want to do?");
    expect(html).not.toContain("Find a Reel idea");
    expect(html).not.toContain("Create a campaign");
  });

  it("greets in one centered line: no subtitle, no resume box, no card block", () => {
    const html = render([], true);
    expect(html).toContain("Emre");
    expect(html).toMatch(/<div class="mb-8 px-1 text-center"><h1/);
    expect(html).not.toContain("What should we bring to life for your brand today?");
    expect(html).not.toContain("Where we left off");
  });

  it("the context label shares the composer's row: it is the part that gives way on a phone", () => {
    const html = render([], true);
    expect(html).toMatch(
      /<span class="flex min-w-0 items-center gap-1\.5 text-\[11px\] select-none">/,
    );
    expect(html).toMatch(/<span class="min-w-0 truncate"[^>]*>Acme context on<\/span>/);
    expect(html).toMatch(/<span class="size-1\.5 shrink-0 rounded-full"/);
  });

  it("nothing connected: it still plans for Instagram, and the way to publish is connecting it", () => {
    const html = render([], false);
    expect(html).toContain("Plan the week for Instagram");
    expect(html).toContain("Connect Instagram to publish");
  });

  it("a stored channel is what the suggestions name", () => {
    const html = render(["linkedin"], true);
    expect(html).toContain("Plan the week for LinkedIn");
  });

  it("an unconnected stored channel offers to connect it, as a row", () => {
    const html = render(["instagram"], false);
    expect(html).toContain("Connect Instagram to publish");
  });
});

describe("ProjectChat without a Work (Works off)", () => {
  it("keeps the old greeting and quick-action chips", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectChat, {
        projectId: "p1",
        projectName: "Acme",
        turns: [],
        publishTargets: [],
        userFirstName: "Emre",
      }),
    );
    expect(html).toContain("Find a Reel idea");
    expect(html).not.toContain("What do you want to do?");
  });

  it("keeps the old first screen: the greeting with its subtitle, no channel chip, no suggestion rows", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectChat, {
        projectId: "p1",
        projectName: "Acme",
        turns: [],
        publishTargets: [],
        userFirstName: "Emre",
      }),
    );
    expect(html).toContain("What should we bring to life for your brand today?");
    expect(html).not.toContain("text-center");
    expect(html).not.toContain("Channels for this chat");
    expect(html).not.toContain("Choose channel");
    expect(html).not.toContain("Suggestions for this chat");
  });
});

const optionsOf = () => state.runtime as RuntimeOptions;

const renderWork = (
  over: Partial<Parameters<typeof ProjectChat>[0]> = {},
  channels: WorkView["channels"] = ["instagram"],
  status: WorkView["status"] = "ACTIVE",
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
        work: { ...work(channels), status },
        connections: { instagram: { connected: true } },
        pendingApprovals: 0,
        hasAnalytics: false,
        timezone: "Europe/Skopje",
      }),
      ...over,
    }),
  );

const hostOf = (html: string) => {
  const match = /data-host="([^"]*)"/.exec(html);
  const raw = match?.[1]?.replaceAll("&quot;", '"') ?? "null";
  return raw === "null" ? null : (JSON.parse(raw) as Record<string, unknown>);
};

const loose = (kind: string, extra: object = {}) =>
  ({ kind, ...extra }) as unknown as IdeaEventCardData;

// A persisted assistant message as the messages memo flattens it.
const assistant = (over: ChatMessage = {}): ChatMessage => ({
  id: "m1-a",
  role: "assistant",
  text: "Picked the direction.",
  commandId: "c1",
  createdAt: "2026-10-01T10:00:00.000Z",
  ...over,
});

describe("ProjectChat host provider (W85)", () => {
  it("provides the host in a Work: busy is the stream flag only, producing is empty at rest", () => {
    const host = hostOf(renderWork());
    expect(host).toMatchObject({
      projectId: "p1",
      workId: "w1",
      workTitle: "New Work",
      active: true,
      busy: false,
      producing: [],
      timezone: "Europe/Skopje",
      hasRun: true,
      hasOpenTab: true,
    });
    // Only the Work's own channels, with their live state.
    expect(host?.channels).toEqual([
      { key: "instagram", label: "Instagram", connected: true },
    ]);
  });

  it("a completed Work is inactive", () => {
    expect(hostOf(renderWork({}, ["instagram"], "DONE"))?.active).toBe(
      false,
    );
  });

  it("lists the plans whose package run is running, sorted", () => {
    expect(
      producingPlanIds({
        b: { phase: "running" },
        a: { phase: "running" },
        c: { phase: "started" },
      }),
    ).toEqual(["a", "b"]);
    expect(producingPlanIds({ a: { phase: "started" } })).toEqual([]);
  });

  it("busy is the streaming flag only, whatever is being produced", () => {
    const workHost = buildWorkHost({
      projectId: "p1",
      work: work(["instagram"]),
      connections: { instagram: { connected: true } },
      pendingApprovals: 0,
      hasAnalytics: false,
    });
    const build = (isSending: boolean) =>
      buildWorkHostValue({
        projectId: "p1",
        workHost,
        isSending,
        producing: new Set(["plan1"]),
        openTab: vi.fn(),
        runNextStep: vi.fn(),
      });
    expect(build(false).busy).toBe(false);
    expect(build(true).busy).toBe(true);
    expect([...build(false).producing]).toEqual(["plan1"]);
  });

  it("flag off: no host and no live region", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectChat, {
        projectId: "p1",
        projectName: "Acme",
        turns: [],
        publishTargets: [],
        userFirstName: "Emre",
        chatEngine: "agent",
      }),
    );
    expect(hostOf(html)).toBeNull();
    expect(html).not.toContain("aria-live");
  });
});

describe("ProjectChat composer shortcuts in a Work (W85)", () => {
  const sse = (events: object[]) =>
    events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const stubFetch = () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          sse([
            {
              type: "done",
              commandId: "c",
              status: "ANSWERED",
              reply: "ok",
            },
          ]),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  const sentText = (fetchMock: ReturnType<typeof stubFetch>) => {
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    return (call[1].body as FormData).get("text");
  };

  beforeEach(() => {
    state.submitShortcut.mockReset();
    state.announce.mockReset();
    state.settled.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tells the sidebar again when the turn is over, so a send that never made a chat does not leave a phantom row", async () => {
    const fetchMock = stubFetch();
    renderWork();
    await (state.plus as PlusProps).onShortcut(
      "CREATE_SOCIAL_POST",
      "Create an Instagram post",
    );
    expect(state.settled).toHaveBeenCalledTimes(1);
    expect(state.settled).toHaveBeenCalledWith({ projectId: "p1", workId: "w1" });
    // After the request, before nothing else: announce < fetch < settled.
    const first = (mock: { mock: { invocationCallOrder: number[] } }) =>
      mock.mock.invocationCallOrder[0] ?? 0;
    expect(first(state.announce)).toBeLessThan(first(fetchMock));
    expect(first(fetchMock)).toBeLessThan(first(state.settled));
  });

  it("settles even when the send fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    renderWork();
    await (state.plus as PlusProps).onShortcut(
      "CREATE_SOCIAL_POST",
      "Create an Instagram post",
    );
    expect(state.settled).toHaveBeenCalledTimes(1);
  });

  it("Today's brief is no Recents row: nothing is announced or settled for it", async () => {
    stubFetch();
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
          work: { ...work(["instagram"]), id: "today_p1_2026-10-02", title: "Today" },
          connections: { instagram: { connected: true } },
          pendingApprovals: 0,
          hasAnalytics: false,
        }),
      }),
    );
    await (state.plus as PlusProps).onShortcut(
      "CREATE_SOCIAL_POST",
      "Create an Instagram post",
    );
    expect(state.announce).not.toHaveBeenCalled();
    expect(state.settled).not.toHaveBeenCalled();
  });

  it("tells the sidebar the moment it sends (the chat joins Recents before the reply ends)", async () => {
    const fetchMock = stubFetch();
    renderWork();
    const plus = state.plus as PlusProps;
    await plus.onShortcut("CREATE_SOCIAL_POST", "Create an Instagram post. With a carousel.");
    expect(state.announce).toHaveBeenCalledTimes(1);
    expect(state.announce).toHaveBeenCalledWith({
      projectId: "p1",
      workId: "w1",
      title: "Create an Instagram post.",
    });
    // Announced before the request went out, not after the reply.
    expect(state.announce.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("a completed Work announces nothing (nothing is sent)", async () => {
    stubFetch();
    renderWork({}, ["instagram"], "DONE");
    const plus = state.plus as PlusProps;
    await plus.onShortcut("CREATE_SOCIAL_POST", "Create an Instagram post");
    expect(state.announce).not.toHaveBeenCalled();
  });

  it("sends a chat message (with the Work id) instead of the shortcut action", async () => {
    const fetchMock = stubFetch();
    renderWork();
    const plus = state.plus as PlusProps;
    expect(plus.works).toBe(true);
    await plus.onShortcut("CREATE_SOCIAL_POST", "Create an Instagram post");
    expect(state.submitShortcut).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentText(fetchMock)).toBe("Create an Instagram post");
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((call[1].body as FormData).get("workId")).toBe("w1");
  });

  it("a completed Work sends nothing", async () => {
    const fetchMock = stubFetch();
    renderWork({}, ["instagram"], "DONE");
    const plus = state.plus as PlusProps;
    await plus.onShortcut("CREATE_SOCIAL_POST", "Create an Instagram post");
    expect(state.submitShortcut).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flag off: the shortcut still uses the bypass action and works is false", async () => {
    const fetchMock = stubFetch();
    renderToStaticMarkup(
      createElement(ProjectChat, {
        projectId: "p1",
        projectName: "Acme",
        turns: [],
        publishTargets: [],
        chatEngine: "agent",
      }),
    );
    const plus = state.plus as PlusProps;
    expect(plus.works).toBe(false);
    // The plan shortcut under the agent engine is a chat message as before.
    await plus.onShortcut("CREATE_CONTENT_PLAN", "Create a content plan");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.submitShortcut).not.toHaveBeenCalled();
    // Any other shortcut takes the bypass (runTurn): it starts a transition,
    // which a server render refuses, so the call rejects before any fetch.
    await Promise.resolve(
      plus.onShortcut("CREATE_SOCIAL_POST", "Create an Instagram post"),
    ).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// A chat is free: a message carries its text and the Work id, nothing about
// channels (the chat route stores the defaults and the tools decide per piece).
describe("ProjectChat sends a message of a free chat", () => {
  const sse = (events: object[]) =>
    events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const stubFetch = () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          sse([{ type: "done", commandId: "c", status: "ANSWERED", reply: "ok" }]),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  beforeEach(() => {
    state.announce.mockReset();
    state.settled.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("goes out at once with the Work id and no channel field, after announcing the chat", async () => {
    const fetchMock = stubFetch();
    render([], true);
    await (state.plus as PlusProps).onShortcut(
      "CREATE_SOCIAL_POST",
      "Create an Instagram post",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = call[1].body as FormData;
    expect(body.get("workId")).toBe("w1");
    expect(body.getAll("channels")).toEqual([]);
    expect(state.announce.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("the turn is on screen before the request goes out", async () => {
    const fetchMock = stubFetch();
    const turnKey = vi.spyOn(globalThis.crypto, "randomUUID");
    render([], true);
    const sent = (state.plus as PlusProps).onShortcut(
      "CREATE_SOCIAL_POST",
      "Create an Instagram post",
    );
    // The local turn exists synchronously (and with it `isSending`).
    expect(turnKey).toHaveBeenCalledTimes(1);
    await sent;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    turnKey.mockRestore();
  });
});

describe("ProjectChat card-first messages (W85)", () => {
  it("a Work message with a non-keep card is card-only with no text", () => {
    renderWork();
    const out = optionsOf().convertMessage(
      assistant({ card: loose("creative-ready") }),
    );
    expect(out.content).toEqual([]);
    expect(out.metadata.custom.cardOnly).toBe(true);
  });

  it("a Work plan that carries via is card-only; one without keeps its text", () => {
    renderWork();
    const plan = (via?: string) =>
      loose("content-plan-draft", via ? { via } : {});
    const picked = optionsOf().convertMessage(assistant({ card: plan("options") }));
    expect(picked.content).toEqual([]);
    expect(picked.metadata.custom.cardOnly).toBe(true);
    const proposed = optionsOf().convertMessage(assistant({ card: plan() }));
    expect(proposed.content).toBe("Picked the direction.");
    expect(proposed.metadata.custom.cardOnly).toBe(false);
  });

  it("a keep-text card keeps its text and its action bar", () => {
    renderWork();
    for (const kind of ["plan-brief", "content-package", "guided-setup"]) {
      const out = optionsOf().convertMessage(assistant({ card: loose(kind) }));
      expect(out.content).toBe("Picked the direction.");
      expect(out.metadata.custom.cardOnly).toBe(false);
    }
  });

  it("a message without a card is not card-only", () => {
    renderWork();
    const out = optionsOf().convertMessage(assistant());
    expect(out.metadata.custom.cardOnly).toBe(false);
    expect(out.metadata.custom.pendingHint).toBeUndefined();
  });

  it("a streaming Work turn with neither card nor text gets a pending hint", () => {
    renderWork();
    const pending = (over: ChatMessage) =>
      optionsOf().convertMessage(
        assistant({ streaming: true, text: "", commandId: undefined, ...over }),
      ).metadata.custom.pendingHint;
    expect(pending({ pendingRequest: "[Plan brief]\nx" })).toBe("plan");
    expect(pending({ pendingRequest: "Give me content ideas" })).toBe("ideas");
    expect(pending({ pendingRequest: "hello" })).toBe("generic");
    // Text or a card already there: the skeleton gives way.
    expect(pending({ text: "Hmm" })).toBeUndefined();
    expect(pending({ card: loose("idea") })).toBeUndefined();
    // A settled message never gets one.
    expect(
      optionsOf().convertMessage(assistant({ text: "" })).metadata.custom
        .pendingHint,
    ).toBeUndefined();
  });

  it("flag off: the old text rule and no Works flags at all", () => {
    renderToStaticMarkup(
      createElement(ProjectChat, {
        projectId: "p1",
        projectName: "Acme",
        turns: [],
        publishTargets: [],
        chatEngine: "agent",
      }),
    );
    const plan = optionsOf().convertMessage(
      assistant({ card: loose("content-plan-draft", { via: "options" }) }),
    );
    expect(plan.content).toBe("Picked the direction.");
    expect(plan.metadata.custom).not.toHaveProperty("cardOnly");
    expect(plan.metadata.custom).not.toHaveProperty("pendingHint");
    const other = optionsOf().convertMessage(
      assistant({ card: loose("creative-ready") }),
    );
    expect(other.content).toEqual([]);
    expect(other.metadata.custom).not.toHaveProperty("cardOnly");
    const streaming = optionsOf().convertMessage(
      assistant({ streaming: true, text: "", pendingRequest: "[Plan brief]" }),
    );
    expect(streaming.metadata.custom).not.toHaveProperty("pendingHint");
  });
});
