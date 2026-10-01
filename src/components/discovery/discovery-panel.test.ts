import { readFileSync } from "node:fs";
import path from "node:path";

import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Drawer } from "@/components/ui/drawer";
import {
  FAIL_REASONS,
  STAGE_STATES,
  type Candidate,
  type DiscoveryView,
  type Row,
  type Stage,
  type StageState,
} from "@/lib/guided-discovery/contract";
import {
  DiscoveryPanel,
  DISCOVERY_IDS,
  type DiscoveryPanelProps,
} from "./discovery-panel";
import { initialState, type DiscoveryState } from "./discovery-state";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const stages = (over: Partial<Record<Stage, StageState>> = {}) => ({
  site: "pending" as StageState,
  identity: "pending" as StageState,
  research: "pending" as StageState,
  profile: "pending" as StageState,
  ...over,
});

const view = (over: Partial<DiscoveryView> = {}): DiscoveryView => ({
  rev: "rev000000001",
  status: "RUNNING",
  stages: stages({ site: "running" }),
  identity: null,
  rows: [],
  host: "qrhubmenu.com",
  failure: null,
  canRetry: false,
  brandName: "Qr Hub Menu",
  ...over,
});

const cand = (id: string, text: string, added = false): Candidate => ({
  id,
  text,
  score: 70,
  added,
});

const row = (over: Partial<Row> & Pick<Row, "field">): Row => ({
  tier: "accepted",
  score: 90,
  saved: [],
  candidates: [],
  ...over,
});

const MIXED = view({
  status: "READY",
  stages: stages({
    site: "done",
    identity: "done",
    research: "done",
    profile: "done",
  }),
  identity: { logo: true, colors: 3, fonts: 2, style: true },
  rows: [
    row({ field: "about", saved: ["A QR menu service for restaurants."] }),
    row({
      field: "products",
      tier: "assumed",
      score: 70,
      saved: ["QR menus"],
      candidates: [
        cand("c_aaaaaaaaaa", "Table stands"),
        cand("c_bbbbbbbbbb", "Menu design", true),
      ],
    }),
    row({ field: "markets", tier: "unknown", score: 20 }),
    row({ field: "channels", saved: ["Instagram", "Facebook"] }),
  ],
});

const noop = () => {};
function props(
  state: DiscoveryState,
  over: Partial<DiscoveryPanelProps> = {},
): DiscoveryPanelProps {
  return {
    state,
    brandName: "Qr Hub Menu",
    titleRef: createRef<HTMLHeadingElement>(),
    brandHref: "/projects/p1?panel=brand-brain&sub=visual-identity",
    loginHref: "/login?callbackUrl=%2Fprojects%2Fp1",
    onAdd: noop,
    onAddAll: noop,
    onConfirm: noop,
    onRetry: noop,
    onReload: noop,
    onClose: noop,
    ...over,
  };
}

// React escapes apostrophes in text; tests read the copy as written.
const plain = (html: string): string => html.replaceAll("&#x27;", "'");
const render = (p: DiscoveryPanelProps): string =>
  plain(
    renderToStaticMarkup(
      createElement(Drawer, { open: true }, createElement(DiscoveryPanel, p)),
    ),
  );
const renderView = (
  v: DiscoveryView | null,
  over: Partial<DiscoveryState> = {},
  panelOver: Partial<DiscoveryPanelProps> = {},
) => render(props({ ...initialState(v), ...over }, panelOver));

const count = (html: string, needle: string | RegExp): number =>
  html.split(needle).length - 1;

// -----------------------------------------------------------------------------
// RUNNING
// -----------------------------------------------------------------------------

describe("RUNNING", () => {
  it("shows the four stages, each with an icon and a word", () => {
    const html = renderView(
      view({
        stages: stages({
          site: "done",
          identity: "running",
          research: "skipped",
          profile: "failed",
        }),
      }),
    );
    expect(html).toContain("Getting to know Qr Hub Menu");
    for (const label of [
      "Reading your website",
      "Finding logo, colors and fonts",
      "Researching your brand on the web",
      "Writing your profile",
    ]) {
      expect(html).toContain(label);
    }
    for (const word of ["Done", "In progress", "Skipped", "Couldn't finish"]) {
      expect(html).toContain(word);
    }
    // One icon per stage line (decorative, the word carries the meaning).
    const list = html.slice(html.indexOf('<ul class="divide-y'));
    expect(count(list, "<svg")).toBe(4);
  });

  it.each(STAGE_STATES)("renders stage state %s", (state) => {
    const html = renderView(view({ stages: stages({ site: state }) }));
    expect(html).toContain("Reading your website");
  });

  it("has one primary action that only hides the sheet", () => {
    const html = renderView(view());
    expect(html).toContain("Continue in chat");
    expect(html).not.toContain("Looks good");
    expect(html).toContain("qrhubmenu.com");
  });

  it("without a host the help line does not name one", () => {
    const html = renderView(view({ host: null }));
    expect(html).toContain("Looking around the web");
  });
});

// -----------------------------------------------------------------------------
// READY
// -----------------------------------------------------------------------------

describe("READY", () => {
  const html = renderView(MIXED);

  it("shows title, tier words with icons and the primary button", () => {
    expect(html).toContain("Your brand profile");
    expect(html).toContain("Found");
    expect(html).toContain("Check");
    expect(html).toContain("Not found");
    expect(html).toContain("Looks good");
    expect(html).not.toContain("Continue in chat");
  });

  it("shows saved values as text and pills", () => {
    expect(html).toContain("A QR menu service for restaurants.");
    expect(html).toContain("QR menus");
    // Added candidate sits in saved, never as a chip.
    expect(html).not.toContain("Add Menu design");
  });

  it("renders candidate chips as buttons named 'Add {text}' with a >= 44 px target", () => {
    expect(html).toMatch(
      /<button[^>]*aria-label="Add Table stands"[^>]*class="[^"]*min-h-11/,
    );
    expect(html).toContain("+ Table stands");
    expect(html).toContain('aria-label="Suggestions for Products"');
  });

  it("shows channels as plain labels without a tier word", () => {
    expect(html).toContain("Instagram");
    expect(html).toContain("Facebook");
    const channels = html.slice(html.indexOf(">Channels<"));
    const channelsRow = channels.slice(0, channels.indexOf("</li>"));
    expect(channelsRow).not.toContain("Found");
  });

  it("shows the identity block from counts, with the quiet scan link", () => {
    expect(html).toContain("Brand look");
    expect(html).toContain("Logo found");
    expect(html).toContain("3 colors");
    expect(html).toContain("2 fonts");
    expect(html).toContain("Style noted");
    expect(html).toContain("Scan again in the Brand tab");
    expect(html).toContain(
      'href="/projects/p1?panel=brand-brain&amp;sub=visual-identity"',
    );
  });

  it("says so when no look was found", () => {
    const empty = renderView(view({ status: "READY", identity: null }));
    expect(empty).toContain("No logo, colors or fonts found yet.");
    expect(empty).toContain("Scan again in the Brand tab");
  });

  it("a pending candidate is disabled and busy", () => {
    const pending = renderView(MIXED, {
      pendingAdd: new Set(["c_aaaaaaaaaa"]),
    });
    expect(pending).toMatch(/<button[^>]*aria-busy="true"[^>]*disabled/);
  });

  it("empty rows say what could not be done and still offer Looks good", () => {
    const empty = renderView(view({ status: "READY", rows: [] }));
    expect(empty).toContain("We couldn't find much this time");
    expect(empty).toContain("Looks good");
  });

  it("a confirm in flight disables the primary button", () => {
    const busy = renderView(MIXED, { busy: "confirm" });
    expect(busy).toMatch(/<button[^>]*disabled[^>]*>Saving…/);
  });
});

// -----------------------------------------------------------------------------
// CONFIRMED and FAILED
// -----------------------------------------------------------------------------

describe("CONFIRMED", () => {
  it("shows Workspace ready, the count line and Open chat", () => {
    const html = renderView({ ...MIXED, status: "CONFIRMED" });
    expect(html).toContain("Workspace ready");
    expect(html).toContain("1 thing found · 1 to check");
    expect(html).toContain("Open chat");
    expect(html).not.toContain("Looks good");
  });

  it("still shows the whole profile, with suggestions and Add all", () => {
    const html = renderView({ ...MIXED, status: "CONFIRMED" });
    expect(html).toContain("Products");
    expect(html).toContain("Brand look");
    expect(html).toContain("+ Table stands");
    expect(html).toMatch(/Add all suggestions \(\d+\)/);
  });
});

describe("Add all", () => {
  it("is offered while suggestions wait and says Adding… during a tap", () => {
    expect(renderView(MIXED)).toMatch(/Add all suggestions \(\d+\)/);
    const busy = renderView(MIXED, { pendingAdd: new Set(["c_aaaaaaaaaa"]) });
    expect(busy).toContain("Adding…");
    expect(busy).not.toMatch(/Add all suggestions/);
  });

  it("is absent when nothing is waiting", () => {
    const none = renderView(
      view({
        status: "READY",
        rows: MIXED.rows.map((row) => ({
          ...row,
          candidates: row.candidates.map((c) => ({ ...c, added: true })),
        })),
      }),
    );
    expect(none).not.toContain("Add all suggestions");
  });

  it("names an empty row instead of leaving it blank", () => {
    const html = renderView(
      view({
        status: "READY",
        rows: [
          {
            field: "voice",
            tier: "unknown",
            score: 0,
            saved: [],
            candidates: [],
          },
        ],
      }),
    );
    expect(html).toContain("Nothing found yet.");
  });
});

describe("FAILED", () => {
  const SENTENCE: Record<(typeof FAIL_REASONS)[number], string> = {
    limit: "Research is paused for today",
    busy: "A scan of this brand just ran",
    timeout: "This took longer than expected",
    error: "Something went wrong while looking into your brand",
    unavailable: "Research isn't available right now",
  };

  it.each(FAIL_REASONS)("shows one sentence for %s", (reason) => {
    const html = renderView(view({ status: "FAILED", failure: reason }));
    expect(html).toContain(SENTENCE[reason]);
    expect(html).toContain("Continue in chat");
    expect(html).not.toContain(">Try again<");
  });

  it("offers Try again only while canRetry", () => {
    const html = renderView(
      view({ status: "FAILED", failure: "error", canRetry: true }),
    );
    expect(html).toContain("Try again");
    expect(html).toContain("Continue in chat");
  });

  it("a retry in flight disables the button", () => {
    const html = renderView(
      view({ status: "FAILED", failure: "error", canRetry: true }),
      { busy: "retry" },
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Starting…/);
  });

  it("keeps the stage list so the person sees how far it got", () => {
    const html = renderView(
      view({
        status: "FAILED",
        failure: "timeout",
        stages: stages({ site: "done", research: "failed" }),
      }),
    );
    expect(html).toContain("Researching your brand on the web");
  });
});

// -----------------------------------------------------------------------------
// Loading, errors, notices
// -----------------------------------------------------------------------------

describe("loading and errors", () => {
  it("loading shows skeletons and no footer button", () => {
    const html = renderView(null);
    expect(html).toContain("Getting to know Qr Hub Menu");
    expect(html).not.toContain('data-slot="button"');
  });

  it("SESSION links to sign in", () => {
    const html = renderView(null, { phase: "error", error: "SESSION" });
    expect(html).toContain("Your session expired");
    expect(html).toContain('href="/login?callbackUrl=%2Fprojects%2Fp1"');
  });

  it("a network error offers Try again and Close", () => {
    const html = renderView(null, { phase: "error", error: "NETWORK" });
    expect(html).toContain("Couldn't reach the server");
    expect(html).toContain("Try again");
    expect(html).toContain(">Close<");
  });

  it("DISABLED and EMPTY offer only Close", () => {
    for (const error of ["DISABLED", "EMPTY"] as const) {
      const html = renderView(null, { phase: "error", error });
      expect(html).not.toContain("Try again");
      expect(html).toContain(">Close<");
    }
  });

  it("a notice over a live view shows in the body and in the one status region", () => {
    const html = renderView(MIXED, { error: "NETWORK" });
    expect(count(html, "Couldn't reach the server")).toBe(2);
    expect(html).toContain("Looks good");
  });
});

// -----------------------------------------------------------------------------
// Structure
// -----------------------------------------------------------------------------

describe("structure", () => {
  const states: [string, DiscoveryView | null, Partial<DiscoveryState>][] = [
    ["loading", null, {}],
    ["running", view(), {}],
    ["ready", MIXED, {}],
    ["confirmed", { ...MIXED, status: "CONFIRMED" }, {}],
    [
      "failed",
      view({ status: "FAILED", failure: "error", canRetry: true }),
      {},
    ],
    ["error", null, { phase: "error", error: "HTTP" }],
  ];

  it.each(states)("%s has exactly one polite status region", (_n, v, over) => {
    const html = renderView(v, over);
    expect(count(html, "aria-live")).toBe(1);
    expect(count(html, 'role="status"')).toBe(1);
    expect(html).toContain('aria-live="polite"');
  });

  it.each(states)(
    "%s has a title, a description and a close button",
    (_n, v, over) => {
      const html = renderView(v, over);
      expect(html).toContain(`id="${DISCOVERY_IDS.title}"`);
      expect(html).toContain(`id="${DISCOVERY_IDS.help}"`);
      expect(html).toContain('aria-label="Close and continue later"');
    },
  );

  it("the status region carries the announcement", () => {
    const html = renderView(view(), { announcement: "Website read." });
    expect(html).toMatch(/aria-live="polite"[^>]*>Website read\.</);
  });

  it("every button and link has a 44 px target", () => {
    for (const [, v, over] of states) {
      const html = renderView(v, over);
      const tags = html.match(/<(button|a)\b[^>]*>/g) ?? [];
      for (const tag of tags) {
        expect(tag).toMatch(/min-h-11/);
      }
    }
  });

  it("asks no question anywhere", () => {
    for (const [, v, over] of states) {
      const html = renderView(v, over);
      const text = html.replace(/<[^>]*>/g, " ");
      expect(text).not.toMatch(/question/i);
      expect(text).not.toContain("?");
    }
  });
});

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

describe("handlers are wired as props", () => {
  it("renders without calling any handler", () => {
    const onAdd = vi.fn();
    const onConfirm = vi.fn();
    const onRetry = vi.fn();
    render(props(initialState(MIXED), { onAdd, onConfirm, onRetry }));
    expect(onAdd).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Source
// -----------------------------------------------------------------------------

describe("panel source", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/components/discovery/discovery-panel.tsx"),
    "utf8",
  );

  it("is 'use client' with no portal, no state or effect hooks", () => {
    expect(source.startsWith('"use client";')).toBe(true);
    expect(source).not.toMatch(/Portal/);
    expect(source).not.toMatch(
      /\buse(State|Effect|LayoutEffect|Reducer|Memo|Callback|Ref|Context)\b/,
    );
    expect(source).not.toContain("dangerouslySetInnerHTML");
    expect(source).not.toMatch(/: any\b|as any\b/);
  });

  it("uses the Drawer parts and the workspace tokens only for colour", () => {
    expect(source).toContain("DrawerTitle");
    expect(source).toContain("DrawerBody");
    expect(source).toContain("DrawerClose");
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("has no JSX text outside the COPY constant", () => {
    const start = source.indexOf("const COPY = {");
    const end = source.indexOf("} as const;", start);
    expect(start).toBeGreaterThan(0);
    const rest = (source.slice(0, start) + source.slice(end))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const literal = rest.match(/>\s*([A-Za-z][^<>{}=]*?)\s*</g) ?? [];
    expect(literal).toEqual([]);
  });
});
