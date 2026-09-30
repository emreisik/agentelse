import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Guided setup wiring of the project page (spec 4, 5.2): flag off reads and
// passes nothing; flag on reads ?guide and calls loadGuidedHost ONLY; the
// panel and entity branches return before it.

const mocks = vi.hoisted(() => ({
  enabled: false,
  loadGuidedHost: vi.fn(),
  parseHubParams: vi.fn(),
  prisma: {
    project: { findUnique: vi.fn() },
    command: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    creative: { findFirst: vi.fn() },
    task: { findMany: vi.fn() },
  },
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ CHAT_ENGINE: "agent" }) }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: async () => ({ userId: "u1" }),
  requireProjectAccess: async () => undefined,
}));
vi.mock("@/components/layout/app-shell", () => ({ AppShell: () => null }));
vi.mock("@/components/hub-core/hub-core-params", () => ({
  parseHubParams: mocks.parseHubParams,
  entityHref: () => "/x",
}));
vi.mock("@/components/hub-core/panel-shell", () => ({
  PanelShell: () => null,
}));
vi.mock("@/components/hub-core/project-flow-view", () => ({
  ProjectFlowView: () => null,
}));
vi.mock("@/components/commands/project-chat", () => ({
  ProjectChat: () => null,
}));
vi.mock("@/server/integrations/meta-connection-status", () => ({
  getPublishTargets: async () => [],
}));
vi.mock("@/server/agency/departments/department-registry", () => ({
  ownerOfCapability: () => undefined,
}));
vi.mock("@/components/workspace/workspace-right-panel-data", () => ({
  getWorkspaceRightPanelData: async () => ({
    autopilotMode: "OFF",
    brand: {},
    website: null,
    brandKit: null,
    files: [],
    outputs: [],
    calendar: {},
  }),
}));
vi.mock("@/components/workspace/workspace-right-panel", () => ({
  WorkspaceRightPanel: () => null,
}));
vi.mock("@/components/workspace/brand-summary-panel", () => ({
  BrandSummaryPanel: () => null,
}));
vi.mock("@/components/workspace/outputs-panel", () => ({
  OutputsPanel: () => null,
}));
vi.mock("@/components/workspace/calendar-panel", () => ({
  CalendarPanel: () => null,
}));
vi.mock("@/components/workspace/files-panel", () => ({
  FilesPanel: () => null,
}));
vi.mock("@/server/agency/pending-decisions", () => ({
  getPendingDecisions: async () => [],
}));
vi.mock("@/server/guided-setup/flag", () => ({
  isGuidedSetupEnabled: () => mocks.enabled,
}));
vi.mock("@/server/guided-setup/service", () => ({
  loadGuidedHost: mocks.loadGuidedHost,
}));

const { default: ProjectChatPage } = await import("./page");

const HOST = { marker: "host" };

async function renderPage(sp: Record<string, string | string[] | undefined>) {
  const element = (await ProjectChatPage({
    params: Promise.resolve({ projectId: "p1" }),
    searchParams: Promise.resolve(sp),
  })) as ReactElement<{ children: ReactElement }>;
  const wrapper = element.props.children as ReactElement<{
    children: ReactElement<Record<string, unknown>>;
  }>;
  return { element, chatProps: wrapper.props.children.props };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled = false;
  mocks.parseHubParams.mockReturnValue({
    panel: null,
    sub: null,
    entity: null,
  });
  mocks.loadGuidedHost.mockResolvedValue(HOST);
  mocks.prisma.project.findUnique.mockResolvedValue({ name: "Acme" });
  mocks.prisma.command.findMany.mockResolvedValue([]);
  mocks.prisma.user.findUnique.mockResolvedValue(null);
  mocks.prisma.task.findMany.mockResolvedValue([]);
});

describe("project page guided setup wiring", () => {
  it("flag off: loadGuidedHost is never called and no host is passed", async () => {
    const { chatProps } = await renderPage({ guide: "setup" });
    expect(mocks.loadGuidedHost).not.toHaveBeenCalled();
    expect(chatProps.guidedSetup).toBeUndefined();
  });

  it("flag on: ?guide=setup is passed as requested=true", async () => {
    mocks.enabled = true;
    const { chatProps } = await renderPage({ guide: "setup" });
    expect(mocks.loadGuidedHost).toHaveBeenCalledWith("p1", true);
    expect(chatProps.guidedSetup).toBe(HOST);
  });

  it("flag on: no param, an array and a stray value are not requested", async () => {
    mocks.enabled = true;
    await renderPage({});
    await renderPage({ guide: "other" });
    await renderPage({ guide: ["setup", "x"] });
    expect(mocks.loadGuidedHost.mock.calls.map((c) => c[1])).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("flag on: a host that failed to load (undefined) still renders the chat", async () => {
    mocks.enabled = true;
    mocks.loadGuidedHost.mockResolvedValue(undefined);
    const { chatProps } = await renderPage({ guide: "setup" });
    expect(chatProps.guidedSetup).toBeUndefined();
    expect(chatProps.projectName).toBe("Acme");
  });

  it("?guide is ignored with ?panel (the chat is swapped out)", async () => {
    mocks.enabled = true;
    mocks.parseHubParams.mockReturnValue({
      panel: "work",
      sub: null,
      entity: null,
    });
    await renderPage({ guide: "setup", panel: "work" }).catch(() => undefined);
    expect(mocks.loadGuidedHost).not.toHaveBeenCalled();
  });

  it("?guide is ignored with ?entity", async () => {
    mocks.enabled = true;
    mocks.parseHubParams.mockReturnValue({
      panel: null,
      sub: null,
      entity: { kind: "idea", id: "i1" },
    });
    await renderPage({ guide: "setup", entity: "idea:i1" }).catch(
      () => undefined,
    );
    expect(mocks.loadGuidedHost).not.toHaveBeenCalled();
  });
});
