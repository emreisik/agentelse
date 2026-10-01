import "server-only";

import {
  DISCOVERY_CAPS,
  FIELD_IDS,
  emptyRecord,
  viewOf,
  type DiscoveryRecord,
  type DiscoveryView,
  type FailReason,
  type FieldId,
  type IdentitySummary,
  type Row,
  type Stage,
  type StageState,
} from "@/lib/guided-discovery/contract";
import {
  mergeExtension,
  type ExtendField,
} from "@/lib/guided-discovery/extend";
import { isValidDomain, normalizeDomain } from "@/lib/domain";
import { intakeStartsOf, type IntakeOffer } from "@/lib/intake-offer";
import { countryLabel, languageLabel } from "@/lib/locales";
import { safeModelText } from "@/lib/safe-model-text";
import type { QuickDiscoveryService } from "@/server/brand/quick-discovery";
import type { IdentityFillResult } from "@/server/brand/site-scan/auto-identity";
import type {
  SocialLink,
  SocialPlatform,
} from "@/server/brand/site-scan/extract";
import type { discoveryCaps, discoveryGates } from "@/server/guided-setup/flag";
import type {
  releaseDiscovery,
  reserveDiscovery,
} from "@/server/guided-setup/limits";
import type { DiscoveryExtendOutput } from "@/server/reasoning/prompts/discovery-extend";

import { candidateIdFor } from "./ids";
import type { Change, Created, Modified } from "./store";

// The discovery flow (spec section 5). `startDiscovery` is the ONLY door that
// starts the paid research (from the create tap) and `retryDiscovery` the only
// other one (an explicit "Try again" tap). Nothing paid starts from a read, a
// poll, a render or a reopen.
//
// Everything with IO is injected (`FlowDeps`) so the tests need no database and
// no network; the production wiring is built lazily below, with dynamic imports,
// so a test that injects every dependency never loads a model client.
//
// Rules this file holds:
//  - One research claim per start: the row is created by primary key, a second
//    start finds it and starts nothing.
//  - Every reservation taken is released on every failure path (the attempt is
//    refunded); a success keeps it (the money was spent).
//  - A stage write is cosmetic (best effort, a few CAS tries); the FINAL status
//    write must succeed, or the job records FAILED instead.
//  - A runner only writes while the row still carries its own runId and is
//    RUNNING: a stale runner (an older attempt) can never overwrite a newer one.
//  - The row stores no page text and no URL: channels are platform labels only.

export const DISCOVERY_AUDIT = {
  started: "guided_discovery.started",
  finished: "guided_discovery.finished",
  failed: "guided_discovery.failed",
} as const;

export type DiscoveryAccess = {
  userId: string;
  workspaceId: string;
  projectId: string;
  defaultBrandId?: string;
};

type Schedule = (job: () => Promise<void>) => void;

export type ProjectFacts = {
  brandId: string;
  brandName: string;
  // The typed website (a bare host), when there is one.
  domain: string | null;
  language: string;
  country: string;
};

// What the dossier holds right now, for the fields the screen knows.
export type DossierSnapshot = {
  summary: string;
  positioning: string;
  toneOfVoice: string;
  targetAudiences: string[];
  markets: string[];
  products: string[];
  services: string[];
  visualGuidelines: string[];
};

export type DossierScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export type FlowDeps = {
  // isGuidedSetupEnabled(): the flag is re-checked per call.
  enabled: () => boolean;
  nowMs: () => number;
  // A short random hex id (run ids).
  randomId: () => string;
  store: {
    read: (projectId: string) => Promise<DiscoveryRecord | null>;
    create: (input: {
      scope: DossierScope;
      userId: string;
      record: DiscoveryRecord;
    }) => Promise<Created>;
    modify: <T>(
      projectId: string,
      change: (record: DiscoveryRecord) => Change<T>,
      options?: { attempts?: number },
    ) => Promise<Modified<T>>;
  };
  readFacts: (projectId: string) => Promise<ProjectFacts | null>;
  gates: typeof discoveryGates;
  caps: typeof discoveryCaps;
  reserve: typeof reserveDiscovery;
  release: typeof releaseDiscovery;
  qd: {
    claim: typeof QuickDiscoveryService.claim;
    run: typeof QuickDiscoveryService.run;
  };
  identity: (
    scope: DossierScope,
    input: { domain: string; userId: string },
  ) => Promise<IdentityFillResult>;
  readIdentity: (brandId: string) => Promise<NonNullable<IdentitySummary>>;
  // null: the site could not be read.
  fetchSocials: (domain: string) => Promise<SocialLink[] | null>;
  dossier: {
    read: (brandId: string) => Promise<DossierSnapshot>;
    // Writes list fields as given; the caller has already checked they are empty.
    fillLists: (
      scope: DossierScope,
      data: Partial<Record<ExtendField, string[]>>,
    ) => Promise<void>;
  };
  // Mock reasoning mode: no extension call, nothing made up reaches a dossier.
  isMock: () => boolean;
  extend: (
    scope: DossierScope,
    facts: Record<string, unknown>,
  ) => Promise<DiscoveryExtendOutput>;
  audit: (entry: {
    workspaceId: string;
    projectId: string;
    brandId: string;
    action: string;
    actorId?: string;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
  runDeadlineMs?: number;
};

export type FlowResult = {
  // A job was scheduled by this call.
  started: boolean;
  view: DiscoveryView;
};

// --- small helpers -------------------------------------------------------------

const TIMED_OUT = Symbol("timed out");

// Stops WAITING, never the work; a rejection of the abandoned work is swallowed.
function raceDeadline<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function logError(what: string, error: unknown): void {
  console.error(
    `[guided-discovery] ${what}:`,
    error instanceof Error ? error.message : error,
  );
}

const PLATFORM_LABEL: Record<SocialPlatform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  youtube: "YouTube",
  x: "X",
};

// The dossier columns the screen rows map onto.
const DOSSIER_ROWS: {
  field: FieldId;
  read: (d: DossierSnapshot) => string[];
  text: boolean;
}[] = [
  { field: "about", read: (d) => (d.summary ? [d.summary] : []), text: true },
  { field: "audience", read: (d) => d.targetAudiences, text: false },
  { field: "products", read: (d) => d.products, text: false },
  { field: "services", read: (d) => d.services, text: false },
  { field: "markets", read: (d) => d.markets, text: false },
  {
    field: "voice",
    read: (d) => (d.toneOfVoice ? [d.toneOfVoice] : []),
    text: true,
  },
  {
    field: "positioning",
    read: (d) => (d.positioning ? [d.positioning] : []),
    text: true,
  },
];

const LIST_FIELDS: readonly ExtendField[] = [
  "services",
  "products",
  "markets",
  "visualGuidelines",
];
const ROW_OF_LIST: Partial<Record<ExtendField, FieldId>> = {
  services: "services",
  products: "products",
  markets: "markets",
};
const DOSSIER_KEY: Record<ExtendField, keyof DossierSnapshot> = {
  services: "services",
  products: "products",
  markets: "markets",
  visualGuidelines: "visualGuidelines",
};

// Every stored row text passes the hostile-text filter once more, on its way
// in: a dropped text is gone whole.
function cleanRows(rows: readonly Row[], projectId: string): Row[] {
  const out: Row[] = [];
  for (const row of rows) {
    const saved = row.saved
      .map((text) => safeModelText(text, DISCOVERY_CAPS.textMax))
      .filter((text): text is string => text !== null);
    const candidates = row.candidates.flatMap((c) => {
      const text = safeModelText(c.text, DISCOVERY_CAPS.textMax);
      return text
        ? [
            {
              id: candidateIdFor(projectId, row.field, text),
              text,
              score: c.score,
              added: false,
            },
          ]
        : [];
    });
    out.push({ ...row, saved, candidates });
  }
  return out;
}

// What the dossier holds is what is saved: a value a person (or an earlier
// step) already wrote shows as Found, and is never offered again as a chip.
function seedFromDossier(rows: Row[], dossier: DossierSnapshot): Row[] {
  const next = rows.map((row) => ({
    ...row,
    saved: [...row.saved],
    candidates: row.candidates.map((c) => ({ ...c })),
  }));
  for (const { field, read, text } of DOSSIER_ROWS) {
    const items = read(dossier);
    if (items.length === 0) continue;
    const row = next.find((r) => r.field === field);
    if (!row) {
      next.push({
        field,
        tier: "accepted",
        score: 100,
        saved: items,
        candidates: [],
      });
    } else if (row.tier !== "accepted") {
      row.tier = "accepted";
      row.score = 100;
      row.saved = items;
      // A text row that is filled takes no more candidates (a tap would no-op).
      if (text) row.candidates = [];
    }
  }
  return next;
}

// A high-confidence extension item that could not be written (the list was no
// longer empty at write time) must not show as saved: it becomes a chip.
function demoteUnwritten(
  rows: Row[],
  unwritten: Partial<Record<ExtendField, string[]>>,
  idFor: (field: FieldId, text: string) => string,
): Row[] {
  return rows.map((row) => {
    const field = LIST_FIELDS.find((f) => ROW_OF_LIST[f] === row.field);
    const items = field ? unwritten[field] : undefined;
    if (!field || !items || items.length === 0) return row;
    const gone = new Set(items.map((i) => i.toLowerCase()));
    const moved = row.saved.filter((t) => gone.has(t.toLowerCase()));
    if (moved.length === 0) return row;
    const room = Math.max(
      0,
      DISCOVERY_CAPS.maxCandidatesPerRow - row.candidates.length,
    );
    return {
      ...row,
      saved: row.saved.filter((t) => !gone.has(t.toLowerCase())),
      candidates: [
        ...row.candidates,
        ...moved.slice(0, room).map((text) => ({
          id: idFor(row.field, text),
          text,
          score: Math.min(row.score, 84),
          added: false,
        })),
      ],
    };
  });
}

// Rows of `mine` replace the same field of `existing`; the others stay (the
// channels row is written by another branch of the job).
function upsertRows(existing: readonly Row[], mine: readonly Row[]): Row[] {
  const byField = new Map<FieldId, Row>();
  for (const row of existing) byField.set(row.field, row);
  for (const row of mine) byField.set(row.field, row);
  return FIELD_IDS.flatMap((field) => {
    const row = byField.get(field);
    return row ? [row] : [];
  }).slice(0, DISCOVERY_CAPS.maxRows);
}

// The facts the extension call sees: short cleaned strings only, no URL, no
// page text. Assumed values are labelled as assumed.
function extensionFacts(input: {
  facts: ProjectFacts;
  rows: readonly Row[];
}): Record<string, unknown> {
  const { facts, rows } = input;
  const clean = (texts: readonly string[]) =>
    texts
      .map((t) => safeModelText(t, 160))
      .filter((t): t is string => t !== null)
      .slice(0, 10);
  const known: Record<string, string[]> = {};
  const assumed: Record<string, string[]> = {};
  for (const row of rows) {
    if (row.field === "channels" || row.field === "competitors") continue;
    const saved = clean(row.saved);
    if (saved.length > 0) known[row.field] = saved;
    const guesses = clean(row.candidates.map((c) => c.text));
    if (guesses.length > 0) assumed[row.field] = guesses;
  }
  return {
    brandName: safeModelText(facts.brandName, 80) ?? "",
    website:
      facts.domain && isValidDomain(facts.domain)
        ? normalizeDomain(facts.domain)
        : null,
    language: languageLabel(facts.language),
    country: countryLabel(facts.country),
    known,
    assumed,
  };
}

// --- the job -------------------------------------------------------------------

type Steps = { identity: boolean; channels: boolean; research: boolean };

type Ctx = {
  d: FlowDeps;
  access: DiscoveryAccess;
  facts: ProjectFacts;
  scope: DossierScope;
  runId: string;
  // The reservation's attempt number (1 for a first run).
  attemptNo: number;
  steps: Steps;
  startedAtMs: number;
};

type Patched = "ok" | "stale" | "lost";

// One CAS write. A runner that no longer owns the row (another runId, or not
// RUNNING any more) is refused with "stale". Never throws.
async function patch(
  ctx: Ctx,
  change: (record: DiscoveryRecord) => DiscoveryRecord,
  attempts = 3,
): Promise<Patched> {
  try {
    const result = await ctx.d.store.modify(
      ctx.access.projectId,
      (record) => {
        if (record.runId !== ctx.runId || record.status !== "RUNNING") {
          return { error: "stale" };
        }
        return {
          next: { ...change(record), updatedAtMs: ctx.d.nowMs() },
          value: null,
        };
      },
      { attempts },
    );
    if (result.status === "OK") return "ok";
    return result.status === "REJECTED" && result.error === "stale"
      ? "stale"
      : "lost";
  } catch (error) {
    logError("stage write failed", error);
    return "lost";
  }
}

const setStage = (
  ctx: Ctx,
  stage: Stage,
  state: StageState,
  extra?: (record: DiscoveryRecord) => Partial<DiscoveryRecord>,
) =>
  patch(ctx, (record) => ({
    ...record,
    ...(extra ? extra(record) : {}),
    stages: { ...record.stages, [stage]: state },
  }));

async function release(
  ctx: Ctx,
  reservation: { auditId: string },
  reason: string,
): Promise<void> {
  try {
    await ctx.d.release({
      auditId: reservation.auditId,
      runId: ctx.runId,
      attempt: ctx.attemptNo,
      reason,
    });
  } catch (error) {
    logError("could not release the reservation", error);
  }
}

async function audit(
  ctx: Ctx,
  action: string,
  metadata: Record<string, unknown>,
  actorId?: string,
): Promise<void> {
  try {
    await ctx.d.audit({
      workspaceId: ctx.access.workspaceId,
      projectId: ctx.access.projectId,
      brandId: ctx.scope.brandId,
      action,
      ...(actorId ? { actorId } : {}),
      metadata,
    });
  } catch (error) {
    logError("could not write the audit row", error);
  }
}

// Identity: the website scan into the brand kit (fill-empty), then the summary
// the screen shows, read back from what the brand kit holds now.
async function identityStep(ctx: Ctx, domain: string): Promise<boolean> {
  const { d } = ctx;
  await setStage(ctx, "identity", "running");
  let state: StageState = "failed";
  try {
    const result = await d.identity(ctx.scope, {
      domain,
      userId: ctx.access.userId,
    });
    state =
      result.status === "FILLED"
        ? "done"
        : result.status === "NOTHING_TO_FILL" ||
            result.status === "ALREADY_TRIED" ||
            result.status === "SKIPPED"
          ? "skipped"
          : "failed";
  } catch (error) {
    logError("identity scan failed", error);
  }
  let summary: IdentitySummary = null;
  try {
    summary = await d.readIdentity(ctx.scope.brandId);
  } catch (error) {
    logError("could not read the identity back", error);
  }
  await patch(
    ctx,
    (record) => ({
      ...record,
      identity: summary ?? record.identity,
      stages: { ...record.stages, identity: state },
    }),
    5,
  );
  return state !== "failed";
}

// Channels: the social profile links on the website's own home page, stored as
// platform labels only (the URLs stay out of the row, out of prompts, out of logs).
async function channelsStep(ctx: Ctx, domain: string): Promise<boolean> {
  let links: SocialLink[] | null = null;
  try {
    links = await ctx.d.fetchSocials(domain);
  } catch (error) {
    logError("could not read the social links", error);
  }
  if (links === null) return false;
  const labels = [...new Set(links.map((l) => PLATFORM_LABEL[l.platform]))];
  const row: Row = {
    field: "channels",
    tier: labels.length > 0 ? "accepted" : "unknown",
    score: labels.length > 0 ? 100 : 0,
    saved: labels,
    candidates: [],
  };
  await patch(
    ctx,
    (record) => ({ ...record, rows: upsertRows(record.rows, [row]) }),
    5,
  );
  return true;
}

type ResearchOutcome =
  { ok: true; rows: Row[] } | { ok: false; failure: FailReason };

const failed = (failure: FailReason): ResearchOutcome => ({
  ok: false,
  failure,
});

// The paid research: reservation -> claim -> run. Every path that took a
// reservation and did not finish releases it.
async function researchStep(ctx: Ctx): Promise<ResearchOutcome> {
  const { d, access } = ctx;
  // A runner that lost the row (a newer attempt owns it) spends nothing.
  if ((await setStage(ctx, "research", "running")) === "stale") {
    return failed("error");
  }

  let reservation: { auditId: string };
  try {
    const reserved = await d.reserve({
      workspaceId: access.workspaceId,
      userId: access.userId,
      projectId: access.projectId,
      runId: ctx.runId,
      attempt: ctx.attemptNo,
      nowMs: d.nowMs(),
      caps: d.caps(),
    });
    // Refused: nothing was taken, nothing to release, nothing is claimed.
    if (!reserved.ok) return failed("limit");
    reservation = { auditId: reserved.auditId };
  } catch (error) {
    logError("could not reserve the research", error);
    return failed("error");
  }

  try {
    const target = await d.qd.claim(access.projectId, { guided: true });
    if (!target) {
      await release(ctx, reservation, "busy");
      return failed("busy");
    }

    // The attempt is counted from here on (a claim that never started is free).
    const counted = await patch(
      ctx,
      (record) => ({ ...record, attempts: record.attempts + 1 }),
      5,
    );
    if (counted !== "ok") {
      await release(ctx, reservation, "error");
      return failed("error");
    }

    const outcome = await raceDeadline(
      d.qd.run(target),
      d.runDeadlineMs ?? DISCOVERY_CAPS.runDeadlineMs,
    );
    if (outcome === TIMED_OUT) {
      await release(ctx, reservation, "timeout");
      return failed("timeout");
    }
    if (outcome.status !== "DONE") {
      await release(ctx, reservation, "failed");
      return failed(
        outcome.status === "FAILED" && outcome.code === "BUDGET_EXCEEDED"
          ? "limit"
          : "error",
      );
    }
    return { ok: true, rows: outcome.rows ?? [] };
  } catch (error) {
    logError("research failed", error);
    await release(ctx, reservation, "error");
    return failed("error");
  }
}

// The profile: the dossier as it is now, the extension call (services and
// more, each item with its own score), fill-empty writes, rows.
async function profileStep(
  ctx: Ctx,
  researchRows: Row[],
): Promise<{ rows: Row[]; ran: boolean }> {
  const { d, facts, scope } = ctx;
  const projectId = ctx.access.projectId;
  const idFor = (field: FieldId, text: string) =>
    candidateIdFor(projectId, field, text);

  let rows = cleanRows(researchRows, projectId);
  let snapshot: DossierSnapshot | null = null;
  try {
    snapshot = await d.dossier.read(scope.brandId);
    rows = seedFromDossier(rows, snapshot);
  } catch (error) {
    logError("could not read the dossier", error);
  }

  // A mock model would write invented text into a real dossier.
  if (d.isMock() || snapshot === null) return { rows, ran: false };

  try {
    const out = await d.extend(scope, extensionFacts({ facts, rows }));
    const merged = mergeExtension(rows, out, idFor);
    rows = merged.rows;

    // Fill-empty, decided again from what the dossier holds right NOW.
    const now = await d.dossier.read(scope.brandId);
    const writes: Partial<Record<ExtendField, string[]>> = {};
    const unwritten: Partial<Record<ExtendField, string[]>> = {};
    for (const field of LIST_FIELDS) {
      const items = merged.dossierWrites[field];
      if (!items || items.length === 0) continue;
      if (now[DOSSIER_KEY[field]].length === 0) writes[field] = items;
      else unwritten[field] = items;
    }
    if (Object.keys(writes).length > 0) {
      await d.dossier.fillLists(scope, writes);
    }
    rows = demoteUnwritten(rows, unwritten, idFor);
  } catch (error) {
    // The research rows stand; the extension is a bonus.
    logError("extension failed", error);
  }
  return { rows: cleanRows(rows, projectId), ran: true };
}

// The final status write: READY with the rows, or FAILED. It must land: a few
// more tries than a stage write, and FAILED/error when even that cannot.
async function finish(
  ctx: Ctx,
  result:
    | { ok: true; rows: Row[]; profile: StageState }
    | { ok: false; failure: FailReason; research: boolean },
): Promise<void> {
  const base = (record: DiscoveryRecord): DiscoveryRecord =>
    result.ok
      ? {
          ...record,
          status: "READY",
          failure: null,
          rows: upsertRows(record.rows, result.rows),
          stages: { ...record.stages, profile: result.profile },
        }
      : {
          ...record,
          status: "FAILED",
          failure: result.failure,
          stages: {
            ...record.stages,
            ...(result.research ? { research: "failed" as const } : {}),
          },
        };

  // The patch helper refuses unless the row is still RUNNING and ours.
  const written = await patch(ctx, base, 6);
  if (written === "stale") return;
  if (written === "ok") {
    const durationMs = Math.max(0, ctx.d.nowMs() - ctx.startedAtMs);
    if (result.ok) {
      await audit(ctx, DISCOVERY_AUDIT.finished, {
        status: "READY",
        durationMs,
        rows: result.rows.length,
        research: ctx.steps.research,
      });
    } else {
      await audit(ctx, DISCOVERY_AUDIT.failed, {
        reason: result.failure,
        durationMs,
      });
    }
    return;
  }
  // The READY/FAILED write could not land: the job records FAILED/error.
  const fallback = await patch(
    ctx,
    (record) => ({ ...record, status: "FAILED", failure: "error" }),
    6,
  );
  if (fallback !== "stale") {
    await audit(ctx, DISCOVERY_AUDIT.failed, {
      reason: "error",
      durationMs: Math.max(0, ctx.d.nowMs() - ctx.startedAtMs),
    });
  }
}

// Never throws.
async function runJob(ctx: Ctx, domain: string | null): Promise<void> {
  try {
    const { steps } = ctx;
    const reading = Boolean(domain) && (steps.identity || steps.channels);
    if (reading) await setStage(ctx, "site", "running");

    const readSite = async () => {
      const [identity, channels] = await Promise.all([
        steps.identity && domain ? identityStep(ctx, domain) : true,
        steps.channels && domain ? channelsStep(ctx, domain) : true,
      ]);
      if (reading) {
        // Nothing of the site could be read at all.
        await setStage(ctx, "site", identity || channels ? "done" : "failed");
      }
    };

    const research = async (): Promise<
      { ok: true; profile: StageState; rows: Row[] } | ResearchFailure
    > => {
      let researchRows: Row[] = [];
      if (steps.research) {
        const outcome = await researchStep(ctx);
        if (!outcome.ok) {
          return { ok: false, failure: outcome.failure, research: true };
        }
        researchRows = outcome.rows;
        await setStage(ctx, "research", "done");
      }
      await setStage(ctx, "profile", "running");
      const profile = await profileStep(ctx, researchRows);
      // Nothing to write with (mock model, no research): skipped, not done.
      const state: StageState =
        profile.ran || steps.research ? "done" : "skipped";
      return { ok: true, profile: state, rows: profile.rows };
    };

    const [, outcome] = await Promise.all([readSite(), research()]);
    await finish(ctx, outcome);
  } catch (error) {
    logError("job failed", error);
    await finish(ctx, { ok: false, failure: "error", research: false });
  }
}

type ResearchFailure = { ok: false; failure: FailReason; research: boolean };

// --- the doors -----------------------------------------------------------------

export async function startDiscovery(input: {
  access: DiscoveryAccess;
  schedule: Schedule;
  offer: IntakeOffer;
  deps?: FlowDeps;
}): Promise<FlowResult | null> {
  const d = input.deps ?? (await defaultDeps());
  if (!d.enabled()) return null;
  const { access } = input;
  const facts = await d.readFacts(access.projectId);
  if (!facts) return null;

  const domain = facts.domain?.trim() || null;
  const starts = intakeStartsOf(input.offer, Boolean(domain));
  const steps: Steps = {
    identity: starts.scan && domain !== null,
    channels: domain !== null,
    research: starts.research && domain !== null,
  };
  const nowMs = d.nowMs();
  const runId = d.randomId();
  const scope: DossierScope = {
    workspaceId: access.workspaceId,
    projectId: access.projectId,
    brandId: facts.brandId,
  };

  const created = await d.store.create({
    scope,
    userId: access.userId,
    record: {
      ...emptyRecord({
        rev: "000000000000",
        nowMs,
        host: domain,
        stages: {
          site: steps.identity || steps.channels ? "pending" : "skipped",
          identity: steps.identity ? "pending" : "skipped",
          research: steps.research ? "pending" : "skipped",
          profile: "pending",
        },
      }),
      runId,
    },
  });
  // Idempotent: a reload, a second tab and a double tap start nothing.
  if (created.status === "EXISTS") {
    return {
      started: false,
      view: viewOf(created.record, nowMs, facts.brandName),
    };
  }

  const ctx: Ctx = {
    d,
    access,
    facts,
    scope,
    runId,
    attemptNo: 1,
    steps,
    startedAtMs: nowMs,
  };
  await audit(
    ctx,
    DISCOVERY_AUDIT.started,
    { scan: steps.identity, research: steps.research, site: domain !== null },
    access.userId,
  );
  input.schedule(() => runJob(ctx, domain));
  return {
    started: true,
    view: viewOf(created.record, nowMs, facts.brandName),
  };
}

// An explicit "Try again" tap: only a FAILED row (a RUNNING row past the stale
// window reads as FAILED and counts), only while attempts are left. Identity
// and channels are not read again; the research runs through the same
// reserve/claim/run path and counts one more attempt.
export async function retryDiscovery(input: {
  access: DiscoveryAccess;
  schedule: Schedule;
  deps?: FlowDeps;
}): Promise<FlowResult | null> {
  const d = input.deps ?? (await defaultDeps());
  if (!d.enabled()) return null;
  const { access } = input;
  const facts = await d.readFacts(access.projectId);
  if (!facts) return null;

  const domain = facts.domain?.trim() || null;
  const gates = d.gates(access.workspaceId);
  const nowMs = d.nowMs();
  const runId = d.randomId();
  const research =
    domain !== null && gates.enabled && !gates.mock && gates.providerOk;

  const modified = await d.store.modify<{ attemptNo: number }>(access.projectId, (record) => {
    const stale =
      record.status === "RUNNING" &&
      nowMs - record.updatedAtMs > DISCOVERY_CAPS.staleRunningMs;
    if (record.status !== "FAILED" && !stale) return { error: "not_failed" };
    if (record.attempts >= DISCOVERY_CAPS.maxAttempts) {
      return { error: "exhausted" };
    }
    return {
      next: {
        ...record,
        status: "RUNNING",
        failure: null,
        runId,
        updatedAtMs: nowMs,
        stages: { ...record.stages, research: "pending", profile: "pending" },
      },
      value: { attemptNo: record.attempts + 1 },
    };
  });
  if (modified.status === "NONE") return null;
  if (modified.status === "REJECTED") {
    // Not retryable right now: report the row as it is, start nothing (a
    // read only, nothing is written).
    const current = await d.store.read(access.projectId);
    return current
      ? { started: false, view: viewOf(current, nowMs, facts.brandName) }
      : null;
  }

  const scope: DossierScope = {
    workspaceId: access.workspaceId,
    projectId: access.projectId,
    brandId: facts.brandId,
  };
  const ctx: Ctx = {
    d,
    access,
    facts,
    scope,
    runId,
    attemptNo: modified.value.attemptNo,
    steps: { identity: false, channels: false, research },
    startedAtMs: nowMs,
  };
  await audit(
    ctx,
    DISCOVERY_AUDIT.started,
    { scan: false, research, site: domain !== null, retry: true },
    access.userId,
  );
  input.schedule(() => runJob(ctx, domain));
  return {
    started: true,
    view: viewOf(modified.record, nowMs, facts.brandName),
  };
}

// --- production wiring ---------------------------------------------------------

// Built lazily, with dynamic imports: a caller that injects every dependency
// (the tests) never loads a model client, the database or the fetcher.
async function defaultDeps(): Promise<FlowDeps> {
  const [
    { randomBytes },
    { prisma },
    store,
    flag,
    limits,
    quick,
    identityMod,
    extractMod,
    scanMod,
    safeFetchMod,
    reasoning,
    extendPrompt,
    auditRepo,
    swatches,
  ] = await Promise.all([
    import("node:crypto"),
    import("@/lib/prisma"),
    import("./store"),
    import("@/server/guided-setup/flag"),
    import("@/server/guided-setup/limits"),
    import("@/server/brand/quick-discovery"),
    import("@/server/brand/site-scan/auto-identity"),
    import("@/server/brand/site-scan/extract"),
    import("@/server/brand/site-scan/scan"),
    import("@/server/security/safe-fetch"),
    import("@/server/reasoning/reasoning-service"),
    import("@/server/reasoning/prompts/discovery-extend"),
    import("@/server/repositories/audit-log.repository"),
    import("@/lib/color-swatches"),
  ]);

  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 12)
      : [];

  const htmlFetch = {
    maxBytes: 600_000,
    truncate: true,
    timeoutMs: 12_000,
    accept: "text/html,application/xhtml+xml",
    allowedContentTypes: /^(text\/html|application\/xhtml\+xml)/i,
  } as const;

  return {
    enabled: flag.isGuidedSetupEnabled,
    nowMs: () => Date.now(),
    randomId: () => randomBytes(6).toString("hex"),
    store: {
      read: (projectId) => store.readDiscovery(projectId),
      create: (args) => store.createDiscoveryIfAbsent(args),
      modify: (projectId, change, options) =>
        store.modifyDiscovery(projectId, change, options),
    },
    readFacts: async (projectId) => {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: {
          name: true,
          domain: true,
          language: true,
          country: true,
          brands: {
            where: { isDefault: true },
            select: { id: true, name: true },
            take: 1,
          },
        },
      });
      const brand = project?.brands[0];
      if (!project || !brand) return null;
      return {
        brandId: brand.id,
        brandName: brand.name || project.name,
        domain: project.domain?.trim() || null,
        language: project.language || "tr",
        country: project.country || "TR",
      };
    },
    gates: flag.discoveryGates,
    caps: flag.discoveryCaps,
    reserve: limits.reserveDiscovery,
    release: limits.releaseDiscovery,
    qd: {
      claim: (projectId, options) =>
        quick.QuickDiscoveryService.claim(projectId, options),
      run: (target, deps) => quick.QuickDiscoveryService.run(target, deps),
    },
    identity: (scope, args) => identityMod.autoFillBrandIdentity(scope, args),
    readIdentity: async (brandId) => {
      const [dossier, identity] = await Promise.all([
        prisma.brandDossier.findUnique({
          where: { brandId },
          select: {
            logoAssetId: true,
            darkLogoAssetId: true,
            approvedFonts: true,
          },
        }),
        prisma.brandVisualIdentity.findUnique({
          where: { brandId },
          select: {
            primaryColors: true,
            secondaryColors: true,
            accentColors: true,
            photographyStyle: true,
            styleRefinement: true,
            moodTags: true,
          },
        }),
      ]);
      return {
        logo: Boolean(dossier?.logoAssetId || dossier?.darkLogoAssetId),
        colors:
          swatches.parseColorSwatches(identity?.primaryColors).length +
          swatches.parseColorSwatches(identity?.secondaryColors).length +
          swatches.parseColorSwatches(identity?.accentColors).length,
        fonts: swatches.parseFontNames(dossier?.approvedFonts).length,
        style: Boolean(
          identity?.photographyStyle ||
          identity?.styleRefinement?.trim() ||
          (identity?.moodTags?.length ?? 0) > 0,
        ),
      };
    },
    fetchSocials: async (domain) => {
      let first: string;
      try {
        first = scanMod.normalizeScanUrl(domain);
      } catch {
        return null;
      }
      // A bare host defaults to https; some sites only answer on http.
      const tries = /^[a-z][a-z0-9+.-]*:\/\//i.test(domain)
        ? [first]
        : [first, first.replace(/^https:/, "http:")];
      for (const url of tries) {
        try {
          const response = await safeFetchMod.safeFetch(url, htmlFetch);
          return extractMod.extractSocialLinks(
            response.body.toString("utf-8"),
            response.url,
          );
        } catch (error) {
          if (error instanceof safeFetchMod.UnsafeUrlError) return null;
        }
      }
      return null;
    },
    dossier: {
      read: async (brandId) => {
        const row = await prisma.brandDossier.findUnique({
          where: { brandId },
          select: {
            summary: true,
            positioning: true,
            toneOfVoice: true,
            targetAudiences: true,
            markets: true,
            products: true,
            services: true,
            visualGuidelines: true,
          },
        });
        return {
          summary: row?.summary?.trim() ?? "",
          positioning: row?.positioning?.trim() ?? "",
          toneOfVoice: row?.toneOfVoice?.trim() ?? "",
          targetAudiences: strings(row?.targetAudiences),
          markets: strings(row?.markets),
          products: strings(row?.products),
          services: strings(row?.services),
          visualGuidelines: strings(row?.visualGuidelines),
        };
      },
      fillLists: async (scope, data) => {
        await prisma.brandDossier.upsert({
          where: { brandId: scope.brandId },
          create: { ...scope, ...data },
          update: data,
        });
      },
    },
    isMock: () => reasoning.ReasoningService.isMockMode(),
    extend: async (scope, facts) => {
      const called = await reasoning.ReasoningService.run(
        extendPrompt.discoveryExtendDef,
        { ...scope, context: { facts } },
      );
      return called.output;
    },
    audit: async (entry) => {
      await auditRepo.AuditLogRepository.record({
        workspaceId: entry.workspaceId,
        projectId: entry.projectId,
        brandId: entry.brandId,
        actorType: entry.actorId ? "USER" : "SYSTEM",
        ...(entry.actorId ? { actorId: entry.actorId } : {}),
        action: entry.action,
        entityType: "Project",
        entityId: entry.projectId,
        metadata: entry.metadata,
      });
    },
  };
}
