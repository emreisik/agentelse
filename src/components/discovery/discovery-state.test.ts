import { describe, expect, it } from "vitest";

import type {
  DiscoveryView,
  Row,
  Stage,
  StageState,
} from "@/lib/guided-discovery/contract";
import {
  announcementOf,
  canAdd,
  discoveryReducer,
  identityBlock,
  initialState,
  pendingCandidateIds,
  rowBlocks,
  stageLines,
  summaryLine,
  titleOf,
  type DiscoveryAction,
  type DiscoveryState,
} from "./discovery-state";

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
  host: "example.com",
  failure: null,
  canRetry: false,
  brandName: "Example",
  ...over,
});

const row = (over: Partial<Row> & Pick<Row, "field">): Row => ({
  tier: "accepted",
  score: 90,
  saved: [],
  candidates: [],
  ...over,
});

const cand = (id: string, text: string, added = false) => ({
  id,
  text,
  score: 70,
  added,
});

const run = (state: DiscoveryState, ...actions: DiscoveryAction[]) =>
  actions.reduce(discoveryReducer, state);

describe("reducer", () => {
  it("starts ready with a view and loading without one", () => {
    expect(initialState(view()).phase).toBe("ready");
    expect(initialState(null).phase).toBe("loading");
  });

  it("loads a view, never announcing on the first load", () => {
    const next = run(initialState(null), {
      type: "loaded",
      view: view({ status: "READY" }),
    });
    expect(next.phase).toBe("ready");
    expect(next.announcement).toBe("");
  });

  it("a null first load is an EMPTY error; a null later load keeps the view", () => {
    const empty = run(initialState(null), { type: "loaded", view: null });
    expect(empty).toMatchObject({ phase: "error", error: "EMPTY" });
    const kept = run(initialState(view()), { type: "polled", view: null });
    expect(kept.view).toEqual(view());
    expect(kept.phase).toBe("ready");
  });

  it("a poll with the same view returns the same state object", () => {
    const state = initialState(view());
    expect(discoveryReducer(state, { type: "polled", view: view() })).toBe(
      state,
    );
  });

  it("a poll with the same rev but a derived FAILED status is applied", () => {
    const state = initialState(view());
    const next = discoveryReducer(state, {
      type: "polled",
      view: view({ status: "FAILED", failure: "timeout" }),
    });
    expect(next.view?.status).toBe("FAILED");
    expect(next.announcement).toBe("Setup stopped before it finished.");
  });

  it("a poll keeps the busy flag of an action in flight", () => {
    const state = run(initialState(view({ status: "READY" })), {
      type: "confirmStarted",
    });
    const next = discoveryReducer(state, {
      type: "polled",
      view: view({ status: "READY", rev: "rev000000002" }),
    });
    expect(next.busy).toBe("confirm");
  });

  it("add: started flags the candidate, done replaces the view and clears it", () => {
    const base = initialState(
      view({
        status: "READY",
        rows: [
          row({
            field: "products",
            tier: "assumed",
            candidates: [cand("c_aaaaaaaaaa", "Menus")],
          }),
        ],
      }),
    );
    const started = run(base, {
      type: "addStarted",
      candidateId: "c_aaaaaaaaaa",
    });
    expect(started.pendingAdd.has("c_aaaaaaaaaa")).toBe(true);
    expect(base.pendingAdd.size).toBe(0);
    const done = run(started, {
      type: "addDone",
      candidateId: "c_aaaaaaaaaa",
      view: view({
        status: "READY",
        rev: "rev000000002",
        rows: [
          row({
            field: "products",
            tier: "assumed",
            saved: ["Menus"],
            candidates: [cand("c_aaaaaaaaaa", "Menus", true)],
          }),
        ],
      }),
    });
    expect(done.pendingAdd.size).toBe(0);
    expect(done.view?.rows[0]?.saved).toEqual(["Menus"]);
  });

  it("canAdd: one at a time, only known unsaved candidates, never after FAILED", () => {
    const ready = initialState(
      view({
        status: "READY",
        rows: [
          row({
            field: "products",
            tier: "assumed",
            candidates: [
              cand("c_aaaaaaaaaa", "A"),
              cand("c_bbbbbbbbbb", "B", true),
            ],
          }),
        ],
      }),
    );
    expect(canAdd(ready, "c_aaaaaaaaaa")).toBe(true);
    expect(canAdd(ready, "c_bbbbbbbbbb")).toBe(false);
    expect(canAdd(ready, "c_cccccccccc")).toBe(false);
    const pending = run(ready, {
      type: "addStarted",
      candidateId: "c_aaaaaaaaaa",
    });
    expect(canAdd(pending, "c_aaaaaaaaaa")).toBe(false);
  });

  it("a failed add clears the pending flag, keeps the view and sets a notice", () => {
    const base = run(initialState(view({ status: "READY" })), {
      type: "addStarted",
      candidateId: "c_aaaaaaaaaa",
    });
    const next = run(base, {
      type: "failed",
      code: "NETWORK",
      during: "add",
      candidateId: "c_aaaaaaaaaa",
    });
    expect(next.pendingAdd.size).toBe(0);
    expect(next.error).toBe("NETWORK");
    expect(next.phase).toBe("ready");
    expect(next.view).not.toBeNull();
  });

  it("a failed load without a view is the error phase", () => {
    const next = run(initialState(null), {
      type: "failed",
      code: "HTTP",
      during: "load",
    });
    expect(next).toMatchObject({ phase: "error", error: "HTTP" });
  });

  it("polls fail silently except for SESSION and DISABLED", () => {
    const state = initialState(view());
    expect(
      discoveryReducer(state, {
        type: "failed",
        code: "NETWORK",
        during: "poll",
      }),
    ).toBe(state);
    expect(
      discoveryReducer(state, { type: "failed", code: "HTTP", during: "poll" }),
    ).toBe(state);
    expect(
      discoveryReducer(state, {
        type: "failed",
        code: "SESSION",
        during: "poll",
      }).error,
    ).toBe("SESSION");
  });

  it("confirm and retry flags", () => {
    const base = initialState(view({ status: "READY" }));
    const confirming = run(base, { type: "confirmStarted" });
    expect(confirming.busy).toBe("confirm");
    const done = run(confirming, {
      type: "confirmDone",
      view: view({ status: "CONFIRMED", rev: "rev000000002" }),
    });
    expect(done.busy).toBeNull();
    expect(done.view?.status).toBe("CONFIRMED");
    expect(done.announcement).toBe("Workspace ready.");

    const failed = initialState(
      view({ status: "FAILED", failure: "error", canRetry: true }),
    );
    const retrying = run(failed, { type: "retryStarted" });
    expect(retrying.busy).toBe("retry");
    const loaded = run(retrying, {
      type: "loaded",
      view: view({ rev: "rev000000003" }),
    });
    expect(loaded.busy).toBeNull();
    expect(loaded.view?.status).toBe("RUNNING");
  });

  it("failed confirm clears busy and shows a notice", () => {
    const next = run(
      initialState(view({ status: "READY" })),
      { type: "confirmStarted" },
      { type: "failed", code: "TIMEOUT", during: "confirm" },
    );
    expect(next.busy).toBeNull();
    expect(next.error).toBe("TIMEOUT");
  });
});

describe("selectors", () => {
  it("titleOf follows the status", () => {
    expect(titleOf(view(), "Fallback")).toBe("Getting to know Example");
    expect(titleOf(null, "Fallback")).toBe("Getting to know Fallback");
    expect(titleOf(null)).toBe("Getting to know your brand");
    expect(titleOf(view({ status: "READY" }))).toBe("Your brand profile");
    expect(titleOf(view({ status: "CONFIRMED" }))).toBe("Workspace ready");
    expect(titleOf(view({ status: "FAILED" }))).toBe("Setup paused");
  });

  it("stageLines gives an icon kind and a word per state, in order", () => {
    const lines = stageLines(
      view({
        stages: stages({
          site: "done",
          identity: "running",
          research: "skipped",
          profile: "failed",
        }),
      }),
    );
    expect(lines.map((l) => l.stage)).toEqual([
      "site",
      "identity",
      "research",
      "profile",
    ]);
    expect(lines.map((l) => l.icon)).toEqual([
      "done",
      "running",
      "skipped",
      "failed",
    ]);
    expect(lines.map((l) => l.word)).toEqual([
      "Done",
      "In progress",
      "Skipped",
      "Couldn't finish",
    ]);
    expect(lines[0]?.label).toBe("Reading your website");
    expect(lines[3]?.label).toBe("Writing your profile");
  });

  it("rowBlocks: labels, tier words, pending flag, added candidates folded into saved", () => {
    const blocks = rowBlocks(
      view({
        status: "READY",
        rows: [
          row({
            field: "products",
            tier: "assumed",
            saved: ["Menus"],
            candidates: [
              cand("c_aaaaaaaaaa", "Menus", true),
              cand("c_bbbbbbbbbb", "Stands"),
            ],
          }),
          row({ field: "about", saved: ["A cafe."] }),
          row({ field: "channels", saved: ["Instagram"] }),
          row({ field: "markets", tier: "unknown", score: 10 }),
        ],
      }),
      new Set(["c_bbbbbbbbbb"]),
    );
    // FIELD_IDS order, not server order.
    expect(blocks.map((b) => b.field)).toEqual([
      "about",
      "products",
      "markets",
      "channels",
    ]);
    const products = blocks.find((b) => b.field === "products")!;
    expect(products).toMatchObject({
      label: "Products",
      kind: "list",
      tierWord: "Check",
      saved: ["Menus"],
      candidates: [{ id: "c_bbbbbbbbbb", text: "Stands", pending: true }],
    });
    expect(blocks[0]).toMatchObject({ kind: "text", tierWord: "Found" });
    expect(blocks.find((b) => b.field === "markets")?.tierWord).toBe(
      "Not found",
    );
    expect(blocks.find((b) => b.field === "channels")?.showTier).toBe(false);
  });

  it("an unsaved row with suggestions reads Suggested, and Add all lists every open one", () => {
    const v = view({
      status: "READY",
      rows: [
        row({
          field: "voice",
          tier: "assumed",
          score: 70,
          saved: [],
          candidates: [
            { id: "c_aaaaaaaaaa", text: "Warm", score: 70, added: false },
            { id: "c_bbbbbbbbbb", text: "Clear", score: 60, added: true },
          ],
        }),
        row({
          field: "audience",
          tier: "unknown",
          score: 0,
          saved: [],
          candidates: [
            { id: "c_cccccccccc", text: "Families", score: 70, added: false },
          ],
        }),
      ],
    });
    expect(rowBlocks(v).find((b) => b.field === "voice")?.tierWord).toBe(
      "Suggested",
    );
    expect(pendingCandidateIds(v)).toEqual(["c_aaaaaaaaaa", "c_cccccccccc"]);
  });

  it("rowBlocks of a view with no rows is empty", () => {
    expect(rowBlocks(view({ status: "READY" }))).toEqual([]);
  });

  it("identityBlock reads counts only", () => {
    expect(identityBlock(null)).toBeNull();
    expect(
      identityBlock({ logo: false, colors: 0, fonts: 0, style: false }),
    ).toBeNull();
    expect(
      identityBlock({ logo: true, colors: 3, fonts: 1, style: true }),
    ).toEqual({
      lines: ["Logo found", "3 colors", "1 font", "Style noted"],
    });
  });

  it("summaryLine counts tiers", () => {
    const rows: Row[] = [
      ...[
        "about",
        "audience",
        "voice",
        "positioning",
        "markets",
        "competitors",
        "services",
      ].map((field) => row({ field: field as Row["field"], saved: ["x"] })),
      row({
        field: "products",
        tier: "assumed",
        candidates: [cand("c_aaaaaaaaaa", "A")],
      }),
      row({ field: "channels", saved: ["Instagram"] }),
    ];
    expect(summaryLine(view({ rows }))).toBe("7 things found · 1 to check");
    const two = [...rows];
    two.push(
      row({
        field: "about",
        tier: "assumed",
        candidates: [cand("c_bbbbbbbbbb", "B")],
      }),
    );
    expect(summaryLine(view({ rows: two }))).toContain("2 to check");
  });

  it("summaryLine: singular, only-check, nothing, taken assumptions", () => {
    expect(
      summaryLine(view({ rows: [row({ field: "about", saved: ["x"] })] })),
    ).toBe("1 thing found");
    expect(
      summaryLine(
        view({
          rows: [
            row({
              field: "about",
              tier: "assumed",
              candidates: [cand("c_aaaaaaaaaa", "A")],
            }),
          ],
        }),
      ),
    ).toBe("1 to check");
    expect(summaryLine(view())).toBe("Nothing found yet");
    expect(
      summaryLine(
        view({
          rows: [
            row({
              field: "products",
              tier: "assumed",
              saved: ["A"],
              candidates: [cand("c_aaaaaaaaaa", "A", true)],
            }),
          ],
        }),
      ),
    ).toBe("1 thing found");
    expect(
      summaryLine(
        view({ rows: [row({ field: "about", tier: "unknown", score: 10 })] }),
      ),
    ).toBe("Nothing found yet");
  });
});

describe("announcementOf", () => {
  it("is silent on the first load", () => {
    expect(announcementOf(null, view({ status: "READY" }))).toBe("");
    expect(announcementOf(null, null)).toBe("");
  });

  it("announces ready, failed and confirmed transitions", () => {
    const running = view();
    expect(announcementOf(running, view({ status: "READY" }))).toBe(
      "Your brand profile is ready.",
    );
    expect(announcementOf(running, view({ status: "FAILED" }))).toBe(
      "Setup stopped before it finished.",
    );
    expect(
      announcementOf(view({ status: "READY" }), view({ status: "CONFIRMED" })),
    ).toBe("Workspace ready.");
  });

  it("announces a stage that just finished, the latest one", () => {
    expect(
      announcementOf(
        view({ stages: stages({ site: "running" }) }),
        view({ stages: stages({ site: "done", identity: "running" }) }),
      ),
    ).toBe("Website read.");
    expect(
      announcementOf(
        view({ stages: stages({ site: "done", identity: "running" }) }),
        view({
          stages: stages({
            site: "done",
            identity: "done",
            research: "running",
          }),
        }),
      ),
    ).toBe("Logo, colors and fonts found.");
    expect(
      announcementOf(
        view({ stages: stages({ site: "running" }) }),
        view({ stages: stages({ site: "done", identity: "done" }) }),
      ),
    ).toBe("Logo, colors and fonts found.");
  });

  it("is silent when nothing meaningful changed", () => {
    expect(announcementOf(view(), view({ rev: "rev000000002" }))).toBe("");
    expect(
      announcementOf(
        view({ stages: stages({ site: "pending" }) }),
        view({ stages: stages({ site: "running" }) }),
      ),
    ).toBe("");
    // skipped is not finished.
    expect(
      announcementOf(
        view({ stages: stages({ identity: "running" }) }),
        view({ stages: stages({ identity: "skipped" }) }),
      ),
    ).toBe("");
    expect(
      announcementOf(view({ status: "FAILED" }), view({ status: "RUNNING" })),
    ).toBe("");
  });
});
