import { describe, expect, it } from "vitest";
import {
  AnswersSchema, GuidedSetupRequestSchema, SessionRecordSchema, IdeasRecordSchema, IdeaOptionsSchema,
  entryOf, isAnswered, isResolved, goalFromOptionId, channelFromOptionId, QUESTIONS, MAIN_QUESTIONS,
  STEP_IDS, GOAL_PRESETS, BUSINESS_KINDS, BUSINESS_KINDS_PRIMARY, BUSINESS_KINDS_MORE, MAX_VISIBLE_ROWS,
  AUDIENCE_SEGMENTS, TONES, GUARDRAILS, CHANNEL_HINTS, HANDS_ON_LABEL, HANDS_ON_MODES,
  EMPTY_IDEA_OPTIONS, sessionRowId, isAiOptionId, AUDIT, DISCOVERY_LIMITS,
  parseDiscoveryCaps, parseDiscoveryScope, discoveryEnabledFor, REQUEST_LIMITS, RATE, POLL,
} from "./contract";

describe("guided-setup contract", () => {
const check = (name: string, ok: boolean) => it(name, () => expect(ok).toBe(true));

// ---- requests are strict ----
check("partial answers parse (one key)", AnswersSchema.safeParse({ goal: { picked: ["goal.sales"] } }).success);
check("unknown question key rejected", !AnswersSchema.safeParse({ nope: { picked: [] } }).success);
check("unknown answer key rejected (strict)", !AnswersSchema.safeParse({ goal: { picked: [], value: "x" } }).success);
check("the removed `delegated` flag is an unknown key", !AnswersSchema.safeParse({ tone: { picked: [], delegated: true } }).success);
check("skipped and deferred flags parse", AnswersSchema.safeParse({ tone: { picked: [], skipped: true }, audience: { picked: [], deferred: true } }).success);
check("start request", GuidedSetupRequestSchema.safeParse({ action: "start" }).success);
check("start request with seed id", GuidedSetupRequestSchema.safeParse({ action: "start", seedCommandId: "cm1" }).success);
check("save request", GuidedSetupRequestSchema.safeParse({ action: "save", step: "goal", more: false, answers: { goal: { picked: ["goal.sales"] } } }).success);
check("save with review step", GuidedSetupRequestSchema.safeParse({ action: "save", step: "review", more: true, answers: {} }).success);
check("discover request", GuidedSetupRequestSchema.safeParse({ action: "discover" }).success);
check("draft_plan request", GuidedSetupRequestSchema.safeParse({ action: "draft_plan" }).success);
check("discover with extra key rejected", !GuidedSetupRequestSchema.safeParse({ action: "discover", force: true }).success);
check("unknown action rejected", !GuidedSetupRequestSchema.safeParse({ action: "apply" }).success);

// ---- entry rules ----
const S = (o: Partial<Parameters<typeof entryOf>[0]>) => ({ status: "NONE" as const, answered: 0, total: 5, position: 1, started: false, hasProfile: false, ...o });
check("entry: fresh project", entryOf(S({})).kind === "start");
check("entry: open with answers labels by position", entryOf(S({ status: "OPEN", answered: 2, position: 4 })).label === "Continue setup · question 4 of 5");
check("entry: position is clamped into 1..total", entryOf(S({ status: "OPEN", answered: 1, position: 9 })).label === "Continue setup · question 5 of 5" && entryOf(S({ status: "OPEN", answered: 1, position: 0 })).label === "Continue setup · question 1 of 5");
check("entry: established project has no chip", entryOf(S({ hasProfile: true })).chip === false);
check("entry: done -> update, no welcome", (() => { const e = entryOf(S({ status: "DONE", answered: 5, hasProfile: true })); return e.kind === "update" && !e.welcome && !e.chip; })());
check("entry: open with answers on established project still continues", entryOf(S({ status: "OPEN", answered: 1, hasProfile: true })).chip === true);
check("entry: started with nothing answered still continues (a paid run flipped hasProfile)", entryOf(S({ status: "OPEN", started: true, hasProfile: true })).kind === "continue");
check("entry: open, nothing answered, not started, no profile -> start", entryOf(S({ status: "OPEN" })).kind === "start");

// ---- answers ----
check("isAnswered picked", isAnswered({ picked: ["a"] }));
check("isAnswered typed", isAnswered({ picked: [], other: "Warm" }));
check("isAnswered skipped is not answered", !isAnswered({ picked: [], skipped: true }));
check("isResolved: answered, skipped and deferred count", isResolved({ picked: ["a"] }) && isResolved({ picked: [], skipped: true }) && isResolved({ picked: [], deferred: true }) && !isResolved({ picked: [] }) && !isResolved(undefined));
check("goal id round trip", goalFromOptionId("goal.sales") === "sales" && goalFromOptionId("goal.nope") === null);
check("channel id round trip", channelFromOptionId("channel.seo") === "seo");

// ---- catalogs ----
check("every main question has a spec", MAIN_QUESTIONS.every((q) => QUESTIONS[q].group === "main"));
check("steps include checkpoint and review", STEP_IDS.includes("checkpoint") && STEP_IDS.includes("review"));
check("five presets", Object.keys(GOAL_PRESETS).length === 5);
check("no tier shows more than six rows", [BUSINESS_KINDS_PRIMARY, BUSINESS_KINDS_MORE, AUDIENCE_SEGMENTS, GUARDRAILS, TONES].every((l) => l.length <= MAX_VISIBLE_ROWS));
check("business kinds: two tiers of six, twelve in all", BUSINESS_KINDS_PRIMARY.length === 6 && BUSINESS_KINDS_MORE.length === 6 && BUSINESS_KINDS.length === 12);
check("channel hints cover all six", Object.keys(CHANNEL_HINTS).length === 6);
const staticAll = [...BUSINESS_KINDS, ...AUDIENCE_SEGMENTS, ...TONES, ...GUARDRAILS];
check("static ids unique", new Set(staticAll.map((o) => o.id)).size === staticAll.length);
check("ai ids never collide with static ids", !staticAll.some((o) => isAiOptionId(o.id)));
check("session row id", sessionRowId("p1") === "gs_p1");
check("hands-on labels cover every mode", HANDS_ON_MODES.every((m) => HANDS_ON_LABEL[m].name && HANDS_ON_LABEL[m].note));
check("delegate questions are the ones the spec names", (["audience", "tone", "angle"] as const).every((q) => QUESTIONS[q].delegate) && (["goal", "channels", "business", "guardrails"] as const).every((q) => !QUESTIONS[q].delegate));
check("audit names are workspace-level discovery + session reset", AUDIT.discoveryStarted === "guided_setup.discovery.started" && AUDIT.sessionReset === "guided_setup.session_reset");

// ---- stored rows: loose ----
const session = {
  v: 1, rev: "9f2c1a7be0d4", editRev: "e41b09aa02c1", status: "OPEN", step: "audience", more: false,
  answers: { goal: { picked: ["goal.leads"] }, tone: { picked: [], other: "Warm, a little cheeky" } },
  seedFirst: false, staticFirst: true, seed: { text: "Qr Hub Menu icin sosyal medya" }, applyingSinceMs: null, applyToken: null, goalId: null,
  applied: null, lastFailure: null, createdAtMs: 1, updatedAtMs: 2, updatedByUserId: "u1",
};
check("session record parses", SessionRecordSchema.safeParse(session).success);
check("session record keeps an unknown top-level key through a parse (a newer deploy)", (() => { const r = SessionRecordSchema.safeParse({ ...session, futureField: 7 }); return r.success && (r.data as Record<string, unknown>).futureField === 7; })());
check("session record keeps an unknown answer key", (() => { const r = SessionRecordSchema.safeParse({ ...session, answers: { goal: { picked: [], note: "x" } } }); return r.success && (r.data.answers.goal as Record<string, unknown>).note === "x"; })());
check("session record keeps unknown keys inside applied", (() => { const applied = { atMs: 1, editRev: "e41b09aa02c1", parts: ["profile"], goalMode: "active", receiptId: null, extra: 1 }; const r = SessionRecordSchema.safeParse({ ...session, status: "DONE", applied }); return r.success && (r.data.applied as Record<string, unknown>).extra === 1; })());
check("applied.receiptId may be null (an all-unchanged apply writes no receipt)", SessionRecordSchema.safeParse({ ...session, applied: { atMs: 1, editRev: "e", parts: [], goalMode: null, receiptId: null } }).success);
check("session record still rejects a wrong type", !SessionRecordSchema.safeParse({ ...session, more: "yes" }).success);
check("session record requires the new fields", !SessionRecordSchema.safeParse({ ...session, staticFirst: undefined }).success && !SessionRecordSchema.safeParse({ ...session, applyToken: undefined }).success && !SessionRecordSchema.safeParse({ ...session, goalId: undefined }).success);
check("a NEW question id inside a stored answers object does not parse (start replaces the row)", !SessionRecordSchema.safeParse({ ...session, answers: { competitors: { picked: [] } } }).success);
check("stored answers may carry a legacy `delegated` key without failing (loose)", SessionRecordSchema.safeParse({ ...session, answers: { tone: { picked: [], delegated: true } } }).success);
const ideas = { v: 1, rev: "abcdef123456", status: "READY", source: "profile", attempts: 0, options: EMPTY_IDEA_OPTIONS, stats: { kept: 0, dropped: 0 }, updatedAtMs: 1 };
check("ideas record parses", IdeasRecordSchema.safeParse(ideas).success);
check("ideas record keeps an unknown key", (() => { const r = IdeasRecordSchema.safeParse({ ...ideas, sources: ["x"] }); return r.success && Array.isArray((r.data as Record<string, unknown>).sources); })());
check("ideas option keeps a future field (B3 `source`)", (() => { const r = IdeaOptionsSchema.safeParse({ business: [{ id: "o_0123456789", label: "x", source: "site" }], audience: [], angle: [] }); return r.success && (r.data.business[0] as Record<string, unknown>).source === "site"; })());
check("ideas record caps audience options at 4", !IdeasRecordSchema.safeParse({ ...ideas, options: { business: [], audience: Array.from({ length: 5 }, (_, i) => ({ id: `o_00000000a${i}`, label: "x" })), angle: [] } }).success);

// ---- operator env parsers (S2, S18) ----
check("caps: default when unset or empty", parseDiscoveryCaps(undefined).perUserPer24h === 5 && parseDiscoveryCaps("").globalPer24h === 20);
check("caps: lowering works", (() => { const c = parseDiscoveryCaps("1,2,4"); return c.perUserPer24h === 1 && c.perWorkspacePer24h === 2 && c.globalPer24h === 4; })());
check("caps: cannot exceed the ceilings", (() => { const c = parseDiscoveryCaps("50,100,200"); return c.perUserPer24h === 5 && c.perWorkspacePer24h === 10 && c.globalPer24h === 20; })());
check("caps: zero pauses", parseDiscoveryCaps("0,0,0").globalPer24h === 0);
check("caps: any parse problem falls back to the ceilings", ["1,2", "a,b,c", "1,2,3,4", "-1,2,3", "1.5,2,3", "1;2,3;4", "1,,3", "  "].every((raw) => { const c = parseDiscoveryCaps(raw); return c.perUserPer24h === 5 && c.perWorkspacePer24h === 10 && c.globalPer24h === 20; }));
check("caps: semicolons and spaces separate too, so a mistyped pause still pauses", ["0;0;0", "0 0 0", "0, 0, 0", " 0;0 ;0 "].every((raw) => { const c = parseDiscoveryCaps(raw); return c.perUserPer24h === 0 && c.perWorkspacePer24h === 0 && c.globalPer24h === 0; }) && parseDiscoveryCaps("1;2;4").perWorkspacePer24h === 2);
check("scope: false/unset/empty are off", ["false", "", undefined, null, "  "].every((raw) => parseDiscoveryScope(raw as string).kind === "off"));
check("scope: true is every workspace", parseDiscoveryScope("true").kind === "all" && discoveryEnabledFor(parseDiscoveryScope("true"), "any"));
check("scope: a list enables only the listed workspaces", (() => { const s = parseDiscoveryScope("ws_1, ws_2"); return s.kind === "workspaces" && discoveryEnabledFor(s, "ws_2") && !discoveryEnabledFor(s, "ws_3"); })());
check("scope: a typo or a malformed entry reads as off", ["ws_1,", "ws 1", "ws_1;ws_2", "yes,"].every((raw) => parseDiscoveryScope(raw).kind === "off") && parseDiscoveryScope("TRUE ").kind !== "all" && !discoveryEnabledFor(parseDiscoveryScope("TRUE "), "everyone-else"));
check("scope: off enables nothing", !discoveryEnabledFor(parseDiscoveryScope("false"), "ws_1"));
check("limits: ceilings and body cap are what the spec says", DISCOVERY_LIMITS.perUserPer24h === 5 && DISCOVERY_LIMITS.perWorkspacePer24h === 10 && DISCOVERY_LIMITS.globalPer24h === 20 && REQUEST_LIMITS.maxBodyBytes === 16384 && RATE.draftPlanPerMinute === 3);
check("limits: the run timings the docs quote (150 s deadline, 240 s stale) and their order", DISCOVERY_LIMITS.runDeadlineMs === 150_000 && DISCOVERY_LIMITS.staleRunningMs === 240_000 && DISCOVERY_LIMITS.staleRunningMs >= DISCOVERY_LIMITS.runDeadlineMs + 30_000);
check("limits: polling cadence and ceiling", POLL.intervalMs === 2_000 && POLL.maxMs === 300_000 && POLL.maxMs > DISCOVERY_LIMITS.staleRunningMs);
});
