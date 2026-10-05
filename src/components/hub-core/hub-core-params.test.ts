import { describe, expect, it } from "vitest";

import {
  BRAND_BRAIN_SUB_KEYS,
  ENTITY_KINDS,
  ENTITY_PANEL,
  ENTITY_SUB,
  PANEL_KEYS,
  buildHubHref,
  entityHref,
  legacyRouteHref,
  normalizeLegacyHubParams,
  parseHubParams,
  type EntityKind,
} from "./hub-core-params";

// The one URL contract of the project screens. What this suite proves: the
// Signals / Insights & Opportunities / Goals panels are Brand Brain tabs (and no
// longer panels of their own), every record opens in the tab that owns it, and
// an old link (the English panels or the first Turkish ones) still lands on the
// right screen instead of dropping to the chat.

const p = (query: string) =>
  parseHubParams(Object.fromEntries(new URLSearchParams(query)));

describe("panels and Brand Brain tabs", () => {
  it("the three folded panels are gone as panels and present as tabs", () => {
    for (const gone of ["signals", "insights-opportunities", "goals"]) {
      expect(PANEL_KEYS as readonly string[]).not.toContain(gone);
    }
    expect(BRAND_BRAIN_SUB_KEYS).toContain("goals");
    expect(BRAND_BRAIN_SUB_KEYS).toContain("intelligence");
  });

  it("keeps the tabs that are fed today; Strategy, Evidence and the version log live in Constitution", () => {
    expect([...BRAND_BRAIN_SUB_KEYS]).toEqual([
      "assets",
      "rules",
      "visual-identity",
      "constitution",
      "goals",
      "intelligence",
      "learnings",
    ]);
    for (const merged of ["strategy", "evidence", "decisions"]) {
      expect(p(`panel=brand-brain&sub=${merged}`)).toMatchObject({
        panel: "brand-brain",
        sub: "constitution",
      });
    }
  });

  it("accepts the new tabs as a sub", () => {
    expect(p("panel=brand-brain&sub=goals")).toMatchObject({
      panel: "brand-brain",
      sub: "goals",
    });
    expect(p("panel=brand-brain&sub=intelligence")).toMatchObject({
      panel: "brand-brain",
      sub: "intelligence",
    });
    // A sub that is not a tab is dropped, not passed through.
    expect(p("panel=brand-brain&sub=nonsense").sub).toBeNull();
  });
});

describe("opening a record", () => {
  const tabOf: Partial<Record<EntityKind, string>> = {
    signal: "intelligence",
    finding: "intelligence",
    insight: "intelligence",
    opportunity: "intelligence",
    goal: "goals",
    constitution: "constitution",
  };

  it.each(Object.entries(tabOf))("%s opens Brand Brain's %s tab", (kind, sub) => {
    expect(ENTITY_PANEL[kind as EntityKind]).toBe("brand-brain");
    expect(ENTITY_SUB[kind as EntityKind]).toBe(sub);
    expect(entityHref("proj-1", { kind: kind as EntityKind, id: "x1" })).toBe(
      `/projects/proj-1?panel=brand-brain&sub=${sub}&entity=${kind}%3Ax1`,
    );
  });

  it("every record kind opens a panel that exists", () => {
    for (const kind of ENTITY_KINDS) {
      expect(PANEL_KEYS as readonly string[]).toContain(ENTITY_PANEL[kind]);
      const href = entityHref("proj-1", { kind, id: "abc" });
      const parsed = p(href.split("?")[1]!);
      expect(parsed.panel).toBe(ENTITY_PANEL[kind]);
      expect(parsed.entity).toEqual({ kind, id: "abc" });
      // The tab it names is one the panel really has.
      if (ENTITY_SUB[kind]) expect(parsed.sub).toBe(ENTITY_SUB[kind]);
    }
  });

  it("records of the other panels are unchanged, and an explicit sub wins", () => {
    expect(entityHref("p", { kind: "idea", id: "i1" })).toBe(
      "/projects/p?panel=ideas&entity=idea%3Ai1",
    );
    expect(entityHref("p", { kind: "task", id: "t1" }, "tasks")).toBe(
      "/projects/p?panel=work&sub=tasks&entity=task%3At1",
    );
    expect(entityHref("p", { kind: "goal", id: "g1" })).toContain("sub=goals");
  });
});

describe("old links", () => {
  it("the English panels that became tabs land on their tab", () => {
    expect(p("panel=signals")).toMatchObject({ panel: "brand-brain", sub: "intelligence" });
    expect(p("panel=insights-opportunities")).toMatchObject({
      panel: "brand-brain",
      sub: "intelligence",
    });
    expect(p("panel=goals")).toMatchObject({ panel: "brand-brain", sub: "goals" });
  });

  it("keeps the record an old link pointed at", () => {
    expect(p("panel=signals&entity=finding:f1")).toMatchObject({
      panel: "brand-brain",
      sub: "intelligence",
      entity: { kind: "finding", id: "f1" },
    });
  });

  it("the first Turkish panels land where their content lives now", () => {
    expect(p("panel=sinyaller")).toMatchObject({ panel: "brand-brain", sub: "intelligence" });
    expect(p("panel=icgoru-firsat")).toMatchObject({ panel: "brand-brain", sub: "intelligence" });
    expect(p("panel=hedefler")).toMatchObject({ panel: "brand-brain", sub: "goals" });
    expect(p("panel=marka-beyni")).toMatchObject({ panel: "brand-brain", sub: null });
    expect(p("panel=fikirler").panel).toBe("ideas");
    // The departments panel is gone: an old link lands on the chat.
    expect(p("panel=departmanlar").panel).toBeNull();
    expect(p("panel=kurulum").panel).toBe("setup");
  });

  it("maps the Turkish sub-tabs of Work and Settings", () => {
    // Work is the task log now: every old board lands there.
    for (const old of ["planlar", "gorevler", "devirler", "olcumler"]) {
      expect(p(`panel=isler&sub=${old}`)).toMatchObject({ panel: "work", sub: "tasks" });
    }
    expect(p("panel=work&sub=plans")).toMatchObject({ panel: "work", sub: "tasks" });
    expect(p("panel=ayarlar&sub=otonomi")).toMatchObject({ panel: "settings", sub: "autonomy" });
    // The decisions tab is gone: the sub is dropped.
    expect(p("panel=ayarlar&sub=kararlar")).toMatchObject({ panel: "settings", sub: null });
    expect(p("panel=ayarlar&sub=aktivite")).toMatchObject({ panel: "settings", sub: "activity" });
    expect(p("panel=ayarlar&sub=tehlike")).toMatchObject({ panel: "settings", sub: "risk" });
    // A sub the old panel never had is dropped, not mis-mapped.
    expect(p("panel=ayarlar&sub=nonsense").sub).toBeNull();
  });

  it("leaves current and unknown values alone", () => {
    const current = { panel: "brand-brain", sub: "goals" };
    expect(normalizeLegacyHubParams(current)).toBe(current);
    expect(p("panel=totally-unknown").panel).toBeNull();
    expect(p("").panel).toBeNull();
  });
});

describe("legacyRouteHref (the old standalone routes)", () => {
  it("sends a record to the tab that owns it", () => {
    expect(
      legacyRouteHref("p", "sinyaller", { entity: { kind: "signal", id: "s1" } }),
    ).toBe("/projects/p?panel=brand-brain&sub=intelligence&entity=signal%3As1");
    expect(
      legacyRouteHref("p", "hedefler", { entity: { kind: "opportunity", id: "o1" } }),
    ).toContain("sub=intelligence");
  });

  it("maps an old panel and its sub-tab, and never produces a dead link", () => {
    expect(legacyRouteHref("p", "hedefler")).toBe(
      "/projects/p?panel=brand-brain&sub=goals",
    );
    expect(legacyRouteHref("p", "isler", { sub: "gorevler" })).toBe(
      "/projects/p?panel=work&sub=tasks",
    );
    expect(legacyRouteHref("p", "ayarlar", { sub: "otonomi" })).toBe(
      "/projects/p?panel=settings&sub=autonomy",
    );
    // An old name nobody maps lands on the project root, not on a blank panel.
    expect(legacyRouteHref("p", "nope")).toBe("/projects/p");
    // Every href it makes parses back to a real panel.
    for (const legacy of ["sinyaller", "icgoru-firsat", "hedefler", "marka-beyni", "fikirler", "isler", "ayarlar", "kurulum"]) {
      const href = legacyRouteHref("p", legacy);
      expect(p(href.split("?")[1] ?? "").panel, legacy).not.toBeNull();
    }
  });

  it("buildHubHref is unchanged for the current panels", () => {
    expect(buildHubHref("p", { panel: "brand-brain", sub: "goals" })).toBe(
      "/projects/p?panel=brand-brain&sub=goals",
    );
  });
});
