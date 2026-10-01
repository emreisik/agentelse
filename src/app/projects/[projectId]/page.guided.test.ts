import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Guided setup wiring of the project page (spec 4, 5.2; D1 host): flag off reads and
// passes nothing; flag on reads ?guide and calls loadDiscoveryHost ONLY; the
// panel and entity branches return before it.

const mocks = vi.hoisted(() => ({
  enabled: false,
  worksOn: false,
  ProjectChat: () => null,
  getPendingDecisions: vi.fn(),
  loadJourneySnapshot: vi.fn(),
  computeNextSteps: vi.fn(),
  workRepo: {
    get: vi.fn(),
    findToday: vi.fn(),
    latestActive: vi.fn(),
    listRecent: vi.fn(),
    channelCoverage: vi.fn(),
  },
  getChannelConnections: vi.fn(),
  loadBriefExtras: vi.fn(),
  loadAdsPulse: vi.fn(),
  loadDiscoveryHost: vi.fn(),
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
  ProjectChat: mocks.ProjectChat,
}));
vi.mock("@/server/integrations/meta-connection-status", () => ({
  getPublishTargets: async () => [],
}));
vi.mock("@/server/agency/departments/department-registry", () => ({
  ownerOfCapability: () => undefined,
}));
vi.mock("@/components/workspace/workspace-right-panel-data", () => ({
  getWorkspaceRightPanelData: async () => ({
    brand: {},
    website: null,
    brandKit: null,
    connections: [],
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
  getPendingDecisions: mocks.getPendingDecisions,
}));
vi.mock("@/server/agency/journey/next-steps", () => ({
  computeNextSteps: mocks.computeNextSteps,
}));
// The content-plan journey has its own suites; here the page just renders
// without it.
vi.mock("@/server/agency/journey/snapshot", () => ({
  loadJourneySnapshot: mocks.loadJourneySnapshot,
}));
// Works: the flag, the Work rows, the connections and the wave-2 loaders (the
// daily brief's extras and the ads pulse) are mocked; flag off none is called.
vi.mock("@/server/works/flag", () => ({
  isWorksEnabled: () => mocks.worksOn,
}));
vi.mock("@/server/repositories/work.repository", () => ({
  WorkRepository: mocks.workRepo,
}));
vi.mock("@/server/integrations/channel-connections", () => ({
  getChannelConnections: mocks.getChannelConnections,
}));
vi.mock("@/server/works/daily-brief", () => ({
  loadBriefExtras: mocks.loadBriefExtras,
}));
vi.mock("@/server/works/ads-pulse", () => ({
  loadAdsPulse: mocks.loadAdsPulse,
}));
// Works overlays, the project timezone and the AI-off probe are Works-only
// reads; mocked so the flag-off path runs without their IO modules.
vi.mock("@/server/works/page-overlays", () => ({
  applyWorkOverlays: (card: unknown) => card,
  loadWorkActivity: async () => ({ working: false }),
  loadWorkOverlayInputs: async () => ({}),
}));
vi.mock("@/server/chat/content-plan", () => ({
  getProjectTimezone: async () => "Europe/Istanbul",
  todayInTimezone: () => "2026-10-01",
}));
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { isMockMode: () => false },
}));
vi.mock("@/server/guided-setup/flag", () => ({
  isGuidedSetupEnabled: () => mocks.enabled,
}));
vi.mock("@/server/guided-discovery/host", () => ({
  loadDiscoveryHost: mocks.loadDiscoveryHost,
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
  mocks.worksOn = false;
  mocks.getPendingDecisions.mockResolvedValue([]);
  mocks.loadJourneySnapshot.mockResolvedValue(null);
  mocks.computeNextSteps.mockReturnValue([]);
  mocks.getChannelConnections.mockResolvedValue({});
  mocks.workRepo.channelCoverage.mockResolvedValue([]);
  mocks.workRepo.listRecent.mockResolvedValue([]);
  mocks.parseHubParams.mockReturnValue({
    panel: null,
    sub: null,
    entity: null,
  });
  mocks.loadDiscoveryHost.mockResolvedValue(HOST);
  mocks.prisma.project.findUnique.mockResolvedValue({ name: "Acme" });
  mocks.prisma.command.findMany.mockResolvedValue([]);
  mocks.prisma.user.findUnique.mockResolvedValue(null);
  mocks.prisma.task.findMany.mockResolvedValue([]);
});

describe("project page guided setup wiring", () => {
  it("flag off: loadDiscoveryHost is never called and no host is passed", async () => {
    const { chatProps } = await renderPage({ guide: "setup" });
    expect(mocks.loadDiscoveryHost).not.toHaveBeenCalled();
    expect(chatProps.discovery).toBeUndefined();
  });

  it("flag on: ?guide=setup is passed as requested=true", async () => {
    mocks.enabled = true;
    const { chatProps } = await renderPage({ guide: "setup" });
    expect(mocks.loadDiscoveryHost).toHaveBeenCalledWith("p1", true);
    expect(chatProps.discovery).toBe(HOST);
    // The old host is neither loaded nor passed.
    expect(chatProps.guidedSetup).toBeUndefined();
  });

  it("flag on: no param, an array and a stray value are not requested", async () => {
    mocks.enabled = true;
    await renderPage({});
    await renderPage({ guide: "other" });
    await renderPage({ guide: ["setup", "x"] });
    expect(mocks.loadDiscoveryHost.mock.calls.map((c) => c[1])).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("flag on: a host that failed to load (undefined) still renders the chat", async () => {
    mocks.enabled = true;
    mocks.loadDiscoveryHost.mockResolvedValue(undefined);
    const { chatProps } = await renderPage({ guide: "setup" });
    expect(chatProps.discovery).toBeUndefined();
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
    expect(mocks.loadDiscoveryHost).not.toHaveBeenCalled();
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
    expect(mocks.loadDiscoveryHost).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Works wave 2: Today alias, live brief and ads turns (spec 3.11.2, 3.12)
// ---------------------------------------------------------------------------

type AnyProps = Record<string, unknown>;

// Depth-first search of the rendered element tree for the (mocked) chat.
function findChatProps(node: unknown): AnyProps | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findChatProps(child);
      if (found) return found;
    }
    return undefined;
  }
  const element = node as { type?: unknown; props?: AnyProps };
  if (element.type === mocks.ProjectChat) return element.props;
  return findChatProps(element.props?.children);
}

async function renderWork(sp: Record<string, string | string[] | undefined>) {
  const element = await ProjectChatPage({
    params: Promise.resolve({ projectId: "p1" }),
    searchParams: Promise.resolve(sp),
  });
  const chat = findChatProps(element);
  return {
    element,
    chat,
    turns: (chat?.turns ?? []) as { commandId: string; card?: AnyProps }[],
  };
}

function work(over: Record<string, unknown> = {}) {
  return {
    id: "w1",
    title: "Autumn push",
    summary: null,
    status: "ACTIVE",
    channels: ["instagram"],
    acknowledgedUnconnected: [],
    lastActivityAt: "2026-10-01T08:00:00.000Z",
    ...over,
  };
}

const TODAY_ID = "today_p1_2026-10-01";
const EXTRAS = {
  todayItems: [],
  yesterdayPublished: 0,
  yesterdayFailed: 0,
  shortlistedIdeas: 0,
};
const PULSE = { connected: false, hasAccount: false, proposals: [] };

function spendDecision(approvalId: string, taskId: string) {
  return {
    approvalId,
    createdAt: "2026-10-01T07:00:00.000Z",
    card: { kind: "task-approval", taskId, title: "Budget" },
  };
}

describe("project page Works wave 2", () => {
  beforeEach(() => {
    mocks.worksOn = true;
    mocks.loadBriefExtras.mockResolvedValue(EXTRAS);
    mocks.loadAdsPulse.mockResolvedValue(PULSE);
  });

  it("flag off: no Works loader, repository or connection read is called", async () => {
    mocks.worksOn = false;
    await renderPage({ work: "today" });
    expect(mocks.loadBriefExtras).not.toHaveBeenCalled();
    expect(mocks.loadAdsPulse).not.toHaveBeenCalled();
    expect(mocks.getChannelConnections).not.toHaveBeenCalled();
    for (const fn of Object.values(mocks.workRepo)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("?work=today with no Today Work yet renders the opener in today mode", async () => {
    mocks.workRepo.findToday.mockResolvedValue(null);
    const { element } = await renderWork({ work: "today" });
    const opener = (
      element as { props: { children: { props: AnyProps } } }
    ).props.children;
    expect(opener.props).toEqual({ projectId: "p1", mode: "today" });
    expect(mocks.workRepo.findToday).toHaveBeenCalledWith("p1", "2026-10-01");
  });

  it("a bare URL never opens a Today Work", async () => {
    mocks.workRepo.latestActive.mockResolvedValue(work());
    await renderWork({});
    expect(mocks.workRepo.latestActive).toHaveBeenCalledWith("p1", {
      excludeToday: true,
    });
  });

  it("a bare URL with no ordinary active Work never falls back to an earlier day's Today", async () => {
    mocks.workRepo.latestActive.mockResolvedValue(null);
    mocks.workRepo.listRecent.mockResolvedValue([work()]);
    await renderWork({});
    expect(mocks.workRepo.listRecent).toHaveBeenCalledWith("p1", 1, {
      todayKey: "2026-10-01",
    });
  });

  it("a stale ?work= id still goes back to the bare URL", async () => {
    mocks.workRepo.get.mockResolvedValue(null);
    await expect(renderWork({ work: "gone" })).rejects.toThrow("redirect:/projects/p1");
  });

  it("Today of today: the brief then the ads card lead the conversation, never stored", async () => {
    mocks.workRepo.findToday.mockResolvedValue(
      work({ id: TODAY_ID, channels: [] }),
    );
    const { turns } = await renderWork({ work: "today" });
    expect(turns.map((t) => t.commandId)).toEqual([
      `brief-${TODAY_ID}`,
      `ads-${TODAY_ID}`,
    ]);
    expect(turns[0]!.card?.kind).toBe("daily-brief");
    expect(turns[1]!.card?.kind).toBe("ads-insight");
    expect(mocks.loadBriefExtras).toHaveBeenCalledWith(
      "p1",
      "Europe/Istanbul",
      "2026-10-01",
    );
    // Today is project-wide: the journey is not scoped to the Work.
    expect(mocks.loadJourneySnapshot).toHaveBeenCalledWith("p1");
  });

  it("a Today Work of an earlier day has no brief and no extras read", async () => {
    mocks.workRepo.get.mockResolvedValue(
      work({ id: "today_p1_2026-09-30", channels: [] }),
    );
    const { turns } = await renderWork({ work: "today_p1_2026-09-30" });
    expect(mocks.loadBriefExtras).not.toHaveBeenCalled();
    expect(turns.map((t) => t.commandId)).not.toContain(
      "brief-today_p1_2026-09-30",
    );
  });

  it("an ordinary Work gets no brief, and an ads card only when it chose ads", async () => {
    mocks.workRepo.get.mockResolvedValue(work());
    const plain = await renderWork({ work: "w1" });
    expect(plain.turns).toEqual([]);
    expect(mocks.loadBriefExtras).not.toHaveBeenCalled();
    expect(mocks.loadAdsPulse).not.toHaveBeenCalled();

    mocks.workRepo.get.mockResolvedValue(work({ channels: ["ads"] }));
    const ads = await renderWork({ work: "w1" });
    expect(ads.turns.map((t) => t.commandId)).toEqual(["ads-w1"]);
    expect(mocks.loadBriefExtras).not.toHaveBeenCalled();
  });

  it("a proposal shown on the ads card is not repeated as a decision turn", async () => {
    mocks.workRepo.get.mockResolvedValue(work({ channels: ["ads"] }));
    mocks.getPendingDecisions.mockResolvedValue([
      spendDecision("ap1", "t1"),
      spendDecision("ap2", "t2"),
    ]);
    mocks.prisma.task.findMany.mockResolvedValue([
      { id: "t1", capability: "META_CAMPAIGN_UPDATE", command: null },
      { id: "t2", capability: "META_CAMPAIGN_UPDATE", command: null },
    ]);
    mocks.loadAdsPulse.mockResolvedValue({
      connected: true,
      hasAccount: true,
      digest: null,
      proposals: [
        {
          taskId: "t1",
          approvalId: "ap1",
          capability: "META_CAMPAIGN_UPDATE",
        },
      ],
    });
    const { turns } = await renderWork({ work: "w1" });
    expect(turns.map((t) => t.commandId)).toEqual(["ads-w1", "decision-ap2"]);
  });

  it("an unowned spend proposal follows decisionBelongsToWork", async () => {
    mocks.getPendingDecisions.mockResolvedValue([spendDecision("ap1", "t1")]);
    mocks.prisma.task.findMany.mockResolvedValue([
      { id: "t1", capability: "META_CAMPAIGN_UPDATE", command: null },
    ]);
    mocks.workRepo.get.mockResolvedValue(work());

    // No active Work covers ads: it must stay reachable from here.
    mocks.workRepo.channelCoverage.mockResolvedValue([
      { id: "w1", channels: ["instagram"], status: "ACTIVE" },
    ]);
    const open = await renderWork({ work: "w1" });
    expect(open.turns.map((t) => t.commandId)).toContain("decision-ap1");

    // Another active Work covers ads: it waits there.
    mocks.workRepo.channelCoverage.mockResolvedValue([
      { id: "w1", channels: ["instagram"], status: "ACTIVE" },
      { id: "w2", channels: ["ads"], status: "ACTIVE" },
    ]);
    const owned = await renderWork({ work: "w1" });
    expect(owned.turns.map((t) => t.commandId)).not.toContain("decision-ap1");
  });

  it("a bulk Approve leaves out pieces that still have picture alternatives", async () => {
    mocks.workRepo.get.mockResolvedValue(work());
    mocks.loadJourneySnapshot.mockResolvedValue({ today: "2026-10-01", items: [] });
    mocks.computeNextSteps.mockReturnValue([
      {
        key: "approve",
        tone: "next",
        label: "Approve 3",
        title: "3 pieces are ready",
        action: {
          kind: "approve_plan",
          planIds: ["pl"],
          creativeIds: ["c1", "c2", "c3"],
          count: 3,
        },
      },
    ]);
    mocks.getPendingDecisions.mockResolvedValue([
      {
        approvalId: "ap1",
        createdAt: "2026-10-01T07:00:00.000Z",
        card: {
          kind: "creative-ready",
          creativeId: "c1",
          status: "IN_REVIEW",
          title: "c1",
          alternatives: [{ assetId: "a" }],
        },
      },
    ]);
    const { chat } = await renderWork({ work: "w1" });
    const steps = chat?.nextSteps as {
      action: { creativeIds: string[]; count: number };
    }[];
    expect(steps[0]!.action.creativeIds).toEqual(["c2", "c3"]);
    expect(steps[0]!.action.count).toBe(2);
  });

  it("flag off: next steps are the journey's own, untouched", async () => {
    mocks.worksOn = false;
    const steps = [{ key: "k", action: { kind: "plan_next", afterDate: "x" } }];
    mocks.loadJourneySnapshot.mockResolvedValue({ today: "2026-10-01", items: [] });
    mocks.computeNextSteps.mockReturnValue(steps);
    const { chatProps } = await renderPage({});
    expect(chatProps.nextSteps).toBe(steps);
  });
});
