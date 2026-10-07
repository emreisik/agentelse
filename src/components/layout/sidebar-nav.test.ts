import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ModuleKey } from "@/lib/modules/catalog";

const nav = vi.hoisted(() => ({ search: "" }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/proj-1",
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: vi.fn() }),
}));
// The Work list creates a Work through a server action; nothing here calls it.
vi.mock("@/server/actions/work-actions", () => ({
  createWorkAction: vi.fn(),
}));

const { SidebarNav, EXPLORE, exploreGroups, moduleLineTarget, openModuleLine } =
  await import("./sidebar-nav");
const { SidebarShell, DockedSidebarSkeleton } =
  await import("./sidebar-collapse");
const { MODULES, MODULE_KEYS } = await import("@/lib/modules/catalog");

// Works on, with no chat yet; modules (MODULES_UI) off unless asked.
const works = (modulesUi = false) => ({ recents: [], modulesUi });

const render = (props: Partial<Parameters<typeof SidebarNav>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(SidebarNav, { activeProjectId: "proj-1", ...props }),
  );

describe("SidebarNav", () => {
  it("has no Insights group: Signals, Insights & Opportunities and Goals are Brand Brain tabs", () => {
    const html = render();
    expect(html).not.toContain(">Insights<");
    expect(html).not.toContain("Signals");
    expect(html).not.toContain("Insights &amp; Opportunities");
    expect(html).not.toContain(">Goals<");
    expect(html).not.toContain("panel=signals");
    expect(html).not.toContain("panel=goals");
    expect(html).not.toContain("panel=insights-opportunities");
  });

  it("has no System group, and the removed panels are linked nowhere", () => {
    const html = render();
    expect(html).not.toContain("System");
    for (const label of ["Setup", "Departments", "Human Action"]) {
      expect(html).not.toContain(label);
    }
    expect(html).not.toContain("panel=setup");
    expect(html).not.toContain("panel=departments");
    expect(html).not.toContain("panel=human-action");
  });

  it("lists the day-to-day pages with no group titles, then Explore (Agency Desk only without Works)", () => {
    const html = render();
    const order = [
      "Agency Desk",
      "Brand Brain",
      "Ideas",
      "Library",
      "Content Calendar",
      ">Explore<",
    ].map((label) => html.indexOf(label));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("panel=brand-brain");
    expect(html).not.toContain(">Create<");
    expect(html).not.toContain(">Channels<");
  });

  it("keeps the channels, the task log and Settings behind Explore, not as lines of their own", () => {
    const html = render();
    for (const label of ["Ads Manager", "Connectors", "Task log", "Settings"]) {
      expect(html).not.toContain(label);
    }
    expect(EXPLORE.map((group) => group.map((item) => item.label))).toEqual([
      ["Ads Manager", "Connectors"],
      ["Task log", "Settings"],
    ]);
  });

  it("Explore reads as selected while one of its pages is open", () => {
    nav.search = "panel=settings";
    const html = render();
    nav.search = "";
    expect(html).toMatch(
      /<button[^>]*class="[^"]*bg-sidebar-accent font-medium[^"]*"[^>]*>[\s\S]*?Explore/,
    );
  });

  it("shows the badge on Brand Brain (goals waiting for a decision live there now)", () => {
    const html = render({ toolBadges: { "brand-brain": 2 } });
    expect(html).toMatch(/Brand Brain[\s\S]{0,400}>2</);
  });

  it("collapsed to the icon rail: icons named by aria-label, no group titles, no Recents", () => {
    const html = renderToStaticMarkup(
      createElement(
        SidebarShell,
        { defaultCollapsed: true },
        createElement(SidebarNav, {
          activeProjectId: "proj-1",
          works: works(),
          toolBadges: { "brand-brain": 2 },
        }),
      ),
    );
    expect(html).toContain("w-14");
    for (const label of ["New Chat", "Brand Brain", "Explore"]) {
      expect(html).toContain(`aria-label="${label}"`);
      // The label is only the icon's name, never visible text.
      expect(html).not.toContain(`>${label}<`);
    }
    expect(html).not.toContain("Create");
    expect(html).not.toContain("Recents");
    // A badge is a dot, not a count.
    expect(html).not.toMatch(/Brand Brain[\s\S]{0,400}>2</);
  });

  it("open by default: the docked sidebar is 256px with labels", () => {
    const html = renderToStaticMarkup(
      createElement(
        SidebarShell,
        { defaultCollapsed: false },
        createElement(SidebarNav, {
          activeProjectId: "proj-1",
          works: works(),
        }),
      ),
    );
    expect(html).toContain("w-64");
    expect(html).toContain(">Brand Brain<");
    expect(html).toContain("Recents");
  });
});

// Every module is built; the "not ready" paths stay for a module added later.
// Flips readiness while one render runs and always puts it back.
function withReady<T>(keys: ModuleKey[], ready: boolean, run: () => T): T {
  const defs = keys.map((key) => MODULES[key] as { ready: boolean });
  const was = defs.map((def) => def.ready);
  for (const def of defs) def.ready = ready;
  try {
    return run();
  } finally {
    defs.forEach((def, i) => (def.ready = was[i] ?? true));
  }
}

describe("SidebarNav: Modules (MODULES_UI)", () => {
  const MODULE_LABELS = [
    "Social Media Planner",
    "Ads Manager",
    "Analytics",
    "SEO Manager",
  ];
  const open = (modulesUi: boolean) =>
    renderToStaticMarkup(
      createElement(
        SidebarShell,
        { defaultCollapsed: false },
        createElement(SidebarNav, {
          activeProjectId: "proj-1",
          works: works(modulesUi),
        }),
      ),
    );
  const rail = (modulesUi: boolean) =>
    renderToStaticMarkup(
      createElement(
        SidebarShell,
        { defaultCollapsed: true },
        createElement(SidebarNav, {
          activeProjectId: "proj-1",
          works: works(modulesUi),
        }),
      ),
    );

  it("off: no Modules group, no module link, and Explore keeps Ads Manager", () => {
    for (const html of [open(false), rail(false), render()]) {
      expect(html).not.toContain("Modules");
      expect(html).not.toContain("?module=");
      expect(html).not.toContain("Soon");
      for (const label of MODULE_LABELS) expect(html).not.toContain(label);
    }
    expect(exploreGroups(false)).toBe(EXPLORE);
  });

  it("GA_WEBSITE_PAGE adds the Website page right before Connectors", () => {
    expect(exploreGroups(false, true)[0]?.map((item) => item.label)).toEqual([
      "Ads Manager",
      "Website",
      "Connectors",
    ]);
    expect(exploreGroups(true, true)[0]?.map((item) => item.label)).toEqual([
      "Ads account",
      "Website",
      "Connectors",
    ]);
    expect(exploreGroups(false, true)[1]).toEqual(EXPLORE[1]);
  });

  it("GSC_SEARCH_PAGE adds the Search page right before Connectors", () => {
    const labels = (groups: ReturnType<typeof exploreGroups>, index: number) =>
      groups[index]?.map((item) => item.label);
    expect(labels(exploreGroups(false, false, true), 0)).toEqual([
      "Ads Manager",
      "Search",
      "Connectors",
    ]);
    expect(labels(exploreGroups(false, true, true), 0)).toEqual([
      "Ads Manager",
      "Website",
      "Search",
      "Connectors",
    ]);
    expect(labels(exploreGroups(true, true, true), 0)).toEqual([
      "Ads account",
      "Website",
      "Search",
      "Connectors",
    ]);
    expect(exploreGroups(false, false, true)[1]).toEqual(EXPLORE[1]);
  });

  it("GA_AGENCY adds the workspace Websites page after Search, before Connectors", () => {
    const labels = (groups: ReturnType<typeof exploreGroups>, index: number) =>
      groups[index]?.map((item) => item.label);
    expect(labels(exploreGroups(false, true, true, true), 0)).toEqual([
      "Ads Manager",
      "Website",
      "Search",
      "Websites",
      "Connectors",
    ]);
    expect(labels(exploreGroups(false, false, false, true), 0)).toEqual([
      "Ads Manager",
      "Websites",
      "Connectors",
    ]);
    // Bayrak kapalıyken liste bugünkü gibi.
    expect(exploreGroups(false, false, false, false)).toBe(EXPLORE);
    expect(exploreGroups(false, false, false, true)[1]).toEqual(EXPLORE[1]);
  });

  it("GSC_AGENCY adds the workspace Search overview before Websites and Connectors (SC-F9)", () => {
    const labels = (groups: ReturnType<typeof exploreGroups>, index: number) =>
      groups[index]?.map((item) => item.label);
    expect(labels(exploreGroups(false, true, true, true, true), 0)).toEqual([
      "Ads Manager",
      "Website",
      "Search",
      "Search overview",
      "Websites",
      "Connectors",
    ]);
    expect(labels(exploreGroups(false, false, false, false, true), 0)).toEqual([
      "Ads Manager",
      "Search overview",
      "Connectors",
    ]);
    // Bayrak kapalıyken liste bugünkü gibi.
    expect(exploreGroups(false, false, false, false, false)).toBe(EXPLORE);
    expect(exploreGroups(false, false, false, false, true)[1]).toEqual(
      EXPLORE[1],
    );
  });

  it("on: the group sits right under New Chat, before the pages and Recents", () => {
    const html = open(true);
    const order = [
      ">New Chat<",
      ">Modules<",
      ">Social Media Planner<",
      ">Ads Manager<",
      ">Analytics<",
      ">SEO Manager<",
      ">Brand Brain<",
      ">Explore<",
      ">Recents<",
    ].map((label) => html.indexOf(label));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Named by its heading, and still one block with New Chat.
    const heading = /<div id="([^"]+)"[^>]*>Modules<\/div>/.exec(html);
    expect(heading).not.toBeNull();
    expect(html).toContain(`role="group" aria-labelledby="${heading?.[1]}"`);
    expect(html.match(/class="shrink-0 space-y-0.5"/g)).toHaveLength(1);
  });

  it("on: every module line opens a new chat for its module", () => {
    const html = open(true);
    for (const [key, label] of [
      ["social", "Social Media Planner"],
      ["ads", "Ads Manager"],
      ["analytics", "Analytics"],
      ["seo", "SEO Manager"],
    ]) {
      expect(html).toMatch(
        new RegExp(
          `<a [^>]*href="/projects/proj-1\\?module=${key}"[^>]*>(?:(?!</a>).)*>${label}</span></a>`,
        ),
      );
    }
    expect(html).not.toContain(">Soon<");
    // A line starts a chat; with no empty module chat on screen, none is marked.
    expect(html).not.toMatch(/aria-current="page"[^>]*module=/);
    expect(html).not.toMatch(/<a [^>]*module=[^>]*aria-current="page"/);
  });

  it("on: a module that is not ready says Soon and goes nowhere; Ads opens the Ads account page", () => {
    const html = withReady(["ads", "analytics", "seo"], false, () =>
      open(true),
    );
    for (const label of ["Analytics", "SEO Manager"]) {
      expect(html).toMatch(
        new RegExp(
          `<span role="link" aria-disabled="true"[^>]*>(?:(?!</span><span role).)*?>${label}</span><span[^>]*>Soon</span></span>`,
        ),
      );
    }
    expect(html).not.toContain("?module=analytics");
    expect(html).not.toContain("?module=seo");
    expect(html.match(/>Soon</g)).toHaveLength(2);
    // Like its launcher tile: a working link (no Soon), marked as opening a page.
    expect(html).toMatch(
      /<a [^>]*href="\/projects\/proj-1\/ads"[^>]*>(?:(?!<\/a>).)*>Ads Manager<\/span><svg[^>]*lucide-arrow-up-right[^>]*>(?:(?!<\/a>).)*<\/svg><\/a>/,
    );
  });

  it("on: the line targets follow the catalog's readiness", () => {
    for (const key of MODULE_KEYS) {
      expect(moduleLineTarget("p", MODULES[key])).toEqual({
        kind: "start",
        href: `/projects/p?module=${key}`,
      });
    }
    // A module that is not ready: Ads falls back to its page, the rest wait.
    expect(moduleLineTarget("p", { ...MODULES.ads, ready: false })).toEqual({
      kind: "page",
      href: "/projects/p/ads",
    });
    expect(
      moduleLineTarget("p", { ...MODULES.analytics, ready: false }),
    ).toEqual({ kind: "soon" });
    expect(moduleLineTarget("p", { ...MODULES.seo, ready: false })).toEqual({
      kind: "soon",
    });
  });

  it("on: Explore's ads page is the Ads account (Ads Manager is the module now)", () => {
    const groups = exploreGroups(true);
    expect(groups.map((group) => group.map((item) => item.label))).toEqual([
      ["Ads account", "Connectors"],
      ["Task log", "Settings"],
    ]);
    const ads = groups[0]?.[0];
    expect(ads && "route" in ads ? ads.route : null).toBe("ads");
    expect(ads?.icon).not.toBe(EXPLORE[0]?.[0]?.icon);
  });

  it("on, collapsed to the rail: the four icons, named by aria-label and tooltip, no heading", () => {
    const html = rail(true);
    expect(html).toContain('role="group" aria-label="Modules"');
    expect(html).not.toContain(">Modules<");
    expect(html).not.toContain(">Soon<");
    expect(html).not.toContain("· Soon");
    for (const label of MODULE_LABELS) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    // The open sidebar's page mark is not in the rail either.
    expect(html).not.toContain("lucide-arrow-up-right");
    for (const label of MODULE_LABELS) {
      expect(html).not.toContain(`>${label}<`);
    }
    // In order, right after New Chat and before Brand Brain.
    const order = [
      'aria-label="New Chat"',
      'aria-label="Social Media Planner"',
      'aria-label="SEO Manager"',
      'aria-label="Brand Brain"',
    ].map((label) => html.indexOf(label));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("on, collapsed to the rail: a module that is not ready is named Soon", () => {
    const html = withReady(["analytics", "seo"], false, () => rail(true));
    for (const label of ["Analytics", "SEO Manager"]) {
      expect(html).toContain(`aria-label="${label} · Soon"`);
    }
  });
});

// An empty module chat on screen (page.tsx passes its module while it is
// untouched): its module's line is the marked one, not New Chat, which stays
// clickable to go back to a general chat.
describe("SidebarNav: the open module chat (MODULES_UI)", () => {
  const show = (
    props: Partial<Parameters<typeof SidebarNav>[0]>,
    options: { search?: string; collapsed?: boolean; modulesUi?: boolean } = {},
  ) => {
    nav.search = options.search ?? "work=w1";
    try {
      return renderToStaticMarkup(
        createElement(
          SidebarShell,
          { defaultCollapsed: options.collapsed ?? false },
          createElement(SidebarNav, {
            activeProjectId: "proj-1",
            works: works(options.modulesUi ?? true),
            openWorkUntouched: true,
            ...props,
          }),
        ),
      );
    } finally {
      nav.search = "";
    }
  };
  // The New Chat button's opening tag (open: its label inside; rail: named by
  // aria-label).
  const newChatTag = (html: string) =>
    /(<button [^>]*>)(?:(?!<\/button>).)*?>New Chat</.exec(html)?.[1] ??
    /<button [^>]*aria-label="New Chat"[^>]*>/.exec(html)?.[0] ??
    "";
  const markedLines = (html: string) =>
    [...html.matchAll(/<a [^>]*aria-current="page"[^>]*>/g)].map((m) => m[0]);

  it("marks the module's line and leaves New Chat clickable", () => {
    const html = show({ openWorkModule: "social" });
    const marked = markedLines(html);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('href="/projects/proj-1?module=social"');
    expect(marked[0]).toContain("bg-sidebar-accent font-medium");
    const newChat = newChatTag(html);
    expect(newChat).not.toBe("");
    expect(newChat).not.toContain('disabled=""');
    expect(newChat).not.toContain("aria-current");
  });

  it("an empty general chat marks New Chat (not clickable) and no module line", () => {
    const html = show({ openWorkModule: null });
    expect(markedLines(html)).toEqual([]);
    const newChat = newChatTag(html);
    expect(newChat).toContain('disabled=""');
    expect(newChat).toContain('aria-current="page"');
  });

  it("collapsed to the rail, the module's icon is the marked one", () => {
    const html = show({ openWorkModule: "social" }, { collapsed: true });
    const marked = markedLines(html);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('aria-label="Social Media Planner"');
    expect(newChatTag(html)).not.toContain('disabled=""');
  });

  it("a module whose line starts no chat (not ready) marks nothing; New Chat still goes back", () => {
    const html = withReady(["analytics"], false, () =>
      show({ openWorkModule: "analytics" }),
    );
    expect(markedLines(html)).toEqual([]);
    expect(newChatTag(html)).not.toContain('disabled=""');
  });

  it("with a panel open, or modules off, the module marks nothing", () => {
    const panel = show(
      { openWorkModule: "social" },
      { search: "work=w1&panel=settings" },
    );
    expect(markedLines(panel)).toEqual([]);
    // Modules off: the chat is a general one, New Chat as before.
    const off = show({ openWorkModule: "social" }, { modulesUi: false });
    expect(markedLines(off)).toEqual([]);
    expect(newChatTag(off)).toContain('aria-current="page"');
  });

  it("the line's mark: a ready module, on the chat screen, until its first message", () => {
    const base = { module: "social" as const, onChat: true, sent: false };
    expect(openModuleLine(base)).toBe("social");
    expect(openModuleLine({ ...base, sent: true })).toBeNull();
    expect(openModuleLine({ ...base, onChat: false })).toBeNull();
    expect(openModuleLine({ ...base, module: null })).toBeNull();
    withReady(["seo"], false, () =>
      expect(openModuleLine({ ...base, module: "seo" })).toBeNull(),
    );
    expect(openModuleLine({ ...base, module: undefined })).toBeNull();
  });
});

// The project loading screen's sidebar (loading.tsx passes isModulesEnabled()):
// with modules on it already has the Modules group's room, so the real sidebar
// does not jump when it lands. A server render shows the open shape.
describe("DockedSidebarSkeleton: the Modules group", () => {
  const skeletons = (modulesUi?: boolean) =>
    renderToStaticMarkup(
      createElement(
        DockedSidebarSkeleton,
        modulesUi === undefined ? {} : { modulesUi },
      ),
    ).match(/data-slot="skeleton"/g)?.length ?? 0;

  it("off (or not told): the shape as before", () => {
    expect(skeletons()).toBe(skeletons(false));
    // Brand, switcher, six lines, account.
    expect(skeletons(false)).toBe(9);
  });

  it("on: a heading and one line per module more", () => {
    expect(skeletons(true)).toBe(skeletons(false) + 1 + MODULE_KEYS.length);
  });
});
