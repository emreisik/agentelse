import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscoveryView } from "@/lib/guided-discovery/contract";
import type { DiscoveryHost } from "@/server/guided-discovery/host";
import type { GuidedSetupHost } from "@/lib/guided-setup/contract";

// ProjectChat host wiring of the discovery sheet (D1). Thread becomes a probe
// that prints the context it sees; next/dynamic becomes a stub that prints the
// props of whichever sheet renders, so the old and the new sheet are told apart
// by their props.

type ThreadProps = {
  autoFocusComposer?: boolean;
  components: { Welcome: ComponentType; QuickActions: ComponentType };
};

import { useDiscovery } from "@/components/discovery/discovery-context";
import { useGuidedSetup } from "@/components/guide/guided-setup-context";

const state = vi.hoisted(() => ({ messageCount: 0 }));

vi.mock("@/server/actions/work-approve-actions", () => ({
  approvePlansAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next/dynamic", () => ({
  default: () =>
    function SheetStub(props: Record<string, unknown>) {
      const discovery = "initialView" in props;
      return createElement("div", {
        [discovery ? "data-discovery-sheet" : "data-old-sheet"]: JSON.stringify({
          projectId: props.projectId,
          open: props.open,
          brandName: props.brandName,
          hasView: discovery ? props.initialView !== null : undefined,
        }),
      });
    },
}));
vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: ReactNode }) => children,
  useExternalStoreRuntime: () => ({}),
  useAuiState: (select: (s: unknown) => unknown) =>
    select({ thread: { messages: { length: state.messageCount } } }),
}));
vi.mock("@/server/actions/module-flow-actions", () => ({
  startModuleFlowAction: vi.fn(async () => ({ ok: true, commandId: "cmd-flow" })),
}));
vi.mock("@/server/actions/work-actions", () => ({
  setWorkChannelsAction: vi.fn(),
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
vi.mock("@/components/commands/composer-plus-menu", () => ({
  ComposerPlusMenu: () => null,
}));
vi.mock("@/components/workspace/workspace-panel-toggle", () => ({
  useWorkspacePanelToggle: () => ({ openTab: vi.fn() }),
  // No workspace pane around this chat.
  useWorkspaceDetail: () => null,
}));
vi.mock("@/components/guide/guided-setup-entry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/guide/guided-setup-entry")
  >()),
  // Like the real one: nothing without a guided context.
  ConnectedGuidedSetupChip: () => {
    const guided = useGuidedSetup();
    return guided ? createElement("i", null, "old-chip") : null;
  },
}));
vi.mock("@/components/discovery/discovery-entry-view", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/discovery/discovery-entry-view")
  >()),
  // The real chip hides itself on the server (localStorage snapshot).
  ConnectedDiscoveryChip: ({ projectId }: { projectId: string }) => {
    const discovery = useDiscovery();
    return discovery ? createElement("i", null, `discovery-chip:${projectId}`) : null;
  },
}));
vi.mock("@/components/assistant-ui/thread", async () => {
  const { useDiscovery } =
    await import("@/components/discovery/discovery-context");
  return {
    Thread: (props: ThreadProps) => {
      const discovery = useDiscovery();
      return createElement(
        "div",
        {
          "data-autofocus": String(props.autoFocusComposer),
          "data-discovery": discovery
            ? JSON.stringify({
                isOpen: discovery.isOpen,
                label: discovery.entry.label,
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

const view = (status: DiscoveryView["status"]): DiscoveryView => ({
  rev: "a".repeat(12),
  status,
  stages: {
    site: "done",
    identity: "done",
    research: "done",
    profile: "done",
  },
  identity: null,
  rows: [],
  host: "acme.com",
  failure: null,
  canRetry: false,
  brandName: "Acme",
});

const host = (over: Partial<DiscoveryHost> = {}): DiscoveryHost => ({
  requested: false,
  view: null,
  brandName: "Acme",
  ...over,
});

const render = (props: {
  discovery?: DiscoveryHost;
  guidedSetup?: GuidedSetupHost;
  ideaId?: string;
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
  state.messageCount = 0;
});

describe("ProjectChat discovery host", () => {
  it("prop absent: no discovery context, no sheet, no wrapper, autofocus as today", () => {
    const html = render({});
    expect(attr(html, "data-discovery")).toBe("null");
    expect(html).not.toContain("data-discovery-sheet");
    expect(html).not.toContain("discovery-chip");
    expect(html).not.toContain("Set up your brand");
    expect(html).not.toContain("empty:hidden");
    expect(attr(html, "data-autofocus")).toBe("true");
  });

  it("prop present: context is live, the sheet is mounted closed, the welcome card shows", () => {
    const html = render({ discovery: host() });
    expect(JSON.parse(attr(html, "data-discovery") ?? "null")).toEqual({
      isOpen: false,
      label: "Set up your brand",
    });
    expect(JSON.parse(attr(html, "data-discovery-sheet") ?? "null")).toEqual({
      projectId: "p1",
      open: false,
      brandName: "Acme",
      hasView: false,
    });
    expect(html).toContain("Set up your brand");
    expect(html).not.toContain("data-old-sheet");
    expect(attr(html, "data-autofocus")).toBe("true");
  });

  it("the label follows the view (running, ready, confirmed)", () => {
    const label = (status: DiscoveryView["status"]) =>
      JSON.parse(
        attr(render({ discovery: host({ view: view(status) }) }), "data-discovery") ??
          "null",
      ).label;
    expect(label("RUNNING")).toBe("Getting to know Acme…");
    expect(label("READY")).toBe("Review your brand profile");
    expect(label("CONFIRMED")).toBe("Update your setup");
  });

  it("a confirmed profile shows no welcome card", () => {
    const html = render({ discovery: host({ view: view("CONFIRMED") }) });
    expect(html).not.toContain("Open</button>");
    expect(html).not.toContain("Start</button>");
  });

  it("an idea thread never mounts the sheet nor gives a context", () => {
    const html = render({ discovery: host({ requested: true }), ideaId: "i1" });
    expect(attr(html, "data-discovery")).toBe("null");
    expect(html).not.toContain("data-discovery-sheet");
    expect(html).not.toContain("discovery-chip");
  });

  it("?guide=setup opens the sheet at first render and keeps the composer quiet", () => {
    const html = render({ discovery: host({ requested: true }) });
    expect(JSON.parse(attr(html, "data-discovery") ?? "null").isOpen).toBe(true);
    expect(JSON.parse(attr(html, "data-discovery-sheet") ?? "null").open).toBe(
      true,
    );
    expect(attr(html, "data-autofocus")).toBe("false");
  });

  it("a plain visit never auto-opens", () => {
    const html = render({ discovery: host({ view: view("RUNNING") }) });
    expect(JSON.parse(attr(html, "data-discovery") ?? "null").isOpen).toBe(false);
  });

  it("the discovery host wins: the old sheet and chip never mount beside it", () => {
    const html = render({
      discovery: host(),
      guidedSetup: {
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
        requested: true,
      },
    });
    expect(html).not.toContain("data-old-sheet");
    expect(html).not.toContain("old-chip");
    expect(html).toContain("discovery-chip:p1");
  });

  it("the chip is in the quick actions row", () => {
    const html = render({ discovery: host() });
    expect(html).toContain("discovery-chip:p1");
  });
});
