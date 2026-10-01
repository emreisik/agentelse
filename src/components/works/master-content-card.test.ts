import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultFormat } from "@/lib/content-channels";
import type { MasterContentCardData } from "@/lib/works/master-content";
import type { ScheduleMasterResult } from "@/server/actions/master-content-actions";
import type { WorkCardHostInput } from "./work-card-host";

// The server renderer refuses startTransition; a tap must still run its action.
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useTransition: () =>
      [false, (callback: () => void) => callback()] as ReturnType<
        typeof actual.useTransition
      >,
  };
});

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const actions = vi.hoisted(() => ({
  scheduleMasterAction: vi.fn(),
  toggleMasterTargetAction: vi.fn(),
  addMasterChannelAction: vi.fn(),
  suggestSlotsAction: vi.fn(),
}));
vi.mock("@/server/actions/master-content-actions", () => ({
  scheduleMasterAction: actions.scheduleMasterAction,
  toggleMasterTargetAction: actions.toggleMasterTargetAction,
  addMasterChannelAction: actions.addMasterChannelAction,
}));
vi.mock("@/server/actions/slot-suggest-actions", () => ({
  suggestSlotsAction: actions.suggestSlotsAction,
}));

// Static markup cannot click: the Button renders a real <button> AND records
// its onClick by label, so a test can press it like a tap would.
const clicks = vi.hoisted(() => new Map<string, () => void>());
vi.mock("@/components/ui/button", async () => {
  const { createElement: h } = await import("react");
  const textOf = (node: unknown): string =>
    typeof node === "string"
      ? node
      : Array.isArray(node)
        ? node.map(textOf).join("")
        : "";
  return {
    buttonVariants: () => "",
    Button: (props: {
      onClick?: () => void;
      children?: unknown;
      variant?: string;
      size?: string;
    }) => {
      const { onClick, children, variant, size, ...rest } = props;
      void variant;
      void size;
      if (onClick) clicks.set(textOf(children).trim(), onClick);
      return h("button", rest, children as ReactNode);
    },
  };
});

const {
  MasterContentCard,
  MasterSchedulePanelView,
  masterButtons,
  mapAdaptResponse,
  mapScheduleMasterResult,
  scheduleOptionsOf,
  visualsRequestOf,
} = await import("./master-content-card");
const { WorkCardHostProvider } = await import("./work-card-host");

const HOST: WorkCardHostInput = {
  projectId: "p1",
  workId: "w1",
  workTitle: "Week",
  active: true,
  busy: false,
  producing: new Set<string>(),
  timezone: "Europe/Istanbul",
  channels: [
    { key: "instagram", label: "Instagram", connected: true },
    { key: "linkedin", label: "LinkedIn", connected: false },
    { key: "seo", label: "Blog / SEO", connected: true },
  ],
  openTab: () => undefined,
  runNextStep: () => undefined,
};

const DRAFT: MasterContentCardData = {
  kind: "master-content",
  title: "Autumn launch",
  state: "draft",
  master: {
    title: "Autumn launch",
    message: "Our new plans are here.\nStart free today.",
  },
  targets: [
    {
      channel: "instagram",
      formatKey: defaultFormat("instagram").key,
      included: true,
    },
    {
      channel: "linkedin",
      formatKey: defaultFormat("linkedin").key,
      included: true,
    },
    { channel: "seo", formatKey: defaultFormat("seo").key, included: false },
  ],
  brandCheck: { state: "checked", rules: 2 },
};

const ADAPTED: MasterContentCardData = {
  ...DRAFT,
  state: "adapted",
  targets: DRAFT.targets.map((target) =>
    target.channel === "instagram"
      ? {
          ...target,
          adaptation: {
            topic: "Plans are live",
            captionIdea: "A short IG caption idea.",
            issues: ["Mentions an absolute claim"],
          },
        }
      : target.channel === "linkedin"
        ? {
            ...target,
            adaptation: {
              topic: "What changed for teams",
              captionIdea: "A LinkedIn angle.",
            },
          }
        : target,
  ),
};

const count = (html: string, needle: string) => html.split(needle).length - 1;

function render(
  card: MasterContentCardData = DRAFT,
  host: Partial<WorkCardHostInput> | null = {},
) {
  const inner = createElement(MasterContentCard, { card, commandId: "cmd1" });
  return renderToStaticMarkup(
    host === null
      ? inner
      : createElement(
          WorkCardHostProvider,
          { value: { ...HOST, ...host } },
          inner,
        ),
  );
}

// The button row the person sees: every element carrying data-emphasis.
function emphases(html: string): string[] {
  return [...html.matchAll(/data-emphasis="(primary|secondary|quiet)"/g)].map(
    (m) => m[1]!,
  );
}

beforeEach(() => {
  clicks.clear();
  router.refresh.mockReset();
  actions.scheduleMasterAction.mockReset();
  actions.suggestSlotsAction.mockReset();
  actions.suggestSlotsAction.mockResolvedValue({
    ok: true,
    timezone: "Europe/Istanbul",
    byChannel: { instagram: [{ date: "2026-10-02", time: "11:00" }] },
  });
});

describe("MasterContentCard states (W93 master-card-ui)", () => {
  it("draft: status, message, brand line and exactly Adapt (primary) + Add to calendar", () => {
    const html = render();
    expect(html).toContain('data-card="master-content"');
    expect(html).toContain("Draft");
    expect(html).toContain("Main message");
    expect(html).toContain("Our new plans are here.");
    expect(html).toContain("Checked against 2 brand rules.");
    expect(count(html, "Adapt to channels")).toBe(1);
    expect(count(html, "Add to calendar")).toBe(1);
    expect(emphases(html)).toEqual(["primary", "secondary"]);
    // 3 visuals are not offered before scheduling in the draft state.
    expect(html).not.toContain("make 3 visuals");
    expect(html).not.toContain("Re-adapt");
  });

  it("adapted: Add to calendar (primary) + Add & make 3 visuals + quiet Re-adapt, with the cost line", () => {
    const html = render(ADAPTED);
    expect(html).toContain("Adapted");
    expect(emphases(html)).toEqual(["primary", "secondary", "quiet"]);
    expect(html).toContain("Add &amp; make 3 visuals");
    expect(html).toContain("Re-adapt");
    expect(html).toContain("Makes 3 pictures, about $0.24.");
    expect(html).not.toContain("Adapt to channels");
  });

  it("never shows a Preview button or panel, in any state", () => {
    for (const card of [
      DRAFT,
      ADAPTED,
      { ...DRAFT, state: "superseded" as const },
    ]) {
      expect(render(card)).not.toMatch(/Preview/i);
    }
  });

  it("adapted rows show the adaptation and the Worth a check warning only for issues", () => {
    const html = render(ADAPTED);
    expect(html).toContain("Plans are live");
    expect(html).toContain("A short IG caption idea.");
    expect(html).toContain("What changed for teams");
    expect(count(html, "data-row-issues")).toBe(1);
    expect(html).toContain("Worth a check");
    expect(html).toContain("Mentions an absolute claim");
    // The draft has no rows yet.
    expect(render(DRAFT)).not.toContain("data-target-row");
  });

  it("a card without a picture channel has no visuals button and no cost line", () => {
    const html = render({
      ...ADAPTED,
      targets: ADAPTED.targets.filter((t) => t.channel !== "instagram"),
    });
    expect(emphases(html)).toEqual(["primary", "quiet"]);
    expect(html).not.toContain("make 3 visuals");
    expect(html).not.toContain("Makes 3 pictures");
  });

  it("hides Re-adapt once the card used its runs", () => {
    const html = render({ ...ADAPTED, adaptRuns: 3 });
    expect(html).not.toContain("Re-adapt");
    expect(emphases(html)).toEqual(["primary", "secondary"]);
  });

  it("a superseded card is dashed, says so and offers only Show the newer card", () => {
    const html = render({ ...DRAFT, state: "superseded" });
    expect(html).toContain("Replaced by a newer version");
    expect(html).toContain("border-dashed");
    expect(html).toContain("Show the newer card");
    expect(html).not.toContain("Adapt to channels");
    expect(html).not.toContain("aria-pressed");
    expect(emphases(html)).toEqual(["quiet"]);
  });

  it("blocks the buttons with one visible reason in a completed Work", () => {
    const html = render(DRAFT, { active: false });
    expect(html).toContain("This Work is completed. Reopen it to continue.");
    expect(count(html, 'aria-disabled="true"')).toBeGreaterThanOrEqual(2);
  });

  it("renders nothing without a WorkCardHost (Works off)", () => {
    expect(render(DRAFT, null)).toBe("");
  });
});

describe("MasterContentCard chips (master-card-ui)", () => {
  it("renders a labelled Channels group with toggle chips and the Website label", () => {
    const html = render();
    expect(html).toContain('role="group" aria-label="Channels"');
    expect(html).toContain("Website");
    expect(html).not.toContain("Blog / SEO");
    // Instagram ticked, Website known to the Work but not ticked.
    expect(html).toMatch(
      /data-chip="instagram"[^>]*>\s*<button[^>]*aria-pressed="true"/,
    );
    expect(html).toMatch(
      /data-chip="seo"[^>]*>\s*<button[^>]*aria-pressed="false"/,
    );
  });

  it("a ticked channel that is not connected is locked with a Connect link back to the Work", () => {
    const html = render();
    expect(html).toContain("Publishing locked");
    expect(html).toContain("Connect");
    expect(html).toContain(
      'href="/projects/p1/integrations?integration=linkedin&amp;from=w1"',
    );
    expect(count(html, "Publishing locked")).toBe(1);
  });

  it("channels outside the Work are dashed + Add buttons; Facebook and Email are never chips", () => {
    const html = render();
    expect(count(html, 'data-chip-state="outside"')).toBe(3);
    expect(html).toContain("+ Add TikTok");
    expect(html).toContain("+ Add X");
    expect(html).toContain("+ Add Ads");
    expect(html).toContain("border-dashed");
    expect(html).not.toMatch(/Facebook|Email/);
    // One chip per catalog channel, nothing more.
    expect(count(html, "data-chip=")).toBe(count(html, 'data-chip-state="'));
    expect(count(html, "data-chip=")).toBe(6);
  });

  it("every chip is at least 44 px tall", () => {
    const html = render();
    const chips = [
      ...html.matchAll(/<button[^>]*(?:aria-pressed|data-chip)[^>]*>/g),
    ];
    expect(chips.length).toBeGreaterThanOrEqual(6);
    for (const chip of chips) expect(chip[0]).toContain("min-h-11");
  });
});

describe("MasterSchedulePanelView (W93 schedule panel)", () => {
  type PanelProps = Parameters<typeof MasterSchedulePanelView>[0];
  const PANEL: PanelProps = {
    leadLabel: "Instagram",
    slots: [
      { date: "2026-10-02", time: "11:00" },
      { date: "2026-10-03", time: "10:00" },
    ],
    index: 0,
    timezone: "Europe/Istanbul",
    loading: false,
    othersFollow: true,
    canVisuals: true,
    costLine: "Makes 3 pictures, about $0.24.",
    brandBlocked: false,
    busyId: null,
    error: null,
    disabledReason: null,
    onOther: () => undefined,
    onAct: () => undefined,
  };
  const panel = (over: Partial<PanelProps> = {}) =>
    renderToStaticMarkup(
      createElement(MasterSchedulePanelView, { ...PANEL, ...over }),
    );

  it("shows the lead channel's suggestion, the zone, the other-channels note and Cancel BEFORE any commit", () => {
    const html = panel();
    expect(html).toContain("Instagram");
    expect(html).toContain("Fri 2 Oct, 11:00 suggested");
    expect(html).toContain("Times in Europe/Istanbul");
    expect(html).toContain("Other channels follow on the next free day.");
    expect(html).toContain("Other time");
    expect(html).toContain("Cancel");
    expect(html).toContain("Add to calendar");
  });

  it("keeps the button budget: three buttons, one primary (Add to calendar)", () => {
    const html = panel();
    expect(emphases(html)).toEqual(["primary", "secondary", "quiet"]);
    expect(html).toContain("Add &amp; make 3 visuals");
    expect(html).toContain("Makes 3 pictures, about $0.24.");
  });

  it("shows the second suggestion once the index moved", () => {
    expect(panel({ index: 1 })).toContain("Sat 3 Oct, 10:00 suggested");
  });

  it("has no Other time for a single suggestion and no note for a single channel", () => {
    const html = panel({
      slots: [{ date: "2026-10-02", time: "11:00" }],
      othersFollow: false,
    });
    expect(html).not.toContain("Other time");
    expect(html).not.toContain("Other channels follow");
  });

  it("blocks the buttons with a visible reason while loading and when no day is free", () => {
    const loading = panel({ loading: true, slots: undefined });
    expect(loading).toContain("Finding a free day…");
    expect(loading).toContain('aria-disabled="true"');
    const empty = panel({ slots: [] });
    expect(empty).toContain("No free day in the next 60 days for Instagram.");
    expect(empty).toContain('aria-disabled="true"');
  });

  it("turns the primary into Add anyway after a brand block and drops the picture variant", () => {
    const html = panel({ brandBlocked: true });
    expect(html).toContain("Add anyway");
    expect(html).not.toContain("make 3 visuals");
    expect(emphases(html)).toEqual(["primary", "quiet"]);
  });

  it("has no visuals variant when no channel makes a picture", () => {
    const html = panel({ canVisuals: false, costLine: null });
    expect(emphases(html)).toEqual(["primary", "quiet"]);
  });
});

describe("masterButtons budget (W93)", () => {
  const states = ["draft", "adapted"] as const;
  it("is never more than three buttons with at most one primary, in every combination", () => {
    for (const state of states) {
      for (const canVisuals of [true, false]) {
        for (const canReadapt of [true, false]) {
          for (const checkAgain of [true, false]) {
            const buttons = masterButtons({
              state,
              busyId: null,
              canVisuals,
              canReadapt,
              checkAgain,
              disabledReason: null,
            });
            expect(buttons.length).toBeLessThanOrEqual(3);
            expect(
              buttons.filter((b) => b.emphasis === "primary"),
            ).toHaveLength(1);
            expect(buttons.map((b) => b.label)).not.toContain("Preview");
          }
        }
      }
    }
  });

  it("shows Check again after BUSY: it joins a draft and replaces Re-adapt when adapted", () => {
    const draft = masterButtons({
      state: "draft",
      busyId: null,
      canVisuals: true,
      canReadapt: true,
      checkAgain: true,
      disabledReason: null,
    });
    expect(draft.map((b) => b.label)).toEqual([
      "Adapt to channels",
      "Add to calendar",
      "Check again",
    ]);
    const adapted = masterButtons({
      state: "adapted",
      busyId: null,
      canVisuals: true,
      canReadapt: true,
      checkAgain: true,
      disabledReason: null,
    });
    expect(adapted.map((b) => b.label)).toEqual([
      "Add to calendar",
      "Add & make 3 visuals",
      "Check again",
    ]);
    const without = masterButtons({
      state: "draft",
      busyId: null,
      canVisuals: true,
      canReadapt: true,
      checkAgain: false,
      disabledReason: null,
    });
    expect(without.map((b) => b.label)).not.toContain("Check again");
  });

  it("labels the running adapt button Adapting…", () => {
    const buttons = masterButtons({
      state: "draft",
      busyId: "adapt",
      canVisuals: false,
      canReadapt: true,
      checkAgain: false,
      disabledReason: null,
    });
    expect(buttons[0]!.label).toBe("Adapting…");
  });
});

describe("taps (W93: two taps, dates before the commit)", () => {
  it("Add to calendar opens the panel (asks for the lead suggestion) and does NOT commit", async () => {
    render();
    const open = clicks.get("Add to calendar");
    expect(open).toBeTypeOf("function");
    open?.();
    await vi.waitFor(() =>
      expect(actions.suggestSlotsAction).toHaveBeenCalledTimes(1),
    );
    // Instagram: the first ticked connected social channel leads.
    expect(actions.suggestSlotsAction).toHaveBeenCalledWith("p1", "w1", {
      channels: ["instagram"],
    });
    expect(actions.scheduleMasterAction).not.toHaveBeenCalled();
  });

  it("Add & make 3 visuals opens the same panel and does NOT commit", async () => {
    render(ADAPTED);
    clicks.get("Add & make 3 visuals")?.();
    await vi.waitFor(() =>
      expect(actions.suggestSlotsAction).toHaveBeenCalledTimes(1),
    );
    expect(actions.scheduleMasterAction).not.toHaveBeenCalled();
  });

  it("Adapt to channels posts to the master adapt route and refreshes on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      render();
      clicks.get("Adapt to channels")?.();
      await vi.waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/projects/p1/chat/master/adapt");
      expect(JSON.parse(String(init.body))).toEqual({ commandId: "cmd1" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a BUSY answer does not refresh the page (the person taps Check again)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ ok: false, code: "BUSY" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      render();
      clicks.get("Adapt to channels")?.();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(router.refresh).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("mapAdaptResponse", () => {
  it("maps ok, MOCK, BUSY, wrong kind and everything else", () => {
    expect(mapAdaptResponse(200, { ok: true })).toEqual({ ok: true });
    expect(mapAdaptResponse(200, { ok: false, code: "MOCK" })).toMatchObject({
      ok: false,
      code: "MOCK",
      message:
        "Adapting needs the live AI model, which is switched off here. You can still add the message to the calendar as it is.",
    });
    expect(mapAdaptResponse(200, { ok: false, code: "BUSY" })).toEqual({
      ok: false,
      code: "BUSY",
      message: "Already adapting in another tab.",
      busy: true,
    });
    expect(
      mapAdaptResponse(409, { ok: false, code: "WRONG_KIND" }),
    ).toMatchObject({ ok: false, code: "STALE" });
    expect(mapAdaptResponse(200, { ok: false, code: "FAILED" })).toMatchObject({
      ok: false,
      message: "Couldn't adapt the message. Try again.",
    });
    expect(mapAdaptResponse(500, null)).toMatchObject({
      ok: false,
      message: "Couldn't adapt the message. Try again.",
    });
    expect(mapAdaptResponse(200, { ok: false, code: "LIMIT" })).toMatchObject({
      ok: false,
      code: "LIMIT",
      message:
        "This message was already adapted three times. Add it to the calendar as it is.",
    });
    expect(mapAdaptResponse(429, { error: "Too many" })).toMatchObject({
      ok: false,
      message: "Couldn't adapt the message. Try again.",
    });
  });

  it("shows the budget notice itself instead of a retry-able failure", () => {
    expect(
      mapAdaptResponse(200, {
        ok: false,
        code: "BUDGET",
        message: "Today's AI budget is used up.",
      }),
    ).toEqual({
      ok: false,
      code: "BUDGET",
      message: "Today's AI budget is used up.",
    });
    // No sentence from the server: the generic one, never an empty message.
    expect(mapAdaptResponse(200, { ok: false, code: "BUDGET" })).toMatchObject({
      ok: false,
      code: "BUDGET",
      message: "Couldn't adapt the message. Try again.",
    });
  });
});

describe("mapScheduleMasterResult", () => {
  const fail = (
    code: Extract<ScheduleMasterResult, { ok: false }>["code"],
    extra: Partial<Extract<ScheduleMasterResult, { ok: false }>> = {},
  ): ScheduleMasterResult => ({ ok: false, code, message: "m", ...extra });

  it("maps ok, STALE with a fresh suggestion, BRAND_RULES, STATE, NO_TARGETS and WORK", () => {
    expect(
      mapScheduleMasterResult({
        ok: true,
        commandId: "c",
        slots: [
          {
            channel: "instagram",
            formatKey: "instagram.post",
            date: "2026-10-02",
            time: "11:00",
            creativeId: "cr1",
          },
        ],
      }),
    ).toEqual({
      kind: "ok",
      slots: [
        {
          channel: "instagram",
          formatKey: "instagram.post",
          creativeId: "cr1",
        },
      ],
    });
    expect(
      mapScheduleMasterResult(
        fail("STALE", {
          suggestion: {
            channel: "instagram",
            date: "2026-10-05",
            time: "09:00",
          },
        }),
      ),
    ).toEqual({
      kind: "stale",
      channel: "instagram",
      slot: { date: "2026-10-05", time: "09:00" },
      message: "m",
    });
    expect(mapScheduleMasterResult(fail("BRAND_RULES"))).toEqual({
      kind: "brand",
      message: "m",
    });
    expect(mapScheduleMasterResult(fail("STATE")).kind).toBe("refresh");
    expect(mapScheduleMasterResult(fail("NO_TARGETS"))).toEqual({
      kind: "error",
      message: "Tick at least one channel.",
    });
    expect(mapScheduleMasterResult(fail("WORK"))).toEqual({
      kind: "error",
      message: "This Work is completed. Reopen it to continue.",
    });
    expect(mapScheduleMasterResult(fail("FAILED"))).toEqual({
      kind: "error",
      message: "m",
    });
  });
});

describe("the commit call (consent and paid-image wiring)", () => {
  const shown = { date: "2026-10-02", time: "11:00" };

  it("sends the suggestion shown as the lead slot, and nothing else on a first press", () => {
    expect(
      scheduleOptionsOf({ shown, brandBlocked: false, withVisuals: false }),
    ).toEqual({ leadSlot: shown });
    expect(
      scheduleOptionsOf({
        shown: undefined,
        brandBlocked: false,
        withVisuals: false,
      }),
    ).toEqual({});
  });

  it("sends allowIssues only on the Add anyway press after a brand block", () => {
    expect(
      scheduleOptionsOf({ shown, brandBlocked: true, withVisuals: false }),
    ).toEqual({ leadSlot: shown, allowIssues: true });
    // Never together with visuals, never before the block.
    expect(
      scheduleOptionsOf({ shown, brandBlocked: true, withVisuals: true }),
    ).toEqual({ leadSlot: shown });
    expect(
      scheduleOptionsOf({ shown, brandBlocked: false, withVisuals: false }),
    ).not.toHaveProperty("allowIssues");
  });

  const slots = [
    { channel: "linkedin", formatKey: "linkedin.post", creativeId: "text-1" },
    { channel: "instagram", formatKey: "instagram.post", creativeId: "img-1" },
    { channel: "instagram", formatKey: "instagram.story", creativeId: "img-2" },
  ];

  it("plain Add to calendar never asks for paid visuals", () => {
    expect(
      visualsRequestOf({ withVisuals: false, commandId: "cmd1", slots }),
    ).toBeNull();
  });

  it("Add & make 3 visuals asks once, for the first image piece, as a first set", () => {
    expect(
      visualsRequestOf({ withVisuals: true, commandId: "cmd1", slots }),
    ).toEqual({ commandId: "cmd1", creativeId: "img-1", more: false });
    expect(
      visualsRequestOf({
        withVisuals: true,
        commandId: "cmd1",
        slots: [slots[0]!],
      }),
    ).toBeNull();
  });
});
