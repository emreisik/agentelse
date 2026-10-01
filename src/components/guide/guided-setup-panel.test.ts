import { readFileSync } from "node:fs";
import path from "node:path";

import {
  createElement,
  createRef,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Drawer } from "@/components/ui/drawer";
import {
  EMPTY_IDEA_OPTIONS,
  POLL,
  type GuidedSetupHost,
  type GuidedSetupView,
  type IdeaOptions,
  type IdeasView,
} from "@/lib/guided-setup/contract";
import {
  guidedSetupReducer,
  headerViewOf,
  initialModel,
  panelViewOf,
  type Action,
  type Model,
  type PanelView,
} from "./guided-setup-state";
import {
  FOCUS_ATTR,
  GUIDED_SETUP_IDS,
  GuidedSetupHeader,
  GuidedSetupPanel,
  otherEnterAction,
  type GuidedSetupHeaderProps,
  type GuidedSetupPanelProps,
  type PanelHandlers,
} from "./guided-setup-panel";

// -----------------------------------------------------------------------------
// Fixtures: real models from the real reducer, so the panel is tested against
// the views the shell will actually hand it.
// -----------------------------------------------------------------------------

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

const init = (over: Partial<GuidedSetupHost> = {}): Model =>
  initialModel({
    projectId: "p1",
    brandName: "Qr Hub Menu",
    languageCode: "en",
    host: host(over),
    canDraftPlan: true,
  });

const opt = (id: string, label: string) => ({ id, label, ai: true as const });

const ideasView = (over: Partial<IdeasView> = {}): IdeasView => ({
  status: "IDLE",
  source: "none",
  attempts: 0,
  canStart: true,
  canRetry: false,
  options: EMPTY_IDEA_OPTIONS,
  ...over,
});

const READY_OPTIONS: IdeaOptions = {
  business: [opt("o_aaaaaaaaaa", "A QR menu for cafes")],
  audience: [
    opt("o_bbbbbbbbbb", "Cafe owners"),
    opt("o_dddddddddd", "Hotel managers"),
  ],
  angle: [opt("o_cccccccccc", "Ready in minutes")],
};
const READY = ideasView({
  status: "READY",
  source: "discovery",
  host: "qrhubmenu.com",
  canStart: false,
  options: READY_OPTIONS,
});
const RUNNING = ideasView({ status: "RUNNING", canStart: false, ageSec: 5 });

const view = (over: Partial<GuidedSetupView> = {}): GuidedSetupView => ({
  rev: "rev001",
  status: "OPEN",
  step: null,
  more: false,
  answers: {},
  brand: { name: "Qr Hub Menu", host: "qrhubmenu.com", languageCode: "en" },
  current: {},
  seedFirst: false,
  staticFirst: false,
  hasProfile: false,
  projectActive: true,
  goalMode: "proposed",
  handsOn: "AUTOPILOT",
  channels: [],
  ideas: ideasView(),
  ...over,
});

const run = (model: Model, ...actions: Action[]): Model =>
  actions.reduce(guidedSetupReducer, model);

const hydrated = (over: Partial<GuidedSetupView> = {}): Model =>
  run(init(), { type: "hydrated", view: view(over) });

const pick = (id: string): Action => ({ type: "pick", id });
const next: Action = { type: "next" };
const skip: Action = { type: "skip" };

// -----------------------------------------------------------------------------
// Rendering: everything goes through a `<Drawer open>` root (DrawerTitle,
// DrawerDescription and DrawerClose throw outside one).
// -----------------------------------------------------------------------------

type Spies = { [K in keyof PanelHandlers]-?: ReturnType<typeof vi.fn> };

const makeSpies = (): Spies => ({
  onPick: vi.fn(),
  onToggleOther: vi.fn(),
  onOtherText: vi.fn(),
  onTier: vi.fn(),
  onContinue: vi.fn(),
  onBack: vi.fn(),
  onSkip: vi.fn(),
  onGoTo: vi.fn(),
  onConfirmYes: vi.fn(),
  onConfirmNo: vi.fn(),
  onAddDetail: vi.fn(),
  onReviewNow: vi.fn(),
  onShowSuggestions: vi.fn(),
  onLook: vi.fn(),
  onRetryIdeas: vi.fn(),
  onApprove: vi.fn(),
  onRetrySave: vi.fn(),
  onReload: vi.fn(),
  onRetryBoot: vi.fn(),
  onClose: vi.fn(),
  onEditSetup: vi.fn(),
  onDraftPlan: vi.fn(),
});

function panelProps(
  panel: PanelView,
  over: Partial<GuidedSetupPanelProps> = {},
  spies: Spies = makeSpies(),
  languageCode = "en",
): GuidedSetupPanelProps {
  return {
    ...panel,
    ...spies,
    titleRef: createRef<HTMLHeadingElement>(),
    brandName: "Qr Hub Menu",
    languageCode,
    ...over,
  } as GuidedSetupPanelProps;
}

// React escapes apostrophes in text; tests read the copy as written.
const plain = (html: string): string => html.replaceAll("&#x27;", "'");

const renderPanel = (props: GuidedSetupPanelProps): string =>
  plain(
    renderToStaticMarkup(
      createElement(
        Drawer,
        { open: true },
        createElement(GuidedSetupPanel, props),
      ),
    ),
  );

function headerProps(
  model: Model,
  over: Partial<GuidedSetupHeaderProps> = {},
): GuidedSetupHeaderProps {
  return {
    ...headerViewOf(model),
    brandName: model.brand.name,
    languageCode: model.brand.languageCode,
    onGetIdeas: vi.fn(),
    onRetryIdeas: vi.fn(),
    ...over,
  };
}

const renderHeader = (props: GuidedSetupHeaderProps): string =>
  plain(
    renderToStaticMarkup(
      createElement(
        Drawer,
        { open: true },
        createElement(GuidedSetupHeader, props),
      ),
    ),
  );

// The sheet the shell mounts: header + panel in one Drawer root.
function renderSheet(
  model: Model,
  over: Partial<GuidedSetupPanelProps> = {},
  spies?: Spies,
): string {
  return plain(
    renderToStaticMarkup(
      createElement(
        Drawer,
        { open: true },
        createElement(GuidedSetupHeader, headerProps(model)),
        createElement(
          GuidedSetupPanel,
          panelProps(panelViewOf(model), over, spies, model.brand.languageCode),
        ),
      ),
    ),
  );
}

// Static markup cannot click. This expands the element tree (calling function
// components, which use no hooks here) so a test can read the props of the
// element the handler is wired to and call it.
type El = ReactElement<Record<string, unknown>>;
function collect(node: ReactNode, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const el = node as El;
  out.push(el);
  const { type, props } = el;
  if (typeof type === "function") {
    try {
      collect((type as (p: unknown) => ReactNode)(props), out);
      return out;
    } catch {
      // A component that needs a render context: read its children instead.
    }
  }
  collect(props.children as ReactNode, out);
  return out;
}

const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean")
    return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) {
    return textOf((node.props as { children?: ReactNode }).children);
  }
  return "";
};

function elements(props: GuidedSetupPanelProps): El[] {
  return collect(createElement(GuidedSetupPanel, props));
}

function byText(list: El[], text: string): El {
  const hit = list.find(
    (el) =>
      typeof el.props.onClick === "function" &&
      textOf(el.props.children as ReactNode).trim() === text,
  );
  if (!hit) throw new Error(`no clickable element with text "${text}"`);
  return hit;
}

// The attributes (class removed: Tailwind variants like `disabled:` are not
// attributes) of the button whose text is `label`.
function buttonAttrs(html: string, label: string): string {
  const re = /<button\b([^>]*)>((?:(?!<\/button>)[\s\S])*)<\/button>/g;
  for (const m of html.matchAll(re)) {
    const attrs = m[1] ?? "";
    const text = (m[2] ?? "").replace(/<[^>]*>/g, "").trim();
    if (text === label) return attrs.replace(/\sclass="[^"]*"/, "");
  }
  throw new Error(`no button labelled "${label}"`);
}

const click = (el: El) => (el.props.onClick as () => void)();
const count = (html: string, needle: string | RegExp): number =>
  html.split(needle).length - 1;
const matches = (html: string, re: RegExp): number =>
  (html.match(re) ?? []).length;

// Models used across tests.
const goalStep = () => hydrated();
const businessList = () => run(hydrated(), skip, skip);
const confirmStep = () => run(hydrated({ ideas: READY }), skip, skip);
const audienceIdeas = () => run(hydrated({ ideas: READY }), skip, skip, skip);
const pendingBusiness = () => run(hydrated({ ideas: RUNNING }), skip, skip);
const toneStep = () => run(hydrated(), skip, skip, skip, skip);
const checkpoint = () =>
  run(hydrated(), pick("goal.sales"), next, skip, skip, skip, skip);
const reviewOf = (m: Model) => run(m, { type: "goTo", step: "review" });

// -----------------------------------------------------------------------------
// G84: the Drawer-root helper, ids that resolve
// -----------------------------------------------------------------------------

describe("Drawer root (G84)", () => {
  it("the Drawer parts throw outside a root, which is why every test goes through the helper", () => {
    const props = panelProps(panelViewOf(goalStep()));
    expect(() =>
      renderToStaticMarkup(createElement(GuidedSetupPanel, props)),
    ).toThrow();
    expect(() =>
      renderToStaticMarkup(
        createElement(GuidedSetupHeader, headerProps(goalStep())),
      ),
    ).toThrow();
    expect(renderPanel(props)).toContain("What matters most right now?");
  });

  it("the scroll body keeps one bottom padding for every view: the dialog is centered, nothing sits under a bottom edge", () => {
    const views: PanelView[] = [
      { kind: "boot" },
      { kind: "bootError" },
      { kind: "unavailable" },
      { kind: "expired", href: "/login?callbackUrl=%2Fprojects%2Fp1" },
      {
        kind: "done",
        summary: { saved: ["Brand profile"], canDraftPlan: false },
      },
      panelViewOf(goalStep()),
      panelViewOf(checkpoint()),
      { kind: "applying", stalled: false },
    ];
    for (const v of views) {
      const body = renderPanel(panelProps(v)).match(
        /<div[^>]*data-slot="drawer-body"[^>]*>/,
      )?.[0];
      expect(body, v.kind).toBeDefined();
      expect(body, v.kind).toContain("pb-4");
      expect(body, v.kind).not.toContain("var(--bleed)");
      expect(body, v.kind).not.toContain("safe-area-inset-bottom");
    }
  });

  it("every view renders the ids the shell wires into aria-labelledby and aria-describedby", () => {
    const views: PanelView[] = [
      { kind: "boot" },
      { kind: "bootError" },
      { kind: "unavailable" },
      { kind: "expired", href: "/login?callbackUrl=%2Fprojects%2Fp1" },
      panelViewOf(goalStep()),
      panelViewOf(confirmStep()),
      panelViewOf(checkpoint()),
      panelViewOf(reviewOf(checkpoint())),
      { kind: "applying", stalled: false },
      {
        kind: "done",
        summary: { saved: ["Brand profile"], canDraftPlan: false },
      },
    ];
    for (const v of views) {
      const html = renderPanel(panelProps(v));
      expect(html, v.kind).toContain(`id="${GUIDED_SETUP_IDS.title}"`);
      expect(html, v.kind).toContain(`id="${GUIDED_SETUP_IDS.help}"`);
      // The title is the focus target: an h2 with tabIndex -1.
      expect(html, v.kind).toMatch(
        new RegExp(`<h2[^>]*id="${GUIDED_SETUP_IDS.title}"[^>]*>`),
      );
      const h2 = html.match(/<h2[^>]*>/)?.[0] ?? "";
      expect(h2, v.kind).toContain('tabindex="-1"');
    }
    const header = renderHeader(headerProps(goalStep()));
    expect(header).toContain(`id="${GUIDED_SETUP_IDS.header}"`);
    expect(header).toContain("Set up Qr Hub Menu");
  });

  it("the option group is labelled by the question title id", () => {
    const html = renderPanel(panelProps(panelViewOf(goalStep())));
    expect(html).toContain(
      `role="group" aria-labelledby="${GUIDED_SETUP_IDS.title}"`,
    );
  });

  it("forwards titleRef to the title element", () => {
    const ref = createRef<HTMLHeadingElement>();
    const list = elements(
      panelProps(panelViewOf(goalStep()), { titleRef: ref }),
    );
    const title = list.find((el) => el.props.id === GUIDED_SETUP_IDS.title);
    expect(
      title?.props.ref ?? (title as unknown as { ref?: unknown })?.ref,
    ).toBe(ref);
  });
});

// -----------------------------------------------------------------------------
// G40: accessibility and rendering rules
// -----------------------------------------------------------------------------

describe("question rows (G40)", () => {
  it("nothing is pressed and there is no check icon initially", () => {
    const html = renderPanel(panelProps(panelViewOf(goalStep())));
    expect(html).not.toContain('aria-pressed="true"');
    expect(count(html, 'aria-pressed="false"')).toBe(5);
    expect(html).not.toContain("lucide-check");
  });

  it("a picked row is aria-pressed with a Check icon, the others are not", () => {
    const html = renderPanel(
      panelProps(panelViewOf(run(goalStep(), pick("goal.sales")))),
    );
    expect(count(html, 'aria-pressed="true"')).toBe(1);
    expect(count(html, 'aria-pressed="false"')).toBe(4);
    expect(count(html, "lucide-check")).toBe(1);
    const pressed = html.match(
      /<button[^>]*aria-pressed="true"[^>]*>[\s\S]*?<\/button>/,
    );
    expect(pressed?.[0]).toContain("Sales");
    expect(pressed?.[0]).toContain("lucide-check");
  });

  it("rows are at least 48px, wrap long labels and never truncate; buttons are min-h-11, never a fixed h-11", () => {
    const long = "x".repeat(160);
    const model = run(
      hydrated({
        ideas: {
          ...READY,
          options: { ...READY_OPTIONS, audience: [opt("o_eeeeeeeeee", long)] },
        },
      }),
      skip,
      skip,
      skip,
    );
    const html = renderPanel(panelProps(panelViewOf(model)));
    expect(html).toContain(long);
    // The option row itself (not the Other row): the long label sits in it.
    const rowTag = [
      ...html.matchAll(
        /<button\b([^>]*)>((?:(?!<\/button>)[\s\S])*)<\/button>/g,
      ),
    ].find((m) => (m[2] ?? "").includes(long));
    const rowClass = rowTag?.[1] ?? "";
    expect(rowClass).toContain("min-h-12");
    expect(rowClass).toContain("whitespace-normal");
    expect(rowClass).toContain("break-words");
    expect(html).toContain("min-h-11");
    expect(html).not.toMatch(/(^|[\s"])h-11([\s"])/);
    expect(html).not.toContain("truncate");
    expect(html).not.toContain("line-clamp");
    expect(html).not.toContain("text-ellipsis");
  });

  it("hints use --ws-text-2 and the panel never uses the failing --ws-text-3", () => {
    const html = renderPanel(panelProps(panelViewOf(goalStep())));
    expect(html).toContain("Be seen by more of the right people");
    expect(html).toContain("--ws-text-2");
    expect(html).not.toContain("--ws-text-3");
  });

  it("AI text carries lang and dir=auto, static text does not", () => {
    const ai = renderPanel(
      panelProps(panelViewOf(audienceIdeas()), {}, makeSpies(), "tr"),
    );
    expect(ai).toContain('<span lang="tr" dir="auto">Cafe owners</span>');
    expect(ai).toContain("Suggested");
    const stat = renderPanel(panelProps(panelViewOf(goalStep())));
    expect(stat).not.toContain('dir="auto"');
    expect(stat).not.toContain("Suggested");
  });

  it("the focus ring and the step animation honour reduced motion", () => {
    const html = renderPanel(panelProps(panelViewOf(goalStep())));
    expect(html).toContain("focus-visible:ring-2");
    expect(html).toContain("focus-visible:ring-[var(--ws-accent)]");
    expect(html).toContain("motion-reduce:animate-none");
    expect(html).toContain("slide-in-from-right-3");
    const back = renderPanel(
      panelProps(panelViewOf(goalStep()), { direction: -1 }),
    );
    expect(back).toContain("slide-in-from-left-3");
  });

  it("the body and the footer are swipe-ignore regions", () => {
    const html = renderPanel(panelProps(panelViewOf(goalStep())));
    expect(count(html, "data-base-ui-swipe-ignore")).toBe(2);
    expect(html).toContain("shrink-0 border-t px-5 pt-3 pb-3");
    expect(html).not.toContain("var(--bleed)");
  });

  it("step 1 shows no content of later steps", () => {
    const html = renderSheet(goalStep());
    expect(html).toContain("What matters most right now?");
    for (const later of [
      "Where should we show up?",
      "Who do you want to reach?",
      "How should Qr Hub Menu sound?",
      "That's enough to get started.",
      "Here is your setup",
      "Approve and start",
    ]) {
      expect(html).not.toContain(later);
    }
  });

  it("multi-select shows 'n of max picked', a max hint and disabled unpicked rows at the maximum", () => {
    const one = run(run(hydrated(), skip), pick("channel.instagram"));
    const html1 = renderPanel(panelProps(panelViewOf(one)));
    expect(html1).toContain("1 of 3 picked");
    expect(html1).not.toContain("You can pick up to 3");
    expect(html1).not.toContain("aria-disabled");

    const full = run(one, pick("channel.linkedin"), pick("channel.tiktok"));
    const spies = makeSpies();
    const props = panelProps(panelViewOf(full), {}, spies);
    const html = renderPanel(props);
    expect(html).toContain("3 of 3 picked · You can pick up to 3");
    expect(count(html, 'aria-disabled="true"')).toBe(3);
    // A disabled row never calls onPick; a picked row still does (to untick).
    const list = elements(props);
    const rows = list.filter(
      (el) => el.type === "button" && "aria-pressed" in el.props,
    );
    const disabled = rows.find((el) => el.props["aria-disabled"] === true);
    expect(disabled?.props.onClick).toBeUndefined();
    const picked = rows.find((el) => el.props["aria-pressed"] === true);
    (picked?.props.onClick as () => void)();
    expect(spies.onPick).toHaveBeenCalledTimes(1);
  });

  it("clicking an enabled row calls onPick with its id", () => {
    const spies = makeSpies();
    const list = elements(panelProps(panelViewOf(goalStep()), {}, spies));
    const row = list.find(
      (el) =>
        el.type === "button" &&
        textOf(el.props.children as ReactNode).includes("Sales"),
    );
    (row?.props.onClick as () => void)();
    expect(spies.onPick).toHaveBeenCalledWith("goal.sales");
  });

  it("a stored profile sentence is AI text: lang and dir on the Current line", () => {
    const model = run(
      hydrated({ current: { identity: "Bir kafe" } }),
      skip,
      skip,
    );
    const html = renderPanel(
      panelProps(panelViewOf(model), {}, makeSpies(), "tr"),
    );
    expect(html).toContain('Current: <span lang="tr" dir="auto">Bir kafe</span>');
  });

  it("the current profile value shows under the question, never pre-selected", () => {
    const model = hydrated({ current: { goal: "Sales" } });
    const html = renderPanel(panelProps(panelViewOf(model)));
    expect(html).toContain("Current goal:");
    expect(html).not.toContain('aria-pressed="true"');
  });
});

describe("no external links (G40)", () => {
  it("no element in any view links to an http(s) address", () => {
    const models = [
      goalStep(),
      confirmStep(),
      audienceIdeas(),
      checkpoint(),
      reviewOf(checkpoint()),
    ];
    const htmls = models.map((m) => renderSheet(m));
    htmls.push(
      renderPanel(
        panelProps({ kind: "expired", href: "/login?callbackUrl=%2Fp" }),
      ),
      renderPanel(
        panelProps(
          {
            kind: "done",
            summary: {
              saved: [],
              unconnected: ["instagram"],
              canDraftPlan: true,
            },
          },
          { connectHref: "/projects/p1/integrations" },
        ),
      ),
    );
    for (const html of htmls) {
      expect(html).not.toMatch(/href="https?:/i);
      expect(html).not.toMatch(/href='https?:/i);
    }
  });
});

describe("live region and alerts (G40)", () => {
  it("exactly one role=status, and it is in the header", () => {
    const model = goalStep();
    const header = renderHeader(headerProps(model));
    expect(count(header, 'role="status"')).toBe(1);
    expect(header).toContain("Question 1 of 5");
    const panelHtml = renderPanel(panelProps(panelViewOf(model)));
    expect(panelHtml).not.toContain('role="status"');
    for (const m of [
      confirmStep(),
      audienceIdeas(),
      checkpoint(),
      reviewOf(checkpoint()),
    ]) {
      expect(count(renderSheet(m), 'role="status"')).toBe(1);
    }
  });

  it("the status region carries announcementOf: the review and applying texts", () => {
    expect(renderHeader(headerProps(reviewOf(checkpoint())))).toContain(
      "Review",
    );
    const applying = run(checkpoint(), { type: "applyStarted" });
    expect(renderHeader(headerProps(applying))).toContain("Saving your setup.");
  });

  it("every error state is a role=alert", () => {
    const states: PanelView[] = [
      { kind: "bootError" },
      { kind: "unavailable" },
      { kind: "expired", href: "/login" },
    ];
    for (const s of states) {
      expect(renderPanel(panelProps(s)), s.kind).toContain('role="alert"');
    }
    const cases: [string, Model, string][] = [
      [
        "saveFailed",
        run(goalStep(), pick("goal.sales"), { type: "saveFailed" }),
        "Couldn't save your answers. Check your connection, then try again.",
      ],
    ];
    for (const [, m, text] of cases) {
      const html = renderSheet(m);
      expect(html).toContain('role="alert"');
      expect(html).toContain(text);
    }
  });

  it("skeleton rows are aria-hidden, reduced-motion safe, in an aria-busy group", () => {
    const html = renderPanel(panelProps(panelViewOf(pendingBusiness())));
    expect(html).toContain('aria-busy="true"');
    expect(count(html, 'data-slot="skeleton"')).toBe(3);
    expect(count(html, "motion-reduce:animate-none")).toBeGreaterThanOrEqual(4);
    expect(
      matches(html, /<div[^>]*data-slot="skeleton"[^>]*aria-hidden="true"/g),
    ).toBe(3);
    // Usable while pending: Other and "Skip for now".
    expect(html).toContain("Skip for now");
    expect(html).toContain("Something else…");
    const boot = renderPanel(panelProps({ kind: "boot" }));
    expect(boot).toContain('aria-busy="true"');
    expect(boot).toContain("Getting your setup ready");
    expect(boot).toContain("motion-reduce:animate-none");
  });
});

// -----------------------------------------------------------------------------
// Header
// -----------------------------------------------------------------------------

describe("header", () => {
  it("has the brand title (the only truncating text), one Close control and aria-hidden segments", () => {
    const html = renderHeader(headerProps(goalStep()));
    expect(html).toContain("Set up Qr Hub Menu");
    expect(count(html, "truncate")).toBe(1);
    expect(html).toContain('aria-label="Close and continue later"');
    expect(html).toContain('data-slot="drawer-close"');
    expect(count(html, 'data-slot="drawer-close"')).toBe(1);
    expect(html).toContain("min-h-11");
    // The progress segments are decoration: five main ones.
    const bar = html.match(
      /<div aria-hidden="true" class="mt-3 flex[^"]*">([\s\S]*?)<\/div>/,
    );
    expect(bar).not.toBeNull();
    expect(count(bar?.[1] ?? "", "<span")).toBe(5);
  });

  it("shows the second, detail group only after 'Add more detail'", () => {
    const atCheckpoint = run(
      hydrated({ ideas: READY }),
      pick("goal.sales"),
      next,
      pick("channel.instagram"),
      next,
      { type: "confirmYes" },
      pick("o_bbbbbbbbbb"),
      next,
      pick("tone.friendly"),
      next,
    );
    expect(atCheckpoint.step).toBe("checkpoint");
    const segments = (m: Model) => {
      const html = renderHeader(headerProps(m));
      const bar = html.match(
        /<div aria-hidden="true" class="mt-3 flex[^"]*">([\s\S]*?)<\/div>/,
      );
      return count(bar?.[1] ?? "", "<span");
    };
    expect(segments(atCheckpoint)).toBe(5);
    // 5 main + a gap + 2 detail segments.
    expect(segments(run(atCheckpoint, { type: "addDetail" }))).toBe(8);
  });
});

// -----------------------------------------------------------------------------
// G80: the ideas line and the strips
// -----------------------------------------------------------------------------

describe("ideas line (G80)", () => {
  const line = (over: Partial<GuidedSetupView> = {}) =>
    renderHeader(headerProps(hydrated(over)));

  it("offer: title with the host, the disclosure, the button", () => {
    const spies = vi.fn();
    const html = renderHeader(
      headerProps(hydrated({ ideas: ideasView() }), { onGetIdeas: spies }),
    );
    expect(html).toContain("Ideas from qrhubmenu.com and the web");
    expect(html).toContain(
      "About a minute, uses a little AI credit. It saves a first draft of your brand profile from what it finds; you can change it.",
    );
    expect(html).toContain("Get ideas");
    expect(html).toContain(`${FOCUS_ATTR}="strip"`);
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("min-h-[4.75rem]");
  });

  it("offer without a website says so, and quotes the seed as AI-language text", () => {
    const model = hydrated({
      brand: { name: "Qr Hub Menu", host: null, languageCode: "tr" },
      seed: "menu for cafes",
      ideas: ideasView(),
    });
    const html = renderHeader(headerProps(model));
    expect(html).toContain("Ideas from the web");
    expect(html).not.toContain("Ideas from qrhubmenu.com");
    expect(html).toContain("Ideas from the web are limited without a website.");
    expect(html).toContain('<span lang="tr" dir="auto">menu for cafes</span>');
  });

  it("the Get ideas and Try again buttons call their handlers", () => {
    const get = vi.fn();
    const retry = vi.fn();
    const offer = collect(
      createElement(
        GuidedSetupHeader,
        headerProps(hydrated({ ideas: ideasView() }), { onGetIdeas: get }),
      ),
    );
    click(byText(offer, "Get ideas"));
    expect(get).toHaveBeenCalledTimes(1);
    const failed = collect(
      createElement(
        GuidedSetupHeader,
        headerProps(
          hydrated({
            ideas: ideasView({
              status: "FAILED",
              reason: "failed",
              canRetry: true,
            }),
          }),
          { onRetryIdeas: retry },
        ),
      ),
    );
    click(byText(failed, "Try again"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("retry: the failure line and Try again", () => {
    const html = line({
      ideas: ideasView({ status: "FAILED", reason: "failed", canRetry: true }),
    });
    expect(html).toContain("We couldn't gather ideas this time.");
    expect(html).toContain("Try again");
  });

  it("running: the host line, and the slow line only after POLL.slowAfterSec", () => {
    const fast = line({
      ideas: ideasView({ status: "RUNNING", canStart: false, ageSec: 5 }),
    });
    expect(fast).toContain("Reading qrhubmenu.com and searching the web…");
    expect(fast).not.toContain("Still working.");
    expect(fast).not.toContain("Get ideas");
    const slow = line({
      ideas: ideasView({
        status: "RUNNING",
        canStart: false,
        ageSec: POLL.slowAfterSec,
      }),
    });
    expect(slow).toContain(
      "Still working. You can keep answering, ideas will appear here.",
    );
  });

  it("running without a known host says 'Searching the web…'", () => {
    const html = line({
      brand: { name: "Qr Hub Menu", host: null, languageCode: "en" },
      ideas: ideasView({ status: "RUNNING", canStart: false, ageSec: 1 }),
    });
    expect(html).toContain("Searching the web…");
    expect(html).not.toContain("Reading");
  });

  it("ready: source words, and the honest empty run", () => {
    expect(line({ ideas: READY })).toContain("From qrhubmenu.com and the web");
    expect(line({ ideas: { ...READY, source: "profile" } })).toContain(
      "From your brand profile",
    );
    const empty = line({ ideas: { ...READY, options: EMPTY_IDEA_OPTIONS } });
    expect(empty).toContain("No specific suggestions found for Qr Hub Menu.");
    expect(empty).not.toContain("From qrhubmenu.com");
    expect(empty).not.toContain("Get ideas");
  });

  it("notes: no input, busy, limit, exhausted, mock, with nothing to press", () => {
    const cases: [Partial<IdeasView>, string][] = [
      [
        { status: "UNAVAILABLE", reason: "no_input", canStart: false },
        "Answer the first question and we can look for ideas.",
      ],
      [
        { status: "UNAVAILABLE", reason: "busy", canStart: false },
        "A scan of this brand just ran. Try again in a few minutes.",
      ],
      [
        { status: "UNAVAILABLE", reason: "limit", canStart: false },
        "Ideas are paused for today. Answer with the options below.",
      ],
      [
        { status: "FAILED", reason: "failed", canRetry: false },
        "Ideas aren't available for this brand right now. Answer with the options below.",
      ],
      [
        { status: "UNAVAILABLE", reason: "mock", canStart: false },
        "Suggestions from the web aren't available right now.",
      ],
    ];
    for (const [over, text] of cases) {
      const html = line({ ideas: ideasView(over) });
      expect(html).toContain(text);
      expect(html).not.toContain("Get ideas");
      expect(html).not.toContain(">Try again<");
    }
  });

  it("reason off renders no slot at all", () => {
    const html = line({
      ideas: ideasView({
        status: "UNAVAILABLE",
        reason: "off",
        canStart: false,
      }),
    });
    expect(html).not.toContain(`${FOCUS_ATTR}="strip"`);
    expect(html).not.toContain("Get ideas");
    expect(html).toContain("Set up Qr Hub Menu");
  });

  it("the ready strip shows only on a list frozen to the ideas", () => {
    const frozen = renderPanel(panelProps(panelViewOf(audienceIdeas())));
    expect(frozen).toContain("From qrhubmenu.com and the web");
    const staticFrozen = run(
      hydrated({ ideas: ideasView() }),
      skip,
      skip,
      skip,
      { type: "ideasUpdated", ideas: READY, from: "poll" },
    );
    const html = renderPanel(panelProps(panelViewOf(staticFrozen)));
    expect(html).not.toContain("From qrhubmenu.com and the web");
    // The catalog list keeps its rows and offers the switch instead.
    expect(html).toContain("Suggestions are ready");
    expect(html).toContain("Show");
    expect(html).toContain("Online shoppers");
  });

  it("a ready run that left a question empty says so once, with the catalog list", () => {
    const ideas: IdeasView = {
      ...READY,
      options: {
        business: [opt("o_aaaaaaaaaa", "A QR menu")],
        audience: [],
        angle: [],
      },
    };
    const html = renderPanel(
      panelProps(panelViewOf(run(hydrated({ ideas }), skip, skip, skip))),
    );
    expect(html).toContain(
      "We didn't find anything specific for Qr Hub Menu. Pick from the options below.",
    );
    expect(html).toContain("Online shoppers");
  });

  it("the Show banner button calls onShowSuggestions", () => {
    const staticFrozen = run(
      hydrated({ ideas: ideasView() }),
      skip,
      skip,
      skip,
      { type: "ideasUpdated", ideas: READY, from: "poll" },
    );
    const spies = makeSpies();
    click(
      byText(
        elements(panelProps(panelViewOf(staticFrozen), {}, spies)),
        "Show",
      ),
    );
    expect(spies.onShowSuggestions).toHaveBeenCalledTimes(1);
  });

  it("the checkpoint offers Look for a question answered from the catalog while ideas landed", () => {
    const model = run(
      hydrated({ ideas: ideasView() }),
      pick("goal.sales"),
      next,
      skip,
      pick("kind.food"),
      next,
      skip,
      skip,
      { type: "ideasUpdated", ideas: READY, from: "poll" },
    );
    expect(model.step).toBe("checkpoint");
    const spies = makeSpies();
    const props = panelProps(panelViewOf(model), {}, spies);
    const html = renderPanel(props);
    expect(html).toMatch(/Suggestions are ready for: What Qr Hub Menu does/);
    click(byText(elements(props), "Look"));
    expect(spies.onLook).toHaveBeenCalledTimes(1);
  });

  it("a catch-up step that is a list (audience) carries the note too", () => {
    const deferred = run(
      hydrated({ ideas: RUNNING }),
      pick("goal.sales"),
      next,
      pick("channel.instagram"),
      next,
      skip,
      skip,
      pick("tone.friendly"),
      { type: "ideasUpdated", ideas: READY, from: "poll" },
      next,
      { type: "confirmYes" },
    );
    expect(deferred.step).toBe("audience");
    expect(deferred.catchUp).toBe(true);
    const v = panelViewOf(deferred);
    expect(v.kind).toBe("question");
    expect(renderPanel(panelProps(v))).toContain("Suggestions are ready.");
    const ordinary = renderPanel(panelProps(panelViewOf(audienceIdeas())));
    expect(ordinary).not.toContain("Suggestions are ready.");
  });

  it("a catch-up step carries the one-line note and no number", () => {
    const deferred = run(
      hydrated({ ideas: RUNNING }),
      pick("goal.sales"),
      next,
      pick("channel.instagram"),
      next,
      skip,
      skip,
      pick("tone.friendly"),
      { type: "ideasUpdated", ideas: READY, from: "poll" },
      next,
    );
    expect(deferred.step).toBe("business");
    expect(deferred.catchUp).toBe(true);
    const v = panelViewOf(deferred);
    expect(v.kind).toBe("confirm");
    const html = renderPanel(panelProps(v));
    expect(html).toContain("Suggestions are ready.");
    // Header: the announcement has no "Question n of 5" for a catch-up.
    const header = renderHeader(headerProps(deferred));
    expect(header).toContain("Suggestions are ready.");
    expect(header).not.toContain("Question 3 of 5");
  });
});

// -----------------------------------------------------------------------------
// G81: business tiers, footer labels, Review states
// -----------------------------------------------------------------------------

describe("business question (G81)", () => {
  const rowButtons = (props: GuidedSetupPanelProps): El[] =>
    elements(props).filter(
      (el) =>
        el.type === "button" &&
        "aria-pressed" in el.props &&
        el.props[FOCUS_ATTR] !== "otherRow",
    );

  it("list mode shows six rows plus the tier row and Something else", () => {
    const props = panelProps(panelViewOf(businessList()));
    expect(rowButtons(props)).toHaveLength(6);
    const html = renderPanel(props);
    expect(html).toContain("What kind of business is Qr Hub Menu?");
    expect(html).toContain("More types");
    expect(html).toContain("Something else…");
    expect(html).toContain("Restaurant, cafe or bar");
    expect(html).not.toContain("Hotel, travel or events");
  });

  it("the tier row swaps to the second six and back", () => {
    const tier2 = run(businessList(), { type: "tier" });
    const props = panelProps(panelViewOf(tier2));
    expect(rowButtons(props)).toHaveLength(6);
    const html = renderPanel(props);
    expect(html).toContain("Hotel, travel or events");
    expect(html).toContain("Common types");
    expect(html).not.toContain("Restaurant, cafe or bar");
    const spies = makeSpies();
    click(
      byText(
        elements(panelProps(panelViewOf(businessList()), {}, spies)),
        "More types",
      ),
    );
    expect(spies.onTier).toHaveBeenCalledTimes(1);
  });

  it("confirm mode quotes the suggestion, marks Yes once picked, and wires its buttons", () => {
    const spies = makeSpies();
    const props = panelProps(panelViewOf(confirmStep()), {}, spies, "tr");
    const html = renderPanel(props);
    expect(html).toContain("Is this what Qr Hub Menu does?");
    expect(html).toContain(
      "We read qrhubmenu.com and the web. Correct anything that is off.",
    );
    expect(html).toContain(
      '<span lang="tr" dir="auto">“A QR menu for cafes”</span>',
    );
    expect(html).toContain("Suggested");
    expect(html).toContain("Yes, that's right");
    expect(html).toContain("Not quite");
    expect(html).not.toContain('aria-pressed="true"');
    // The footer has Back and Skip only.
    expect(html).not.toContain("Continue");
    const list = elements(props);
    click(byText(list, "Yes, that's right"));
    click(byText(list, "Not quite"));
    expect(spies.onConfirmYes).toHaveBeenCalledTimes(1);
    expect(spies.onConfirmNo).toHaveBeenCalledTimes(1);

    const answered = run(
      confirmStep(),
      { type: "confirmYes" },
      { type: "back" },
    );
    const back = renderPanel(panelProps(panelViewOf(answered)));
    expect(back).toContain('aria-pressed="true"');
    expect(back).toContain("lucide-check");
  });

  it("the footer Skip label: delegate questions, pending lists, edit mode; Back to review", () => {
    const skipLabel = (m: Model) => {
      const html = renderPanel(panelProps(panelViewOf(m)));
      return html;
    };
    expect(skipLabel(goalStep())).toContain(">Skip<");
    expect(skipLabel(audienceIdeas())).toContain("Not sure, you decide");
    expect(skipLabel(toneStep())).toContain("Not sure, you decide");
    expect(skipLabel(businessList())).not.toContain("Not sure, you decide");
    expect(skipLabel(pendingBusiness())).toContain("Skip for now");

    const edit = run(run(checkpoint(), { type: "goTo", step: "review" }), {
      type: "goTo",
      step: "goal",
    });
    const html = skipLabel(edit);
    expect(html).toContain("Clear answer");
    expect(html).toContain("Back to review");
  });

  it("Continue is off until answered and calls onContinue; Back and Skip call theirs", () => {
    const spies = makeSpies();
    const empty = panelProps(panelViewOf(run(goalStep(), skip)), {}, spies);
    expect(renderPanel(empty)).toMatch(
      /<button[^>]*disabled[^>]*>[^<]*(<svg|)?[^<]*Continue/,
    );
    const answered = panelProps(
      panelViewOf(run(run(goalStep(), skip), pick("channel.instagram"))),
      {},
      spies,
    );
    const list = elements(answered);
    click(byText(list, "Continue"));
    click(byText(list, "Back"));
    click(byText(list, "Skip"));
    expect(spies.onContinue).toHaveBeenCalledTimes(1);
    expect(spies.onBack).toHaveBeenCalledTimes(1);
    expect(spies.onSkip).toHaveBeenCalledTimes(1);
  });

  it("the first question has no Back", () => {
    const html = renderPanel(panelProps(panelViewOf(goalStep())));
    expect(html).not.toContain(">Back<");
  });
});

describe("Something else (G40)", () => {
  const withOther = () =>
    run(
      businessList(),
      { type: "toggleOther" },
      { type: "otherText", text: "A bakery" },
    );

  it("stays closed until asked, then reveals a 16px input with lang and the phone-keyboard attributes", () => {
    const closed = renderPanel(panelProps(panelViewOf(businessList())));
    expect(closed).not.toContain("<input");
    const html = renderPanel(
      panelProps(panelViewOf(withOther()), {}, makeSpies(), "tr"),
    );
    const input = html.match(/<input[^>]*>/)?.[0] ?? "";
    expect(input).toContain('lang="tr"');
    expect(input).toContain('autoComplete="off"');
    expect(input).toContain('autoCapitalize="sentences"');
    expect(input).toContain('spellCheck="true"');
    expect(input).toContain('enterKeyHint="done"');
    expect(input).toContain('maxLength="140"');
    expect(input).toContain(
      'aria-label="What kind of business is Qr Hub Menu?"',
    );
    expect(input).toContain('value="A bakery"');
    expect(input).toContain('placeholder="Describe it in a few words"');
    expect(input).toContain("any-pointer-coarse:text-base");
    expect(input).toContain(`${FOCUS_ATTR}="other"`);
    // The toggle row is pressed with a Check while open.
    expect(html).toMatch(
      /aria-pressed="true"[^>]*data-guided-focus="otherRow"|data-guided-focus="otherRow"[^>]*aria-pressed="true"/,
    );
  });

  it("guardrails call it 'Add your own rule…'", () => {
    const model = run(
      hydrated(),
      pick("goal.sales"),
      next,
      pick("channel.instagram"),
      next,
      pick("kind.food"),
      next,
      pick("audience.local"),
      next,
      pick("tone.friendly"),
      next,
      { type: "addDetail" },
    );
    expect(model.step).toBe("guardrails");
    const html = renderPanel(panelProps(panelViewOf(model)));
    expect(html).toContain("Add your own rule…");
    expect(html).not.toContain("Something else…");
    expect(html).toContain("Never state prices or discounts");
  });

  it("typing calls onOtherText, the toggle calls onToggleOther", () => {
    const spies = makeSpies();
    const list = elements(panelProps(panelViewOf(withOther()), {}, spies));
    const input = list.find((el) => el.type === "input");
    const onChange = input?.props.onChange as (e: {
      target: { value: string };
    }) => void;
    onChange({ target: { value: "A bakery and cafe" } });
    expect(spies.onOtherText).toHaveBeenCalledWith("A bakery and cafe");
    const toggle = list.find(
      (el) => el.type === "button" && el.props[FOCUS_ATTR] === "otherRow",
    );
    (toggle?.props.onClick as () => void)();
    expect(spies.onToggleOther).toHaveBeenCalledTimes(1);
  });

  it("Enter blurs on a coarse pointer and continues on a fine one only when the text is valid", () => {
    expect(otherEnterAction(true, true)).toBe("blur");
    expect(otherEnterAction(true, false)).toBe("blur");
    expect(otherEnterAction(false, true)).toBe("continue");
    expect(otherEnterAction(false, false)).toBe("none");
  });

  it("the Enter key handler runs the action for the pointer type", () => {
    const spies = makeSpies();
    const list = elements(panelProps(panelViewOf(withOther()), {}, spies));
    const input = list.find((el) => el.type === "input");
    const onKeyDown = input?.props.onKeyDown as (e: unknown) => void;
    const blur = vi.fn();
    const event = {
      key: "Enter",
      nativeEvent: { isComposing: false },
      preventDefault: vi.fn(),
      currentTarget: { blur },
    };
    const original = (globalThis as { window?: unknown }).window;
    try {
      (globalThis as { window?: unknown }).window = {
        matchMedia: () => ({ matches: false }),
      };
      onKeyDown(event);
      expect(spies.onContinue).toHaveBeenCalledTimes(1);
      expect(blur).not.toHaveBeenCalled();
      (globalThis as { window?: unknown }).window = {
        matchMedia: () => ({ matches: true }),
      };
      onKeyDown(event);
      expect(blur).toHaveBeenCalledTimes(1);
      expect(spies.onContinue).toHaveBeenCalledTimes(1);
      // Composition (IME) Enter does nothing.
      onKeyDown({ ...event, nativeEvent: { isComposing: true } });
      expect(blur).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as { window?: unknown }).window = original;
    }
  });

  it("at the maximum the Other row of a multi question is disabled", () => {
    const model = run(
      hydrated({ ideas: READY }),
      skip,
      skip,
      skip,
      pick("o_bbbbbbbbbb"),
      pick("o_dddddddddd"),
    );
    const html = renderPanel(panelProps(panelViewOf(model)));
    expect(html).toContain("2 of 2 picked · You can pick up to 2");
    expect(html).toMatch(
      /aria-disabled="true"[^>]*data-guided-focus="otherRow"|data-guided-focus="otherRow"[^>]*aria-disabled="true"/,
    );
  });
});

// -----------------------------------------------------------------------------
// Checkpoint
// -----------------------------------------------------------------------------

describe("checkpoint", () => {
  it("shows the answers as chips and the two actions with their subtext", () => {
    const spies = makeSpies();
    const props = panelProps(panelViewOf(checkpoint()), {}, spies);
    const html = renderPanel(props);
    expect(html).toContain("That's enough to get started.");
    expect(html).toContain(
      "Add more detail for better first results, or review and start now.",
    );
    expect(html).toContain("Sales");
    expect(html).toContain("Review and start");
    expect(html).toContain("Add more detail");
    expect(html).toContain("1 more question, about 30 seconds");
    const list = elements(props);
    click(byText(list, "Review and start"));
    click(byText(list, "Add more detail1 more question, about 30 seconds"));
    expect(spies.onReviewNow).toHaveBeenCalledTimes(1);
    expect(spies.onAddDetail).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// G59 + G78: Review, Approve
// -----------------------------------------------------------------------------

describe("Review (G59)", () => {
  it("both copy variants of the help line, and the old false promise is gone", () => {
    const brief = renderPanel(panelProps(panelViewOf(reviewOf(checkpoint()))));
    expect(brief).toContain("Your answers are saved when you approve.");
    expect(brief).not.toContain(
      "The draft profile from the web is already saved",
    );

    const discovery = run(
      hydrated({ ideas: READY, answers: { goal: { picked: ["goal.sales"] } } }),
      { type: "goTo", step: "review" },
    );
    const html = renderPanel(panelProps(panelViewOf(discovery)));
    expect(html).toContain("Your answers are saved when you approve.");
    expect(html).toContain(
      "The draft profile from the web is already saved; your answers replace the matching parts.",
    );

    // Not a single view says the old sentence.
    const all = [
      renderSheet(goalStep()),
      renderSheet(checkpoint()),
      renderSheet(reviewOf(checkpoint())),
      renderPanel(panelProps(panelViewOf(discovery))),
      renderPanel(panelProps({ kind: "applying", stalled: true })),
      renderPanel(
        panelProps({
          kind: "done",
          summary: { saved: [], canDraftPlan: false },
        }),
      ),
    ].join("\n");
    expect(all).not.toContain("Nothing is saved until you approve");
  });

  it("lists every question with its state, an Edit button per row and the plan lines", () => {
    const model = run(
      hydrated({ current: { audiences: ["Bakers"] }, handsOn: "AUTOPILOT" }),
      pick("goal.sales"),
      next,
      skip, // channels: skipped
      skip, // business
      skip, // audience: delegated
      skip, // tone: delegated
      { type: "reviewNow" },
    );
    const spies = makeSpies();
    const props = panelProps(panelViewOf(model), {}, spies);
    const html = renderPanel(props);
    expect(html).toContain("Here is your setup");
    expect(html).toContain("Goal");
    expect(html).toContain("Sales");
    expect(html).toContain("Skipped");
    expect(html).toContain("You decide");
    expect(html).toContain('aria-label="Edit: What matters most right now?"');
    expect(html).toContain(
      'aria-label="Edit: What kind of business is Qr Hub Menu?"',
    );
    expect(html).toContain("What approving does");
    expect(html).toContain(
      "Hands-on level: Autopilot (creates, plans and publishes automatically within your limits). Change it in Settings.",
    );
    expect(html).toContain(
      "Approving itself publishes nothing, connects no account and spends nothing.",
    );
    click(
      elements(props).find(
        (el) => el.props["aria-label"] === "Edit: What matters most right now?",
      ) as El,
    );
    expect(spies.onGoTo).toHaveBeenCalledWith("goal");
  });

  it("shows 'Current: value' for an unanswered question the profile holds, as AI text", () => {
    const model = run(hydrated({ current: { audiences: ["Bakers"] } }), {
      type: "goTo",
      step: "review",
    });
    const html = renderPanel(
      panelProps(panelViewOf(model), {}, makeSpies(), "tr"),
    );
    expect(html).toContain('Current: <span lang="tr" dir="auto">Bakers</span>');
  });

  it("AI chips keep their lang", () => {
    const model = run(
      hydrated({ ideas: READY }),
      skip,
      skip,
      { type: "confirmYes" },
      { type: "goTo", step: "review" },
    );
    const html = renderPanel(
      panelProps(panelViewOf(model), {}, makeSpies(), "tr"),
    );
    expect(html).toContain(
      '<span lang="tr" dir="auto">A QR menu for cafes</span>',
    );
  });

  it("all skipped: the one-line explanation and a disabled Approve with its hint", () => {
    const model = run(hydrated(), skip, skip, skip, skip, skip);
    expect(model.step).toBe("review");
    const html = renderPanel(panelProps(panelViewOf(model)));
    expect(html).toContain(
      "You skipped everything. Your team will start with what it already knows.",
    );
    expect(html).toContain("Answer at least one question to save");
  });

  it("a saved session shows its banner", () => {
    const model = hydrated({
      status: "DONE",
      answers: { goal: { picked: ["goal.sales"] } },
    });
    const html = renderPanel(panelProps(panelViewOf(model)));
    expect(html).toContain(
      "Your setup is saved. Change anything below, then approve again.",
    );
  });
});

describe("Approve (G78)", () => {
  // The attributes of the Approve button, whatever it currently says.
  const approveButton = (html: string): string => {
    for (const label of [
      "Approve and start",
      "Saving your answers…",
      "Saving your setup…",
    ]) {
      try {
        return buttonAttrs(html, label);
      } catch {
        // try the next label
      }
    }
    throw new Error("no Approve button");
  };

  it("empty: aria-disabled with the hint id, never the disabled attribute", () => {
    const html = renderPanel(panelProps(panelViewOf(reviewOf(hydrated()))));
    const button = approveButton(html);
    expect(button).toContain('aria-disabled="true"');
    expect(button).toContain(
      `aria-describedby="${GUIDED_SETUP_IDS.approveHint}"`,
    );
    expect(button).not.toMatch(/\sdisabled(=|\s|$)/);
    expect(html).toContain(`id="${GUIDED_SETUP_IDS.approveHint}"`);
    expect(html).toContain("Answer at least one question to save");
  });

  it("unchanged: the other hint", () => {
    const model = hydrated({
      status: "DONE",
      answers: { goal: { picked: ["goal.sales"] } },
    });
    const html = renderPanel(panelProps(panelViewOf(model)));
    const button = approveButton(html);
    expect(button).toContain('aria-disabled="true"');
    expect(button).not.toMatch(/\sdisabled(=|\s|$)/);
    expect(html).toContain("Nothing changed since you saved");
  });

  it("ready: enabled, no hint, calls onApprove", () => {
    const spies = makeSpies();
    // A settled session opened on Review: nothing is saving.
    const model = hydrated({
      step: "review",
      answers: { goal: { picked: ["goal.sales"] } },
    });
    expect(model.save).toBe("idle");
    const props = panelProps(panelViewOf(model), {}, spies);
    const html = renderPanel(props);
    const button = approveButton(html);
    expect(button).not.toContain("aria-disabled");
    expect(button).not.toContain("aria-describedby");
    expect(html).not.toContain(GUIDED_SETUP_IDS.approveHint);
    expect(html).toContain("lucide-rocket");
    click(byText(elements(props), "Approve and start"));
    expect(spies.onApprove).toHaveBeenCalledTimes(1);
  });

  it("an inert Approve ignores clicks", () => {
    const spies = makeSpies();
    // Opened on Review with nothing answered and nothing saving.
    const model = hydrated({ step: "review" });
    expect(model.save).toBe("idle");
    const props = panelProps(panelViewOf(model), {}, spies);
    const buttons = elements(props).filter(
      (el) =>
        textOf(el.props.children as ReactNode).trim() === "Approve and start",
    );
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.props.onClick).toBeUndefined();
      expect(button.props["aria-disabled"]).toBe(true);
    }
    expect(spies.onApprove).not.toHaveBeenCalled();
  });

  it("stays enabled while a save is pending, showing 'Saving your answers…'", () => {
    const model = reviewOf(run(hydrated(), pick("goal.sales")));
    expect(model.save).toBe("saving");
    const spies = makeSpies();
    const props = panelProps(panelViewOf(model), {}, spies);
    const html = renderPanel(props);
    const button = approveButton(html);
    expect(html).toContain("Saving your answers…");
    expect(button).not.toContain("aria-disabled");
    click(byText(elements(props), "Saving your answers…"));
    expect(spies.onApprove).toHaveBeenCalledTimes(1);
  });

  it("a failed save keeps Approve enabled and adds the inline alert with Try again", () => {
    const model = reviewOf(
      run(hydrated(), pick("goal.sales"), { type: "saveFailed" }),
    );
    const spies = makeSpies();
    const props = panelProps(panelViewOf(model), {}, spies);
    const html = renderPanel(props);
    expect(html).toContain('role="alert"');
    expect(html).toContain(
      "Couldn't save your answers. Check your connection, then try again.",
    );
    expect(approveButton(html)).not.toContain("aria-disabled");
    click(byText(elements(props), "Try again"));
    expect(spies.onRetrySave).toHaveBeenCalledTimes(1);
    expect(spies.onApprove).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// G40 / spec 3.6: every state row
// -----------------------------------------------------------------------------

describe("states (spec 3.6)", () => {
  it("boot error: alert, Try again re-runs start, Close closes", () => {
    const spies = makeSpies();
    const props = panelProps({ kind: "bootError" }, {}, spies);
    const html = renderPanel(props);
    expect(html).toContain('role="alert"');
    expect(html).toContain("We couldn't open setup.");
    const list = elements(props);
    click(byText(list, "Try again"));
    click(byText(list, "Close"));
    expect(spies.onRetryBoot).toHaveBeenCalledTimes(1);
    expect(spies.onClose).toHaveBeenCalledTimes(1);
  });

  it("not available: alert and Close only", () => {
    const props = panelProps({ kind: "unavailable" });
    const html = renderPanel(props);
    expect(html).toContain("Guided setup isn't available.");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Try again");
    expect(html).toContain("Close");
  });

  it("expired: alert with a Sign in link to the callback URL", () => {
    const href = "/login?callbackUrl=%2Fprojects%2Fp1%3Fguide%3Dsetup";
    const html = renderPanel(panelProps({ kind: "expired", href }));
    expect(html).toContain('role="alert"');
    expect(html).toContain(
      "Your session expired. Sign in again to continue. Your progress is saved.",
    );
    expect(html).toContain(`href="${href}"`);
    expect(html).toContain("Sign in");
    expect(panelViewOf(run(goalStep(), { type: "expired" }))).toMatchObject({
      kind: "expired",
      href,
    });
  });

  it("project paused: a note at the top with a Settings link, not an alert", () => {
    const model = hydrated({ projectActive: false });
    const html = renderPanel(
      panelProps(panelViewOf(model), { settingsHref: "/projects/p1/ayarlar" }),
    );
    expect(html).toContain(
      "This project is paused. You can answer now; approving needs it active.",
    );
    expect(html).toContain('href="/projects/p1/ayarlar"');
    expect(html).not.toContain('role="alert"');
  });

  const applyFailure = (
    code: "STALE" | "ON_HOLD" | "RATE" | "BUSY" | "FAILED" | "PARTIAL",
    extra: Partial<Extract<Action, { type: "applyFailed" }>> = {},
  ) =>
    reviewOf(
      run(
        run(hydrated(), pick("goal.sales")),
        { type: "applyStarted" },
        { type: "applyFailed", code, ...extra },
      ),
    );

  it("each apply failure is an alert with its own words and the right retry", () => {
    const cases: [
      Parameters<typeof applyFailure>[0],
      string,
      string | null,
      keyof Spies | null,
    ][] = [
      [
        "STALE",
        "This setup changed in another tab.",
        "Reload setup",
        "onReload",
      ],
      [
        "ON_HOLD",
        "This project is paused. Resume it first, then approve.",
        null,
        null,
      ],
      [
        "RATE",
        "You've saved this setup many times today. Try again tomorrow.",
        null,
        null,
      ],
      ["BUSY", "Your setup is being saved. Give it a moment.", null, null],
      [
        "FAILED",
        "Couldn't save your setup. Try again.",
        "Try again",
        "onApprove",
      ],
    ];
    for (const [code, text, button, handler] of cases) {
      const spies = makeSpies();
      const props = panelProps(panelViewOf(applyFailure(code)), {}, spies);
      const html = renderPanel(props);
      expect(html, code).toContain('role="alert"');
      expect(html, code).toContain(text);
      if (button && handler) {
        click(byText(elements(props), button));
        expect(spies[handler], code).toHaveBeenCalledTimes(1);
      } else {
        expect(html, code).not.toContain("Reload setup");
      }
    }
  });

  it("partial apply names what was saved and what was not, with Try again", () => {
    const model = applyFailure("PARTIAL", {
      saved: ["profile"],
      failed: ["goal"],
    });
    const spies = makeSpies();
    const props = panelProps(panelViewOf(model), {}, spies);
    const html = renderPanel(props);
    expect(html).toContain('role="alert"');
    expect(html).toContain(
      "Some parts couldn't be saved. Saved: Brand profile. Not saved: Goal.",
    );
    click(byText(elements(props), "Try again"));
    expect(spies.onApprove).toHaveBeenCalledTimes(1);
  });

  it("a discovery problem is an inline alert with Try again for the ideas", () => {
    const model = run(goalStep(), { type: "discoverFailed" });
    const spies = makeSpies();
    const props = panelProps(panelViewOf(model), {}, spies);
    const html = renderPanel(props);
    expect(html).toContain('role="alert"');
    expect(html).toContain("We couldn't gather ideas this time.");
    click(byText(elements(props), "Try again"));
    expect(spies.onRetryIdeas).toHaveBeenCalledTimes(1);
  });

  it("applying: inert button with a spinner, Back inert, the stalled line is a status", () => {
    const spies = makeSpies();
    const props = panelProps({ kind: "applying", stalled: false }, {}, spies);
    const html = renderPanel(props);
    expect(html).toContain("Saving your setup…");
    expect(html).toContain("animate-spin motion-reduce:animate-none");
    expect(html).not.toContain("Approve and start");
    expect(html).not.toContain("This is taking longer than usual.");
    expect(html).not.toMatch(/<button[^>]*\sdisabled=/);
    expect(html).not.toMatch(/<button[^>]*\sdisabled(?=[\s>])/);
    const list = elements(props);
    const buttons = list.filter(
      (el) =>
        el.type === undefined ||
        typeof el.props.onClick === "function" ||
        el.props["aria-disabled"] === true,
    );
    expect(buttons.some((el) => el.props["aria-disabled"] === true)).toBe(true);
    const back = list.find((el) =>
      textOf(el.props.children as ReactNode).includes("Back"),
    );
    expect(back?.props.onClick).toBeUndefined();

    const stalled = renderPanel(
      panelProps({ kind: "applying", stalled: true }),
    );
    expect(stalled).toContain(
      "This is taking longer than usual. You can close this, your setup keeps saving.",
    );
    expect(stalled).toMatch(/<p role="status"[^>]*>This is taking longer/);
  });

  it("done: the summary lines and the receipt buttons", () => {
    const spies = makeSpies();
    const props = panelProps(
      {
        kind: "done",
        summary: {
          goal: "Sales",
          goalProposed: true,
          channels: ["Instagram", "LinkedIn"],
          saved: ["Brand profile", "Goal"],
          unconnected: ["instagram"],
          canDraftPlan: true,
        },
      },
      {
        connectHref: "/projects/p1/integrations",
        draft: { status: "idle", error: null },
      },
      spies,
    );
    const html = renderPanel(props);
    expect(html).toContain("Setup saved");
    expect(html).toContain(
      "Goal: Sales (waiting for your approval in Strategy)",
    );
    expect(html).toContain("Channels: Instagram, LinkedIn");
    expect(html).toContain("Saved: Brand profile, Goal");
    expect(html).toContain("Draft my first plan");
    expect(html).toContain("You review the plan before anything is saved.");
    expect(html).toContain('href="/projects/p1/integrations"');
    expect(html).toContain("Connect accounts");
    // The shell focuses this button when Approve finishes (spec 3.5).
    expect(html).toMatch(
      new RegExp(`<button[^>]*${FOCUS_ATTR}="close"[^>]*>Close</button>`),
    );
    const list = elements(props);
    click(byText(list, "Draft my first plan"));
    click(byText(list, "Edit setup"));
    click(byText(list, "Close"));
    expect(spies.onDraftPlan).toHaveBeenCalledTimes(1);
    expect(spies.onEditSetup).toHaveBeenCalledTimes(1);
    expect(spies.onClose).toHaveBeenCalledTimes(1);
  });

  it("done: no plan button on the legacy engine, no connect link when everything is connected, pending and error states", () => {
    const html = renderPanel(
      panelProps(
        { kind: "done", summary: { saved: ["Goal"], canDraftPlan: false } },
        { connectHref: "/projects/p1/integrations" },
      ),
    );
    expect(html).not.toContain("Draft my first plan");
    expect(html).not.toContain("Connect accounts");
    const pending = makeSpies();
    const props = panelProps(
      { kind: "done", summary: { saved: [], canDraftPlan: true } },
      { draft: { status: "pending", error: null } },
      pending,
    );
    expect(renderPanel(props)).toContain("Drafting…");
    expect(
      elements(props).find(
        (el) => textOf(el.props.children as ReactNode) === "Drafting…",
      )?.props.onClick,
    ).toBeUndefined();
    const failed = renderPanel(
      panelProps(
        { kind: "done", summary: { saved: [], canDraftPlan: true } },
        {
          draft: {
            status: "idle",
            error: "Couldn't draft the plan. Try again.",
          },
        },
      ),
    );
    expect(failed).toContain('role="alert"');
  });

  it("a pick cleared by the switch to suggestions is announced inline", () => {
    const model = run(
      hydrated({ ideas: ideasView() }),
      skip,
      skip,
      skip,
      pick("audience.local"),
      { type: "ideasUpdated", ideas: READY, from: "poll" },
      { type: "showSuggestions" },
    );
    const html = renderPanel(panelProps(panelViewOf(model)));
    expect(html).toContain('role="alert"');
    expect(html).toContain("so it was cleared.");
  });
});

// -----------------------------------------------------------------------------
// Source rules of the task: presentational, no portal, no effects
// -----------------------------------------------------------------------------

describe("panel source", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/components/guide/guided-setup-panel.tsx"),
    "utf8",
  );

  it("is 'use client', has no portal and no state or effect hooks", () => {
    expect(source.startsWith('"use client";')).toBe(true);
    expect(source).not.toMatch(/Portal/);
    expect(source).not.toMatch(
      /\buse(State|Effect|LayoutEffect|Reducer|Memo|Callback|Ref|Context)\b/,
    );
    expect(source).not.toContain("dangerouslySetInnerHTML");
    expect(source).not.toMatch(/\bany\b\s*[,;)>\]]|: any\b|as any\b/);
  });

  it("uses the Drawer parts and the workspace tokens only for colour", () => {
    expect(source).toContain("DrawerTitle");
    expect(source).toContain("DrawerDescription");
    expect(source).toContain("DrawerClose");
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toContain("--ws-text-3");
  });
});
