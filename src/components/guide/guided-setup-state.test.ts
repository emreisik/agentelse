import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  APPLY_UI,
  BUSINESS_KINDS_MORE,
  BUSINESS_KINDS_PRIMARY,
  EMPTY_IDEA_OPTIONS,
  POLL,
  type Answers,
  type ApplyResult,
  type GuidedSetupHost,
  type GuidedSetupView,
  type IdeaOptions,
  type IdeasView,
  type StepId,
} from "@/lib/guided-setup/contract";

import {
  announcementOf,
  applyOutcomeAction,
  approveHint,
  canApprove,
  canBack,
  canClose,
  canContinue,
  guidedSetupReducer,
  headerViewOf,
  ideasLineOf,
  initialModel,
  panelViewOf,
  progressOf,
  reviewRowsOf,
  runApprove,
  saveBody,
  skipLabelOf,
  stepsOf,
  summaryOf,
  type Action,
  type Model,
  type PanelView,
} from "./guided-setup-state";

// -----------------------------------------------------------------------------
// Fixtures
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

const opt = (id: string, label: string) => ({
  id,
  label,
  ai: true as const,
});

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

const hydrated = (over: Partial<GuidedSetupView> = {}, model = init()): Model =>
  run(model, { type: "hydrated", view: view(over) });

const pick = (id: string): Action => ({ type: "pick", id });
const next: Action = { type: "next" };
const skip: Action = { type: "skip" };
const back: Action = { type: "back" };

// Answers the five main questions from the static lists, in the default order.
const ANSWER_ALL: Action[] = [
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
];

// The same five answers on a project whose ideas are ready (business is the
// confirm card, audience the ideas list).
const ANSWER_ALL_IDEAS: Action[] = [
  pick("goal.sales"),
  next,
  pick("channel.instagram"),
  next,
  { type: "confirmYes" },
  pick("o_bbbbbbbbbb"),
  next,
  pick("tone.friendly"),
  next,
];

const panel = <K extends PanelView["kind"]>(
  model: Model,
  kind: K,
): Extract<PanelView, { kind: K }> => {
  const v = panelViewOf(model);
  expect(v.kind).toBe(kind);
  return v as Extract<PanelView, { kind: K }>;
};

const filled = (model: Model): number =>
  headerViewOf(model).segments.main.filter((s) => s !== "todo").length;

const okResult: Extract<ApplyResult, { ok: true }> = {
  ok: true,
  parts: ["profile", "goal"],
  unchanged: false,
  goalMode: "proposed",
  unconnected: [],
};

// -----------------------------------------------------------------------------
// G39: the core rules
// -----------------------------------------------------------------------------

describe("initial model (G39)", () => {
  it("has zero picks and Continue is off", () => {
    const model = init();
    expect(model.answers).toEqual({});
    expect(model.step).toBe("goal");
    expect(canContinue(model)).toBe(false);
    const v = panel(model, "question");
    expect(v.rows.length).toBe(5);
    expect(v.rows.every((r) => !r.selected)).toBe(true);
    expect(v.footer.canContinue).toBe(false);
  });

  it("starts on the business question for a project with no website", () => {
    const model = init({ seedFirst: true });
    expect(model.step).toBe("business");
    const v = panel(model, "question");
    expect(v.tier).toEqual({ current: 1, switchLabel: "More types" });
  });

  it("a first visit renders the first question at once; a returning project a skeleton, never question 1", () => {
    expect(panelViewOf(init()).kind).toBe("question");
    const returning = init({
      summary: {
        status: "OPEN",
        answered: 2,
        total: 5,
        position: 3,
        started: true,
        hasProfile: false,
      },
    });
    expect(panelViewOf(returning)).toEqual({ kind: "boot" });
    // Nothing the person taps reaches a hidden question 1.
    expect(run(returning, pick("goal.sales"), next).answers).toEqual({});
    expect(announcementOf(returning)).toBe("");
  });
});

describe("picking (G39)", () => {
  it("a single pick replaces the previous one", () => {
    let model = hydrated();
    model = run(model, pick("goal.sales"), pick("goal.leads"));
    expect(model.answers.goal).toEqual({ picked: ["goal.leads"] });
    expect(panel(model, "question").rows.filter((r) => r.selected)).toHaveLength(1);
    // Tapping the chosen row again keeps it (no radio deselect).
    expect(run(model, pick("goal.leads")).answers.goal).toEqual({
      picked: ["goal.leads"],
    });
    // Continue does nothing until something is picked.
    expect(run(hydrated(), next).step).toBe("goal");
  });

  it("opening Other on a single question clears the pick; picking again closes Other", () => {
    let model = run(hydrated(), skip, skip, pick("kind.food"));
    expect(model.step).toBe("business");
    model = run(model, { type: "toggleOther" });
    expect(model.answers.business).toBeUndefined();
    expect(model.otherOpen).toBe(true);
    model = run(model, { type: "otherText", text: "Family bakery" });
    expect(model.answers.business).toEqual({
      picked: [],
      other: "Family bakery",
    });
    expect(canContinue(model)).toBe(true);
    // A tap on a row replaces the typed words.
    model = run(model, pick("kind.shop"));
    expect(model.answers.business).toEqual({ picked: ["kind.shop"] });
    expect(model.otherOpen).toBe(false);
  });

  it("a multi question toggles and ignores taps past the maximum", () => {
    let model = run(hydrated(), skip);
    expect(model.step).toBe("channels");
    model = run(
      model,
      pick("channel.instagram"),
      pick("channel.tiktok"),
      pick("channel.linkedin"),
    );
    expect(model.answers.channels?.picked).toHaveLength(3);
    const seq = model.editSeq;
    model = run(model, pick("channel.x"));
    expect(model.answers.channels?.picked).toEqual([
      "channel.instagram",
      "channel.tiktok",
      "channel.linkedin",
    ]);
    // An ignored tap is not an edit.
    expect(model.editSeq).toBe(seq);
    const v = panel(model, "question");
    expect(v.count).toEqual({ picked: 3, max: 3 });
    expect(v.rows.filter((r) => r.disabled).map((r) => r.id)).toEqual([
      "channel.x",
      "channel.seo",
      "channel.ads",
    ]);
    model = run(model, pick("channel.tiktok"));
    expect(model.answers.channels?.picked).toEqual([
      "channel.instagram",
      "channel.linkedin",
    ]);
  });

  it("a typed Other counts toward the multi maximum", () => {
    let model = run(hydrated(), skip, skip, skip);
    expect(model.step).toBe("audience");
    model = run(
      model,
      pick("audience.local"),
      { type: "toggleOther" },
      {
        type: "otherText",
        text: "Students",
      },
    );
    expect(model.answers.audience).toEqual({
      picked: ["audience.local"],
      other: "Students",
    });
    // Two of two: a third pick is refused.
    const same = run(model, pick("audience.online"));
    expect(same.answers.audience).toEqual(model.answers.audience);
    // And Other cannot be opened when the picks fill the question.
    const full = run(
      hydrated(),
      skip,
      skip,
      skip,
      pick("audience.local"),
      pick("audience.online"),
      { type: "toggleOther" },
    );
    expect(full.otherOpen).toBe(false);
  });

  it("ignores an id that is not on screen", () => {
    const model = run(hydrated(), pick("channel.instagram"));
    expect(model.answers).toEqual({});
  });

  it("clips typed words to the question's cap by code points", () => {
    let model = run(hydrated(), skip, skip, { type: "toggleOther" });
    model = run(model, { type: "otherText", text: "😀".repeat(200) });
    expect(Array.from(model.answers.business?.other ?? "")).toHaveLength(140);
  });
});

describe("no auto-advance (G39)", () => {
  it("picking never moves the step; only Continue and the confirm buttons do", () => {
    let model = hydrated();
    model = run(model, pick("goal.sales"));
    expect(model.step).toBe("goal");
    model = run(model, next);
    expect(model.step).toBe("channels");

    // The confirm card: Yes picks AND advances in one tap.
    let confirm = hydrated({ ideas: READY });
    confirm = run(confirm, skip, skip);
    expect(confirm.step).toBe("business");
    expect(panelViewOf(confirm).kind).toBe("confirm");
    confirm = run(confirm, { type: "confirmYes" });
    expect(confirm.answers.business).toEqual({ picked: ["o_aaaaaaaaaa"] });
    expect(confirm.step).toBe("audience");
  });

  it("checkpoint buttons advance in one tap", () => {
    const model = run(hydrated(), ...ANSWER_ALL);
    expect(model.step).toBe("checkpoint");
    expect(run(model, { type: "reviewNow" }).step).toBe("review");
  });
});

describe("skip, defer and back", () => {
  it("skip stores skipped and moves on; nothing is persisted as an answer", () => {
    const model = run(hydrated(), skip);
    expect(model.answers.goal).toEqual({ picked: [], skipped: true });
    expect(model.step).toBe("channels");
  });

  it("back keeps the answers and goes to the previous step", () => {
    let model = run(
      hydrated(),
      pick("goal.sales"),
      next,
      pick("channel.x"),
      back,
    );
    expect(model.step).toBe("goal");
    expect(model.answers.goal).toEqual({ picked: ["goal.sales"] });
    expect(model.answers.channels).toEqual({ picked: ["channel.x"] });
    expect(
      panel(model, "question").rows.find((r) => r.id === "goal.sales")
        ?.selected,
    ).toBe(true);
    // No previous step on the first one.
    model = run(model, back);
    expect(model.step).toBe("goal");
    expect(canBack(model)).toBe(false);
  });

  it("goTo from review returns to review after Continue", () => {
    let model = run(hydrated(), ...ANSWER_ALL, { type: "reviewNow" });
    expect(model.step).toBe("review");
    model = run(model, { type: "goTo", step: "tone" });
    expect(model.step).toBe("tone");
    expect(model.returnTo).toBe("review");
    model = run(model, pick("tone.premium"), next);
    expect(model.step).toBe("review");
    expect(model.returnTo).toBeNull();
    expect(model.answers.tone).toEqual({ picked: ["tone.premium"] });
  });

  it("a step outside the flow is refused", () => {
    const model = run(hydrated(), ...ANSWER_ALL, { type: "reviewNow" });
    expect(run(model, { type: "goTo", step: "angle" }).step).toBe("review");
  });
});

// -----------------------------------------------------------------------------
// G79: boot and hydration
// -----------------------------------------------------------------------------

describe("boot and hydration (G79)", () => {
  it("Continue during boot advances locally and queues a save", () => {
    let model = init();
    expect(model.phase).toBe("booting");
    model = run(model, pick("goal.sales"), next);
    expect(model.step).toBe("channels");
    expect(model.editSeq).toBeGreaterThan(0);
    expect(model.save).toBe("saving");
    expect(saveBody(model)).toEqual({
      action: "save",
      step: "channels",
      more: false,
      answers: { goal: { picked: ["goal.sales"] } },
    });
  });

  it("Skip and Back are not blocked by boot either", () => {
    let model = run(init(), skip, skip);
    expect(model.step).toBe("business");
    model = run(model, back);
    expect(model.step).toBe("channels");
  });

  it("a pick made during boot survives `hydrated`; the server's rev, ideas and current are taken", () => {
    let model = run(init(), pick("goal.sales"), next);
    const before = model.editSeq;
    model = run(model, {
      type: "hydrated",
      view: view({
        rev: "srv999",
        ideas: READY,
        current: { identity: "A bakery" },
        answers: {},
        step: "goal",
        staticFirst: true,
      }),
    });
    expect(model.phase).toBe("ready");
    expect(model.answers.goal).toEqual({ picked: ["goal.sales"] });
    expect(model.step).toBe("channels");
    expect(model.rev).toBe("srv999");
    expect(model.ideas?.status).toBe("READY");
    expect(model.view?.current.identity).toBe("A bakery");
    expect(model.staticFirst).toBe(true);
    // A save goes out so the server catches up.
    expect(model.editSeq).toBeGreaterThan(before);
    expect(model.save).toBe("saving");
  });

  it("an untouched model takes the server's answers, step and more", () => {
    const answers: Answers = {
      goal: { picked: ["goal.leads"] },
      channels: { picked: ["channel.linkedin"] },
    };
    const model = hydrated({ answers, step: "business", more: false });
    expect(model.answers).toEqual(answers);
    expect(model.step).toBe("business");
    expect(model.touched).toBe(false);
    expect(model.save).toBe("idle");
  });

  it("clamps a stale saved step", () => {
    // "angle" is not in the flow: no options and `more` is off.
    const model = hydrated({
      step: "angle",
      answers: { goal: { picked: ["goal.leads"] } },
    });
    expect(stepsOf(model)).not.toContain("angle");
    expect(model.step).toBe("channels");
  });

  it("clamps a local step that is no longer in the flow when hydrating over local state", () => {
    let model = run(init(), pick("goal.sales"), next);
    model = run(model, { type: "hydrated", view: view({ seedFirst: true }) });
    expect(stepsOf(model)).toContain(model.step);
  });

  it("a local step that is no longer in the flow is clamped when the server answers", () => {
    const local = run(init(), pick("goal.sales"), next);
    // Defensive: the flow never leaves a booting person on a detail step, but a
    // stale step must never survive a hydration.
    const stale: Model = { ...local, step: "angle" };
    const model = run(stale, { type: "hydrated", view: view() });
    expect(stepsOf(model)).toContain(model.step);
    expect(model.step).not.toBe("angle");
  });

  it("a DONE session reopens on Review with the saved banner", () => {
    const model = hydrated({
      status: "DONE",
      answers: { goal: { picked: ["goal.sales"] } },
    });
    const v = panel(model, "review");
    expect(v.banner).toBe("saved");
    expect(v.approve.hint).toBe("unchanged");
  });

  it("an established project with nothing begun opens on Review (Update your setup)", () => {
    const model = hydrated({
      hasProfile: true,
      current: { identity: "A QR menu company", goal: "Sales" },
    });
    const v = panel(model, "review");
    const business = v.rows.find((r) => r.question === "business");
    expect(business?.state).toBe("current");
    expect(v.rows.find((r) => r.question === "goal")?.state).toBe("current");
  });

  it("boot errors, unavailable and expired are phases with their own views", () => {
    const failed = run(init(), { type: "bootFailed" });
    expect(panelViewOf(failed)).toEqual({ kind: "bootError" });
    // Typed answers survive a retry.
    const retried = run(failed, { type: "bootRetry" });
    expect(retried.phase).toBe("booting");
    expect(panelViewOf(run(init(), { type: "unavailable" }))).toEqual({
      kind: "unavailable",
    });
    const expired = panelViewOf(run(init(), { type: "expired" }));
    expect(expired).toEqual({
      kind: "expired",
      href: "/login?callbackUrl=%2Fprojects%2Fp1%3Fguide%3Dsetup",
    });
  });

  it("a reload after STALE takes the server state over local edits", () => {
    let model = hydrated({ rev: "r1" });
    model = run(model, pick("goal.sales"));
    model = run(model, {
      type: "hydrated",
      reload: true,
      view: view({ rev: "r2", answers: { goal: { picked: ["goal.leads"] } } }),
    });
    expect(model.answers.goal).toEqual({ picked: ["goal.leads"] });
    expect(model.rev).toBe("r2");
    expect(model.touched).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Frozen lists, ideas, strip and banner (G39, G80)
// -----------------------------------------------------------------------------

describe("frozen lists (G39)", () => {
  it("a list frozen to the catalog is not changed by ideas landing", () => {
    let model = run(hydrated({ ideas: ideasView() }), skip, skip, skip);
    expect(model.step).toBe("audience");
    expect(model.lists.audience).toBe("static");
    const before = panel(model, "question").rows.map((r) => r.id);
    model = run(model, { type: "ideasUpdated", ideas: READY, from: "poll" });
    expect(model.lists.audience).toBe("static");
    expect(panel(model, "question").rows.map((r) => r.id)).toEqual(before);
  });

  it("a list frozen to the ideas is not changed by different ideas", () => {
    const model = run(hydrated({ ideas: READY }), skip, skip, skip);
    expect(model.lists.audience).toBe("ideas");
    const other: IdeasView = {
      ...READY,
      options: {
        ...READY_OPTIONS,
        audience: [opt("o_eeeeeeeeee", "Somebody else")],
      },
    };
    const after = run(model, {
      type: "ideasUpdated",
      ideas: other,
      from: "poll",
    });
    expect(panel(after, "question").rows.map((r) => r.id)).toEqual([
      "o_bbbbbbbbbb",
      "o_dddddddddd",
    ]);
  });

  it("the ready strip only shows on a list frozen to the ideas", () => {
    const ideasFrozen = run(hydrated({ ideas: READY }), skip, skip, skip);
    expect(panel(ideasFrozen, "question").strip).toEqual({
      kind: "ready",
      source: "discovery",
      host: "qrhubmenu.com",
    });
    const staticFrozen = run(
      hydrated({ ideas: ideasView() }),
      skip,
      skip,
      skip,
      { type: "ideasUpdated", ideas: READY, from: "poll" },
    );
    expect(panel(staticFrozen, "question").strip).toBeNull();
    // A profile source says so.
    const profile = run(
      hydrated({ ideas: { ...READY, source: "profile" } }),
      skip,
      skip,
      skip,
    );
    expect(panel(profile, "question").strip).toEqual({
      kind: "ready",
      source: "profile",
      host: "qrhubmenu.com",
    });
  });

  it("strip.empty when a ready run left a research-fed question empty", () => {
    const ideas: IdeasView = {
      ...READY,
      options: {
        business: [opt("o_aaaaaaaaaa", "A QR menu")],
        audience: [],
        angle: [],
      },
    };
    const model = run(hydrated({ ideas }), skip, skip, skip);
    expect(model.step).toBe("audience");
    expect(model.lists.audience).toBe("static");
    const v = panel(model, "question");
    expect(v.strip).toEqual({ kind: "empty" });
    expect(v.banner).toBeNull();
    // Everything empty: the header line says so.
    const none = hydrated({
      ideas: { ...READY, options: EMPTY_IDEA_OPTIONS },
    });
    expect(ideasLineOf(none)).toMatchObject({ kind: "ready", empty: true });
  });

  it("'Suggestions ready' shows with a pick present after Back, and Show keeps a pick that exists in the new list", () => {
    let model = run(
      hydrated({ ideas: ideasView() }),
      skip,
      skip,
      skip,
      pick("audience.local"),
      next,
    );
    model = run(
      model,
      { type: "ideasUpdated", ideas: READY, from: "poll" },
      back,
    );
    expect(model.step).toBe("audience");
    let v = panel(model, "question");
    expect(v.banner).toBe("suggestions_ready");
    expect(v.rows.find((r) => r.id === "audience.local")?.selected).toBe(true);

    const focusBefore = model.focus.seq;
    model = run(model, { type: "showSuggestions" });
    expect(model.lists.audience).toBe("ideas");
    // The static pick is not in the ideas list: cleared, and the notice says so.
    expect(model.answers.audience).toBeUndefined();
    expect(model.inline).toEqual({ kind: "pickCleared" });
    expect(model.focus.seq).toBe(focusBefore + 1);
    v = panel(model, "question");
    expect(v.banner).toBeNull();
    expect(v.inline).toEqual({ kind: "pickCleared" });
    expect(v.rows.map((r) => r.ai)).toEqual([true, true]);

    // A pick that DOES exist in the new list is kept.
    const kept = run(
      hydrated({ ideas: READY }),
      skip,
      skip,
      skip,
      pick("o_bbbbbbbbbb"),
      next,
      back,
    );
    expect(kept.answers.audience).toEqual({ picked: ["o_bbbbbbbbbb"] });
  });

  it("Show is a no-op when no banner is showing", () => {
    const model = hydrated();
    expect(run(model, { type: "showSuggestions" })).toBe(model);
  });

  it("Not quite switches the confirm card to the catalog and is not offered again", () => {
    let model = run(hydrated({ ideas: READY }), skip, skip);
    expect(panelViewOf(model).kind).toBe("confirm");
    model = run(model, { type: "confirmNo" });
    const v = panel(model, "question");
    expect(v.rows.map((r) => r.id)).toEqual(
      BUSINESS_KINDS_PRIMARY.map((k) => k.id),
    );
    expect(v.banner).toBeNull();
    expect(model.lists.business).toBe("static");
    // Even after a static answer, the checkpoint does not push it again.
    model = run(model, pick("kind.food"), next, skip, skip);
    expect(model.step).toBe("checkpoint");
    expect(model.answers.business).toEqual({ picked: ["kind.food"] });
    expect(panel(model, "checkpoint").suggestions).toBeNull();
  });
});

describe("pending list while a run is in flight", () => {
  it("shows a skeleton, stays usable and 'Skip for now' defers the question", () => {
    let model = run(hydrated({ ideas: RUNNING }), skip, skip);
    expect(model.step).toBe("business");
    const v = panel(model, "question");
    expect(v.skeleton).toBe(true);
    expect(v.rows).toEqual([]);
    expect(v.tier).toBeNull();
    expect(v.other).toEqual({ open: false, text: "", max: 140 });
    expect(v.footer.skip).toBe("Skip for now");
    expect(model.lists.business).toBeUndefined();

    // Typing works while it is pending.
    const typed = run(
      model,
      { type: "toggleOther" },
      {
        type: "otherText",
        text: "A bakery",
      },
    );
    expect(canContinue(typed)).toBe(true);

    model = run(model, skip);
    expect(model.answers.business).toEqual({ picked: [], deferred: true });
  });

  it("the pending step decides its list when the run ends", () => {
    let model = run(hydrated({ ideas: RUNNING }), skip, skip);
    model = run(model, { type: "ideasUpdated", ideas: READY, from: "poll" });
    expect(model.lists.business).toBe("ideas");
    expect(panelViewOf(model).kind).toBe("confirm");

    let failed = run(hydrated({ ideas: RUNNING }), skip, skip);
    failed = run(failed, {
      type: "ideasUpdated",
      ideas: ideasView({ status: "FAILED", reason: "failed", canRetry: true }),
      from: "poll",
    });
    expect(failed.lists.business).toBe("static");
    expect(panel(failed, "question").skeleton).toBe(false);
  });
});

describe("catch-up (G39)", () => {
  function deferBoth(): Model {
    // Default order: goal, channels, business, audience, tone.
    return run(
      hydrated({ ideas: RUNNING }),
      pick("goal.sales"),
      next,
      pick("channel.instagram"),
      next,
      skip, // business: Skip for now -> deferred
      skip, // audience: Skip for now -> deferred
      pick("tone.friendly"),
    );
  }

  it("offers a deferred question once more, with the ideas list and no step number", () => {
    let model = deferBoth();
    expect(model.answers.business?.deferred).toBe(true);
    expect(model.answers.audience?.deferred).toBe(true);
    model = run(model, { type: "ideasUpdated", ideas: READY, from: "poll" });
    model = run(model, next);
    expect(model.step).toBe("business");
    expect(model.catchUp).toBe(true);
    expect(model.lists.business).toBe("ideas");
    expect(progressOf(model)).toMatchObject({
      group: "catchup",
      assistive: "Suggestions ready",
    });
    expect(announcementOf(model)).toBe("Suggestions are ready.");
    expect(filled(model)).toBe(5);

    model = run(model, { type: "confirmYes" });
    // The second deferred question follows, then the checkpoint.
    expect(model.step).toBe("audience");
    expect(model.catchUp).toBe(true);
    model = run(model, pick("o_bbbbbbbbbb"), next);
    expect(model.step).toBe("checkpoint");
    expect(model.answers.audience).toEqual({ picked: ["o_bbbbbbbbbb"] });
  });

  it("answering the only catch-up question after skipping the rest lands on the checkpoint, not Review", () => {
    const onlyBusiness: IdeasView = {
      ...READY,
      options: { business: READY_OPTIONS.business, audience: [], angle: [] },
    };
    let model = run(
      hydrated({ ideas: RUNNING }),
      skip, // goal
      skip, // channels
      skip, // business: deferred
      skip, // audience: deferred
      { type: "ideasUpdated", ideas: onlyBusiness, from: "poll" },
      skip, // tone
    );
    expect(model.step).toBe("business");
    expect(model.catchUp).toBe(true);
    model = run(model, { type: "confirmYes" });
    expect(model.answers.business).toEqual({ picked: ["o_aaaaaaaaaa"] });
    expect(model.step).toBe("checkpoint");
  });

  it("a second skip on the catch-up stores skipped, not deferred, and it is not offered again", () => {
    let model = run(
      deferBoth(),
      { type: "ideasUpdated", ideas: READY, from: "poll" },
      next,
    );
    expect(model.step).toBe("business");
    expect(skipLabelOf(model)).toBe("Skip");
    model = run(model, skip);
    expect(model.answers.business).toEqual({ picked: [], skipped: true });
    model = run(model, skip);
    expect(model.answers.audience).toEqual({ picked: [], skipped: true });
    expect(model.step).toBe("checkpoint");
    // Going back and forward again does not offer it a third time.
    const again = run(model, back, next);
    expect(again.catchUp).toBe(false);
  });

  it("deferred questions whose ideas never landed become skipped silently at Review", () => {
    const model = run(deferBoth(), next);
    expect(model.step).toBe("checkpoint");
    const review = run(model, { type: "reviewNow" });
    expect(review.answers.business).toEqual({ picked: [], skipped: true });
    expect(review.answers.audience).toEqual({ picked: [], skipped: true });
  });
});

describe("the ideas line and step order (G80)", () => {
  it("the offer appears right after a saved business answer on a project with no website", () => {
    let model = hydrated({
      seedFirst: true,
      brand: { name: "Qr Hub Menu", host: null, languageCode: "en" },
      ideas: ideasView({
        status: "UNAVAILABLE",
        reason: "no_input",
        canStart: false,
      }),
    });
    expect(model.step).toBe("business");
    expect(ideasLineOf(model)).toEqual({ kind: "note", note: "no_input" });
    model = run(model, pick("kind.food"), next);
    const seq = model.editSeq;
    model = run(model, {
      type: "saved",
      seq,
      response: {
        rev: "rev002",
        status: "OPEN",
        ideas: ideasView({ canStart: true }),
      },
    });
    expect(ideasLineOf(model)).toEqual({
      kind: "offer",
      host: null,
      noSite: true,
    });
    expect(headerViewOf(model).ideasLine).toEqual(ideasLineOf(model));
    expect(model.rev).toBe("rev002");
  });

  it("the offer, running, retry and notes follow the server's facts", () => {
    const withIdeas = (ideas: IdeasView) => hydrated({ ideas });
    expect(ideasLineOf(withIdeas(ideasView()))).toMatchObject({
      kind: "offer",
      host: "qrhubmenu.com",
      noSite: false,
    });
    expect(
      ideasLineOf(
        withIdeas(
          ideasView({ status: "RUNNING", ageSec: POLL.slowAfterSec - 1 }),
        ),
      ),
    ).toEqual({ kind: "running", host: "qrhubmenu.com", slow: false });
    expect(
      ideasLineOf(
        withIdeas(ideasView({ status: "RUNNING", ageSec: POLL.slowAfterSec })),
      ),
    ).toEqual({ kind: "running", host: "qrhubmenu.com", slow: true });
    expect(
      ideasLineOf(
        withIdeas(
          ideasView({ status: "FAILED", reason: "timeout", canRetry: true }),
        ),
      ),
    ).toEqual({ kind: "retry", reason: "timeout" });
    expect(
      ideasLineOf(
        withIdeas(
          ideasView({ status: "FAILED", reason: "failed", canRetry: false }),
        ),
      ),
    ).toEqual({ kind: "note", note: "exhausted" });
    expect(
      ideasLineOf(
        withIdeas(
          ideasView({ status: "UNAVAILABLE", reason: "off", canStart: false }),
        ),
      ),
    ).toBeNull();
    expect(
      ideasLineOf(
        withIdeas(
          ideasView({
            status: "UNAVAILABLE",
            reason: "limit",
            canStart: false,
          }),
        ),
      ),
    ).toEqual({ kind: "note", note: "limit" });
    expect(
      ideasLineOf(
        withIdeas(
          ideasView({ status: "UNAVAILABLE", reason: "mock", canStart: false }),
        ),
      ),
    ).toEqual({ kind: "note", note: "mock" });
    expect(ideasLineOf(init())).toBeNull();
  });

  it("an idle line that cannot start shows nothing", () => {
    expect(ideasLineOf(hydrated({ ideas: ideasView({ canStart: false }) }))).toBeNull();
  });

  it("the client's own words ride on the offer", () => {
    const model = hydrated({ seed: "Plan the setup for Qr Hub" });
    expect(ideasLineOf(model)).toMatchObject({
      seed: "Plan the setup for Qr Hub",
    });
  });

  it.each([
    [false, false, ["goal", "channels", "business", "audience", "tone"]],
    [false, true, ["goal", "channels", "tone", "business", "audience"]],
    [true, false, ["business", "goal", "channels", "audience", "tone"]],
    [true, true, ["business", "goal", "channels", "tone", "audience"]],
  ] as const)(
    "seedFirst=%s staticFirst=%s -> %j",
    (seedFirst, staticFirst, order) => {
      const model = hydrated({ seedFirst, staticFirst });
      expect(stepsOf(model)).toEqual([...order, "checkpoint", "review"]);
      expect(model.step).toBe(order[0]);
    },
  );

  it("a discover result moves focus to the strip", () => {
    const model = hydrated();
    const after = run(model, {
      type: "ideasUpdated",
      ideas: ideasView({ status: "RUNNING", canStart: false }),
      from: "discover",
    });
    expect(after.focus).toEqual({ target: "strip", seq: model.focus.seq + 1 });
    const poll = run(model, {
      type: "ideasUpdated",
      ideas: ideasView({ status: "RUNNING", canStart: false }),
      from: "poll",
    });
    expect(poll.focus.seq).toBe(model.focus.seq);
  });

  it("a failed discover call is an inline notice with Try again, cleared by the next result", () => {
    let model = run(hydrated(), { type: "discoverFailed" });
    expect(model.inline).toEqual({ kind: "discover", retry: true });
    model = run(model, {
      type: "ideasUpdated",
      ideas: RUNNING,
      from: "discover",
    });
    expect(model.inline).toBeNull();
  });

  it("the checkpoint and Review offer 'Look' after a static answer, and Look shows the ideas list", () => {
    let model = run(
      hydrated({ ideas: ideasView() }),
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
    );
    expect(model.step).toBe("checkpoint");
    expect(panel(model, "checkpoint").suggestions).toBeNull();
    model = run(model, { type: "ideasUpdated", ideas: READY, from: "poll" });
    expect(panel(model, "checkpoint").suggestions).toEqual({
      questions: ["What Qr Hub Menu does", "Audience"],
    });
    const seq = model.focus.seq;
    model = run(model, { type: "look" });
    expect(model.step).toBe("business");
    expect(model.lists.business).toBe("ideas");
    expect(model.returnTo).toBe("checkpoint");
    expect(model.focus).toEqual({ target: "title", seq: seq + 1 });
    // The static pick is not in the ideas list: cleared, with the notice.
    expect(model.inline).toEqual({ kind: "pickCleared" });
    model = run(model, { type: "confirmYes" });
    expect(model.step).toBe("checkpoint");
    // Only audience is left to look at, and Review shows the same row.
    expect(panel(model, "checkpoint").suggestions).toEqual({
      questions: ["Audience"],
    });
    const review = run(model, { type: "reviewNow" });
    expect(panel(review, "review").suggestions).toEqual({
      questions: ["Audience"],
    });
  });

  it("Look on Review returns to Review", () => {
    let model = run(
      hydrated({ ideas: ideasView() }),
      ...ANSWER_ALL,
      { type: "reviewNow" },
      { type: "ideasUpdated", ideas: READY, from: "poll" },
      { type: "look" },
    );
    expect(model.returnTo).toBe("review");
    expect(model.step).toBe("business");
    model = run(model, { type: "confirmYes" });
    expect(model.step).toBe("review");
  });
});

// -----------------------------------------------------------------------------
// G81: business tiers, footer labels, review states
// -----------------------------------------------------------------------------

describe("business tiers and footer labels (G81)", () => {
  it("shows six rows per tier and swaps with the tier row", () => {
    let model = run(hydrated(), skip, skip);
    let v = panel(model, "question");
    expect(v.rows).toHaveLength(6);
    expect(v.rows.map((r) => r.id)).toEqual(
      BUSINESS_KINDS_PRIMARY.map((k) => k.id),
    );
    expect(v.tier).toEqual({ current: 1, switchLabel: "More types" });
    model = run(model, { type: "tier" });
    v = panel(model, "question");
    expect(v.rows).toHaveLength(6);
    expect(v.rows.map((r) => r.id)).toEqual(
      BUSINESS_KINDS_MORE.map((k) => k.id),
    );
    expect(v.tier).toEqual({ current: 2, switchLabel: "Common types" });
    // The tier is local UI state: it is not a saved edit.
    expect(model.editSeq).toBe(run(hydrated(), skip, skip).editSeq);
  });

  it("revisiting opens the tier that holds the pick, or the field holding typed words", () => {
    let model = run(
      hydrated(),
      skip,
      skip,
      { type: "tier" },
      pick("kind.creator"),
      next,
      back,
    );
    expect(model.step).toBe("business");
    let v = panel(model, "question");
    expect(v.tier?.current).toBe(2);
    expect(v.rows.find((r) => r.id === "kind.creator")?.selected).toBe(true);

    model = run(
      hydrated(),
      skip,
      skip,
      { type: "toggleOther" },
      { type: "otherText", text: "Family bakery" },
      next,
      back,
    );
    v = panel(model, "question");
    expect(v.tier?.current).toBe(1);
    expect(v.other).toEqual({ open: true, text: "Family bakery", max: 140 });
  });

  it("revisiting the AI candidate shows the confirm card with Yes marked", () => {
    const model = run(
      hydrated({ ideas: READY }),
      skip,
      skip,
      { type: "confirmYes" },
      back,
    );
    const v = panel(model, "confirm");
    expect(v.candidate).toEqual({
      id: "o_aaaaaaaaaa",
      text: "A QR menu for cafes",
      selected: true,
    });
    expect(v.title).toBe("Is this what Qr Hub Menu does?");
  });

  it("the footer Skip reads 'Not sure, you decide' only where the question delegates", () => {
    const at = (step: StepId) => {
      let model = hydrated({ more: true, ideas: READY });
      model = { ...model, step };
      return skipLabelOf(model);
    };
    expect(at("goal")).toBe("Skip");
    expect(at("channels")).toBe("Skip");
    expect(at("business")).toBe("Skip");
    expect(at("audience")).toBe("Not sure, you decide");
    expect(at("tone")).toBe("Not sure, you decide");
    expect(at("angle")).toBe("Not sure, you decide");
    expect(at("guardrails")).toBe("Skip");
  });

  it("in edit mode Back reads 'Back to review', returns without change, and Skip on an answered question reads 'Clear answer'", () => {
    let model = run(hydrated(), ...ANSWER_ALL, { type: "reviewNow" });
    model = run(model, { type: "goTo", step: "goal" });
    let v = panel(model, "question");
    expect(v.footer.back).toBe("Back to review");
    expect(v.footer.skip).toBe("Clear answer");
    const answers = model.answers;
    const back1 = run(model, back);
    expect(back1.step).toBe("review");
    expect(back1.answers).toEqual(answers);
    expect(back1.returnTo).toBeNull();

    // Clear answer stores a skip and returns to Review.
    const cleared = run(model, skip);
    expect(cleared.answers.goal).toEqual({ picked: [], skipped: true });
    expect(cleared.step).toBe("review");

    // An unanswered question in edit mode reads the ordinary label.
    model = run(cleared, { type: "goTo", step: "goal" });
    v = panel(model, "question");
    expect(v.footer.skip).toBe("Skip");
  });

  it("all five skipped goes straight to Review with the skipped-everything state", () => {
    const model = run(hydrated(), skip, skip, skip, skip, skip);
    expect(model.step).toBe("review");
    const v = panel(model, "review");
    expect(v.skippedAll).toBe(true);
    expect(v.approve.hint).toBe("empty");
    expect(canApprove(model)).toBe(false);
    // Back from Review skips the checkpoint too.
    expect(run(model, back).step).toBe("tone");
  });

  it("Review states: delegated for a skipped delegate question, skipped otherwise, current from the profile", () => {
    const model = run(
      hydrated({ current: { audiences: ["Bakers"] } }),
      pick("goal.sales"),
      next,
      skip, // channels: skipped
      skip, // business
      skip, // audience: delegate
      skip, // tone: delegate
    );
    expect(model.step).toBe("checkpoint");
    const review = run(model, { type: "reviewNow" });
    const rows = reviewRowsOf(review);
    const state = (q: string) => rows.find((r) => r.question === q)?.state;
    expect(state("goal")).toBe("answered");
    expect(state("channels")).toBe("skipped");
    expect(state("business")).toBe("skipped");
    // A skip on a delegate question wins over the stored profile value.
    expect(state("audience")).toBe("delegated");
    expect(state("tone")).toBe("delegated");
    const cur = reviewRowsOf(hydrated({ current: { audiences: ["Bakers"] } }));
    expect(cur.find((r) => r.question === "audience")).toMatchObject({
      state: "current",
      chips: [{ text: "Bakers", ai: true }],
    });
  });
});

describe("detail questions", () => {
  it("Add more detail goes to angle when options exist, else guardrails, then Review", () => {
    let model = run(hydrated({ ideas: READY }), ...ANSWER_ALL_IDEAS);
    let v = panel(model, "checkpoint");
    expect(v.detail).toEqual({ count: 2 });
    model = run(model, { type: "addDetail" });
    expect(model.more).toBe(true);
    expect(model.step).toBe("angle");
    expect(model.lists.angle).toBe("ideas");
    expect(headerViewOf(model).segments.detail).toEqual(["current", "todo"]);
    model = run(model, pick("o_cccccccccc"), next);
    expect(model.step).toBe("guardrails");
    expect(headerViewOf(model).segments.detail).toEqual(["done", "current"]);
    model = run(model, pick("guardrail.no_prices"), next);
    expect(model.step).toBe("review");

    const noAngle = run(hydrated(), ...ANSWER_ALL);
    v = panel(noAngle, "checkpoint");
    expect(v.detail).toEqual({ count: 1 });
    expect(run(noAngle, { type: "addDetail" }).step).toBe("guardrails");
  });
});

// -----------------------------------------------------------------------------
// Progress, focus, announcements (G77)
// -----------------------------------------------------------------------------

describe("progress segments never decrease (G39)", () => {
  it("fill only grows through forward, back, edit and review", () => {
    const actions: Action[] = [
      pick("goal.sales"),
      next,
      pick("channel.instagram"),
      next,
      back,
      back,
      next,
      next,
      pick("kind.food"),
      next,
      back,
      pick("kind.shop"),
      next,
      pick("audience.local"),
      next,
      pick("tone.friendly"),
      next,
      back,
      next,
      { type: "reviewNow" },
      { type: "goTo", step: "goal" },
      back,
    ];
    let model = hydrated();
    let previous = filled(model);
    for (const action of actions) {
      model = run(model, action);
      const now = filled(model);
      expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
    }
    expect(model.step).toBe("review");
    expect(previous).toBe(5);
  });

  it("marks the current segment, and the assistive text follows the step", () => {
    let model = hydrated();
    expect(headerViewOf(model).segments.main).toEqual([
      "current",
      "todo",
      "todo",
      "todo",
      "todo",
    ]);
    model = run(model, pick("goal.sales"), next, pick("channel.x"), next, back);
    expect(headerViewOf(model).segments.main).toEqual([
      "done",
      "current",
      "done",
      "todo",
      "todo",
    ]);
    expect(progressOf(model).assistive).toBe("Question 2 of 5");
    expect(headerViewOf(model).segments.detail).toEqual([]);
    expect(headerViewOf(model).title).toBe("Set up Qr Hub Menu");
  });
});

describe("focus intents (G77)", () => {
  const seqOf = (model: Model) => model.focus.seq;

  it.each<[string, (m: Model) => Model, string]>([
    ["next", (m) => run(m, pick("goal.sales"), next), "title"],
    ["skip", (m) => run(m, skip), "title"],
    ["back", (m) => run(run(m, skip), back), "title"],
    [
      "goTo",
      (m) =>
        run(
          m,
          ...ANSWER_ALL,
          { type: "reviewNow" },
          { type: "goTo", step: "goal" },
        ),
      "title",
    ],
    ["reviewNow", (m) => run(m, ...ANSWER_ALL, { type: "reviewNow" }), "title"],
    ["addDetail", (m) => run(m, ...ANSWER_ALL, { type: "addDetail" }), "title"],
  ])("%s bumps the title focus", (_name, act, target) => {
    const model = hydrated();
    const after = act(model);
    expect(after.focus.target).toBe(target);
    expect(seqOf(after)).toBeGreaterThan(seqOf(model));
  });

  it("each navigation bumps by exactly one", () => {
    const model = hydrated();
    expect(seqOf(run(model, skip))).toBe(seqOf(model) + 1);
    expect(seqOf(run(model, skip, back))).toBe(seqOf(model) + 2);
  });

  it("confirmYes and confirmNo move focus to the title", () => {
    const start = run(hydrated({ ideas: READY }), skip, skip);
    const yes = run(start, { type: "confirmYes" });
    expect(yes.focus).toEqual({ target: "title", seq: start.focus.seq + 1 });
    const no = run(start, { type: "confirmNo" });
    expect(no.focus).toEqual({ target: "title", seq: start.focus.seq + 1 });
  });

  it("opening Other focuses the field, closing it returns to the row", () => {
    const start = run(hydrated(), skip, skip);
    const opened = run(start, { type: "toggleOther" });
    expect(opened.focus).toEqual({ target: "other", seq: start.focus.seq + 1 });
    const closed = run(opened, { type: "toggleOther" });
    expect(closed.focus).toEqual({
      target: "otherRow",
      seq: start.focus.seq + 2,
    });
    expect(closed.otherOpen).toBe(false);
  });

  it("typing and picking do not move focus", () => {
    const start = run(hydrated(), skip, skip, { type: "toggleOther" });
    const typed = run(start, { type: "otherText", text: "abc" });
    expect(typed.focus).toEqual(start.focus);
    expect(run(hydrated(), pick("goal.sales")).focus.seq).toBe(0);
  });

  it("hydrated moves focus to the title only when the step changes", () => {
    const sameStep = hydrated();
    expect(sameStep.focus.seq).toBe(0);
    const moved = hydrated({
      step: "tone",
      answers: {
        goal: { picked: ["goal.sales"] },
        channels: { picked: ["channel.x"] },
        business: { picked: ["kind.food"] },
        audience: { picked: ["audience.local"] },
      },
    });
    expect(moved.step).toBe("tone");
    expect(moved.focus).toEqual({ target: "title", seq: 1 });
  });

  it("Show moves focus to the title; ignored actions do not bump", () => {
    const model = hydrated();
    expect(run(model, back).focus).toEqual(model.focus);
    expect(run(model, { type: "reviewNow" }).focus).toEqual(model.focus);
  });
});

describe("announcementOf (G77)", () => {
  it("is the one polite status text per state", () => {
    let model = hydrated();
    expect(announcementOf(model)).toBe("Question 1 of 5");
    model = run(model, pick("goal.sales"), next);
    expect(announcementOf(model)).toBe("Question 2 of 5");
    expect(headerViewOf(model).announcement).toBe("Question 2 of 5");

    const extra = run(hydrated(), ...ANSWER_ALL, { type: "addDetail" });
    expect(announcementOf(extra)).toBe("Extra question 1 of 1");
    const review = run(hydrated(), ...ANSWER_ALL, { type: "reviewNow" });
    expect(announcementOf(review)).toBe("Review");

    const applying = run(review, { type: "applyStarted" });
    expect(announcementOf(applying)).toBe("Saving your setup.");
    const done = run(applying, { type: "applied", result: okResult });
    expect(announcementOf(done)).toBe("Setup saved.");
  });

  it("the done view takes focus on Close (the Approve button unmounted), but not when applied while closed", () => {
    const applying = run(
      hydrated(),
      ...ANSWER_ALL,
      { type: "reviewNow" },
      { type: "applyStarted" },
    );
    const done = run(applying, { type: "applied", result: okResult });
    expect(done.focus).toEqual({
      target: "close",
      seq: applying.focus.seq + 1,
    });
    const late = run(applying, {
      type: "applied",
      result: okResult,
      closed: true,
    });
    expect(late.focus).toEqual(applying.focus);
  });

  it("says 'Suggestions are ready.' when ideas land under a shown catalog list", () => {
    let model = run(hydrated({ ideas: RUNNING }), skip, skip, skip);
    // audience is pending: nothing to announce yet.
    model = run(model, { type: "ideasUpdated", ideas: RUNNING, from: "poll" });
    expect(announcementOf(model)).toBe("Question 4 of 5");
    let stat = run(hydrated({ ideas: ideasView() }), skip, skip, skip);
    stat = run(stat, { type: "ideasUpdated", ideas: READY, from: "poll" });
    expect(announcementOf(stat)).toBe("Suggestions are ready.");
    // The next step change goes back to the question number.
    stat = run(stat, skip);
    expect(announcementOf(stat)).toBe("Question 5 of 5");
  });
});

// -----------------------------------------------------------------------------
// G78: Approve
// -----------------------------------------------------------------------------

describe("canApprove (G78)", () => {
  const withGoal = () => run(hydrated(), pick("goal.sales"));

  it("is false for an empty plan, with the hint", () => {
    const model = hydrated();
    expect(canApprove(model)).toBe(false);
    expect(approveHint(model)).toBe("empty");
    const review = run(model, { type: "goTo", step: "review" });
    expect(panel(review, "review").approve).toMatchObject({ hint: "empty" });
  });

  it("stays true while a save is pending or has failed", () => {
    const model = withGoal();
    expect(model.save).toBe("saving");
    expect(canApprove(model)).toBe(true);
    const failed = run(model, { type: "saveFailed" });
    expect(failed.save).toBe("failed");
    expect(canApprove(failed)).toBe(true);
    expect(approveHint(failed)).toBeNull();
    const review = run(failed, { type: "goTo", step: "review" });
    expect(panel(review, "review").approve).toEqual({
      state: "saving",
    });
  });

  it("is false while applying and true again after a failed apply", () => {
    const model = withGoal();
    const applying = run(model, { type: "applyStarted" });
    expect(canApprove(applying)).toBe(false);
    expect(panelViewOf(applying)).toEqual({ kind: "applying", stalled: false });
    const failed = run(applying, { type: "applyFailed", code: "FAILED" });
    expect(canApprove(failed)).toBe(true);
    expect(failed.phase).toBe("ready");
  });

  it("is false for a DONE session with nothing changed since, true after an edit", () => {
    const done = hydrated({
      status: "DONE",
      answers: { goal: { picked: ["goal.sales"] } },
    });
    expect(canApprove(done)).toBe(false);
    expect(approveHint(done)).toBe("unchanged");
    const edited = run(
      done,
      { type: "goTo", step: "goal" },
      pick("goal.leads"),
    );
    expect(edited.dirty).toBe(true);
    expect(canApprove(edited)).toBe(true);
  });

  it("is false again right after a successful apply until something changes", () => {
    const model = run(
      withGoal(),
      { type: "applyStarted" },
      { type: "applied", result: okResult },
    );
    expect(model.phase).toBe("done");
    expect(model.status).toBe("DONE");
    const back = run(model, { type: "editSetup" });
    expect(back.step).toBe("review");
    expect(approveHint(back)).toBe("unchanged");
    expect(canApprove(back)).toBe(false);
    const changed = run(
      back,
      { type: "goTo", step: "goal" },
      pick("goal.leads"),
    );
    expect(canApprove(changed)).toBe(true);
  });

  it("the Review view shows 'saving' while a save is pending, and never a disabled state", () => {
    const review = run(withGoal(), { type: "goTo", step: "review" });
    const v = panel(review, "review");
    expect(v.approve.state).toBe("saving");
    expect(v.approve.hint).toBeUndefined();
    const settled = run(review, {
      type: "saved",
      seq: review.editSeq,
      response: { rev: "rev002", status: "OPEN", ideas: ideasView() },
    });
    expect(panel(settled, "review").approve.state).toBe("ready");
  });
});

describe("saves", () => {
  it("only the newest save settles the state; a failure shows the inline alert", () => {
    let model = hydrated();
    model = run(model, pick("goal.sales"));
    const first = model.editSeq;
    model = run(model, pick("goal.leads"));
    const second = model.editSeq;
    expect(second).toBeGreaterThan(first);
    const response = {
      rev: "rev002",
      status: "OPEN" as const,
      ideas: ideasView(),
    };
    model = run(model, { type: "saved", seq: first, response });
    expect(model.save).toBe("saving");
    model = run(model, { type: "saveFailed" });
    expect(panel(model, "question").inline).toEqual({
      kind: "saveFailed",
      retry: true,
    });
    model = run(model, { type: "saved", seq: second, response });
    expect(model.save).toBe("idle");
    expect(model.inline).toBeNull();
    expect(model.rev).toBe("rev002");
  });

  it("saveBody carries the step, more and only real answers", () => {
    let model = run(hydrated(), pick("goal.sales"), next, skip, skip);
    expect(saveBody(model)).toEqual({
      action: "save",
      step: "audience",
      more: false,
      answers: {
        goal: { picked: ["goal.sales"] },
        channels: { picked: [], skipped: true },
        business: { picked: [], skipped: true },
      },
    });
    // Whitespace-only Other is not an answer.
    model = run(
      hydrated(),
      skip,
      skip,
      { type: "toggleOther" },
      { type: "otherText", text: "  " },
    );
    expect(saveBody(model).answers.business).toBeUndefined();
  });
});

describe("runApprove (G78, G83)", () => {
  type Harness = {
    model: () => Model;
    dispatched: Action[];
    applied: string[];
    scheduled: Array<{ ms: number; fn: () => void; cancelled: boolean }>;
    deps: Parameters<typeof runApprove>[0];
  };

  function harness(opts: {
    model: Model;
    flush: () => Promise<boolean>;
    apply: (rev: string) => Promise<ApplyResult>;
    closed?: () => boolean;
  }): Harness {
    let model = opts.model;
    const dispatched: Action[] = [];
    const applied: string[] = [];
    const scheduled: Harness["scheduled"] = [];
    return {
      model: () => model,
      dispatched,
      applied,
      scheduled,
      deps: {
        getModel: () => model,
        dispatch: (action) => {
          dispatched.push(action);
          model = guidedSetupReducer(model, action);
        },
        flush: opts.flush,
        apply: (rev) => {
          applied.push(rev);
          return opts.apply(rev);
        },
        schedule: (ms, fn) => {
          const entry = { ms, fn, cancelled: false };
          scheduled.push(entry);
          return () => {
            entry.cancelled = true;
          };
        },
        isClosed: opts.closed ?? (() => false),
      },
    };
  }

  const ready = () =>
    run(hydrated({ rev: "rev777" }), pick("goal.sales"), {
      type: "goTo",
      step: "review",
    });

  it("a failing flush shows the inline alert and does not apply; retry then applies", async () => {
    let flushOk = false;
    const h = harness({
      model: ready(),
      flush: async () => flushOk,
      apply: async () => okResult,
    });
    await runApprove(h.deps);
    expect(h.applied).toEqual([]);
    expect(h.model().save).toBe("failed");
    expect(panel(h.model(), "review").inline).toEqual({
      kind: "saveFailed",
      retry: true,
    });
    expect(h.model().phase).toBe("ready");
    // Approve is still enabled: the person can retry.
    expect(canApprove(h.model())).toBe(true);

    flushOk = true;
    await runApprove(h.deps);
    expect(h.applied).toEqual(["rev777"]);
    expect(h.model().phase).toBe("done");
    expect(panel(h.model(), "done").summary.saved).toEqual([
      "Brand profile",
      "Goal",
    ]);
  });

  it("does nothing when Approve is aria-disabled (empty plan)", async () => {
    const empty = hydrated();
    let flushed = 0;
    const h = harness({
      model: empty,
      flush: async () => {
        flushed += 1;
        return true;
      },
      apply: async () => okResult,
    });
    await runApprove(h.deps);
    expect(flushed).toBe(0);
    expect(h.applied).toEqual([]);
    expect(h.dispatched).toEqual([]);
  });

  it("sends the current editRev, schedules the stalled line and cancels it on completion", async () => {
    let release: (result: ApplyResult) => void = () => {};
    const h = harness({
      model: ready(),
      flush: async () => true,
      apply: () =>
        new Promise<ApplyResult>((resolve) => {
          release = resolve;
        }),
    });
    const pending = runApprove(h.deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.model().phase).toBe("applying");
    expect(h.scheduled).toHaveLength(1);
    expect(h.scheduled[0]?.ms).toBe(APPLY_UI.stalledAfterMs);

    // The stalled line appears, and closing stays possible.
    h.scheduled[0]?.fn();
    expect(panelViewOf(h.model())).toEqual({ kind: "applying", stalled: true });
    expect(canClose(h.model())).toBe(true);
    expect(canApprove(h.model())).toBe(false);

    release(okResult);
    await pending;
    expect(h.scheduled[0]?.cancelled).toBe(true);
    expect(h.model().phase).toBe("done");
    expect(h.model().applyStalled).toBe(false);
    expect(h.model().toast).toBeNull();
  });

  it("a late `applied` while closed yields the toast intent and the summary update", async () => {
    const h = harness({
      model: ready(),
      flush: async () => true,
      apply: async () => okResult,
      closed: () => true,
    });
    await runApprove(h.deps);
    expect(h.model().toast).toEqual({
      seq: 1,
      kind: "saved",
      text: "Setup saved",
    });
    expect(summaryOf(h.model())).toMatchObject({
      status: "DONE",
      answered: 1,
      hasProfile: true,
    });
  });

  it("a partial or failed result while closed is a toast; while open it is inline only", async () => {
    const partial: ApplyResult = {
      ok: false,
      code: "PARTIAL",
      message: "x",
      saved: ["profile"],
      failed: ["goal"],
    };
    const closed = harness({
      model: ready(),
      flush: async () => true,
      apply: async () => partial,
      closed: () => true,
    });
    await runApprove(closed.deps);
    expect(closed.model().toast).toMatchObject({
      kind: "partial",
      text: "Some parts of your setup weren't saved. Open setup to try again.",
    });

    const open = harness({
      model: ready(),
      flush: async () => true,
      apply: async () => partial,
    });
    await runApprove(open.deps);
    expect(open.model().toast).toBeNull();
    const v = panel(open.model(), "review");
    expect(v.inline).toEqual({
      kind: "partial",
      retry: true,
      saved: ["profile"],
      failed: ["goal"],
    });
    expect(v.banner).toBe("partial");
    expect(v.failed).toEqual(["goal"]);
    expect(open.model().status).toBe("OPEN");
  });

  it("a throwing action becomes applyFailed", async () => {
    const h = harness({
      model: ready(),
      flush: async () => true,
      apply: async () => {
        throw new Error("Failed to find Server Action");
      },
    });
    await runApprove(h.deps);
    expect(h.dispatched.at(-1)).toEqual({
      type: "applyFailed",
      code: "FAILED",
      closed: false,
    });
    expect(h.model().phase).toBe("ready");
    expect(panel(h.model(), "review").inline).toEqual({
      kind: "failed",
      retry: true,
    });
  });

  it.each<[ApplyResult, string]>([
    [{ ok: false, code: "STALE", message: "", saved: [], failed: [] }, "stale"],
    [
      { ok: false, code: "ON_HOLD", message: "", saved: [], failed: [] },
      "onHold",
    ],
    [{ ok: false, code: "BUSY", message: "", saved: [], failed: [] }, "busy"],
    [{ ok: false, code: "RATE", message: "", saved: [], failed: [] }, "rate"],
    [
      { ok: false, code: "FAILED", message: "", saved: [], failed: [] },
      "failed",
    ],
  ])("apply answer %j is the inline %s notice", (result, kind) => {
    const action = applyOutcomeAction(result, false);
    const model = run(ready(), { type: "applyStarted" }, action);
    expect(model.phase).toBe("ready");
    expect(model.inline?.kind).toBe(kind);
  });

  it("DISABLED closes the sheet's flow and NOTHING shows no notice", () => {
    const disabled = run(
      ready(),
      { type: "applyStarted" },
      applyOutcomeAction(
        { ok: false, code: "DISABLED", message: "", saved: [], failed: [] },
        false,
      ),
    );
    expect(disabled.phase).toBe("unavailable");
    const nothing = run(
      ready(),
      { type: "applyStarted" },
      applyOutcomeAction(
        { ok: false, code: "NOTHING", message: "", saved: [], failed: [] },
        false,
      ),
    );
    expect(nothing.inline).toBeNull();
  });

  it("the done view carries the receipt lines and the plan-draft rule", () => {
    const model = run(
      hydrated({ goalMode: "active" }),
      pick("goal.sales"),
      next,
      pick("channel.instagram"),
      { type: "applyStarted" },
      {
        type: "applied",
        result: {
          ...okResult,
          goalMode: "proposed",
          unconnected: ["instagram"],
        },
      },
    );
    expect(panel(model, "done").summary).toEqual({
      goal: "Sales",
      goalProposed: true,
      channels: ["Instagram"],
      saved: ["Brand profile", "Goal"],
      unconnected: ["instagram"],
      canDraftPlan: true,
    });
    // Ads alone cannot be drafted; nothing changed saves nothing.
    const ads = run(
      hydrated(),
      pick("goal.sales"),
      next,
      pick("channel.ads"),
      { type: "applyStarted" },
      { type: "applied", result: { ...okResult, unchanged: true } },
    );
    expect(panel(ads, "done").summary).toMatchObject({
      saved: [],
      canDraftPlan: false,
    });
  });
});

// -----------------------------------------------------------------------------
// Misc selectors and rules
// -----------------------------------------------------------------------------

describe("other rules", () => {
  it("the paused note shows on every question", () => {
    const model = hydrated({ projectActive: false });
    expect(panel(model, "question").inline).toEqual({ kind: "paused" });
  });

  it("an interactive action is ignored while applying, done or after an error", () => {
    const applying = run(hydrated(), pick("goal.sales"), {
      type: "applyStarted",
    });
    expect(run(applying, pick("goal.leads"), next, skip)).toBe(applying);
    const failedBoot = run(init(), { type: "bootFailed" });
    expect(run(failedBoot, pick("goal.sales"))).toBe(failedBoot);
  });

  it("canClose is true in every phase", () => {
    const phases: Model[] = [
      init(),
      hydrated(),
      run(
        hydrated(),
        pick("goal.sales"),
        { type: "applyStarted" },
        { type: "applyStalled" },
      ),
      run(
        hydrated(),
        pick("goal.sales"),
        { type: "applyStarted" },
        { type: "applied", result: okResult },
      ),
      run(init(), { type: "bootFailed" }),
      run(init(), { type: "expired" }),
      run(init(), { type: "unavailable" }),
    ];
    for (const model of phases) expect(canClose(model)).toBe(true);
  });

  it("the channel rows use the live connection state when the view has it", () => {
    const model = run(
      hydrated({
        channels: [
          {
            id: "channel.instagram",
            label: "Instagram",
            hint: "Connected as @qr",
            connected: true,
          },
          {
            id: "channel.tiktok",
            label: "TikTok",
            hint: "Short videos",
            connected: false,
          },
        ],
      }),
      skip,
    );
    const rows = panel(model, "question").rows;
    expect(rows).toEqual([
      expect.objectContaining({
        id: "channel.instagram",
        hint: "Connected as @qr",
        connected: true,
        selected: false,
      }),
      expect.objectContaining({ id: "channel.tiktok", connected: false }),
    ]);
  });

  it("the stored profile shows as a 'Current' line, never pre-selected", () => {
    const model = hydrated({
      current: { goal: "Sales", identity: "A QR company" },
    });
    const goal = panel(model, "question");
    expect(goal.current).toEqual({
      label: "Current goal:",
      text: "Sales",
      ai: false,
    });
    expect(goal.rows.every((r) => !r.selected)).toBe(true);
    const business = panel(run(model, skip, skip), "question");
    expect(business.current).toEqual({
      label: "Current:",
      text: "A QR company",
      ai: true,
    });
  });

  it("summaryOf follows the answers so the chip label updates without a refresh", () => {
    let model = hydrated();
    expect(summaryOf(model)).toMatchObject({
      status: "OPEN",
      answered: 0,
      position: 1,
    });
    model = run(model, pick("goal.sales"), next, skip);
    expect(summaryOf(model)).toMatchObject({
      status: "OPEN",
      answered: 1,
      position: 3,
      started: true,
    });
  });

  it("the review help mentions the draft profile after a paid run", () => {
    const paid = run(hydrated({ ideas: READY }), ...ANSWER_ALL_IDEAS, {
      type: "reviewNow",
    });
    expect(panel(paid, "review").help).toBe("discovery");
    const plain = run(hydrated(), ...ANSWER_ALL, { type: "reviewNow" });
    expect(panel(plain, "review").help).toBe("plain");
  });

  it("the review shows the hands-on level read-only", () => {
    const review = run(hydrated(), ...ANSWER_ALL, { type: "reviewNow" });
    expect(panel(review, "review").handsOn).toEqual({
      name: "Autopilot",
      note: "creates, plans and publishes automatically within your limits",
    });
    const unknown = run(hydrated({ handsOn: null }), ...ANSWER_ALL, {
      type: "reviewNow",
    });
    expect(panel(unknown, "review").handsOn).toBeNull();
  });
});

describe("purity (acceptance)", () => {
  const source = readFileSync(
    path.join(__dirname, "guided-setup-state.ts"),
    "utf8",
  )
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  it("has no React import, no clock and no refs", () => {
    expect(source).not.toMatch(/from\s+["']react["']/u);
    expect(source).not.toMatch(/["']use client["']/u);
    expect(source).not.toMatch(/Date\.now|new Date\(|performance\.now/u);
    expect(source).not.toMatch(
      /useRef|useState|useEffect|setTimeout|setInterval/u,
    );
    expect(source).not.toMatch(/:\s*any\b|<any>|\bas any\b/u);
  });
});
