import "server-only";

import { randomBytes } from "node:crypto";

import {
  CHANNELS,
  CHANNEL_KEYS,
  type ChannelConnections,
} from "@/lib/content-channels";
import { normalizeDomain } from "@/lib/domain";
import {
  AI_TEXT_CAPS,
  AUDIT,
  BUSINESS_KINDS,
  CHANNEL_HINTS,
  DISCOVERY_LIMITS,
  EMPTY_IDEA_OPTIONS,
  MAX_DISCOVERY_ATTEMPTS,
  SEED_MAX,
  channelOptionId,
  type Answers,
  type DiscoverOutcome,
  type DiscoverResponse,
  type DiscoveryCaps,
  type GuidedSetupHost,
  type GuidedSetupPoll,
  type GuidedSetupView,
  type IdeasReason,
  type IdeasRecord,
  type IdeasView,
  type Option,
  type SaveResponse,
  type SessionRecord,
  type StepId,
} from "@/lib/guided-setup/contract";
import {
  cleanDisplayText,
  cleanPromptText,
  cleanSeedText,
} from "@/lib/guided-setup/sanitize";
import { prisma } from "@/lib/prisma";
import type { BrandConstitutionPayload } from "@/server/agency/constitution/constitution-schema";
import { baseOf, isGuidedOnly } from "@/server/brand/constitution-merge";
import {
  QuickDiscoveryService,
  type QuickDiscoveryResult,
  type QuickDiscoveryTarget,
} from "@/server/brand/quick-discovery";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import { ensureProjectActive } from "@/server/projects/activation";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";

import { discoveryCaps, discoveryGates, type DiscoveryGates } from "./flag";
import { resolveGoalMode, type GoalModeResolution } from "./goal-mode";
import {
  adoptProfile as adoptIdeas,
  buildIdeaOptions,
  claimable,
  currentValuesOf,
  finishFailed,
  finishReady,
  newRunning,
  viewOfIdeas,
} from "./ideas";
import { releaseDiscovery, reserveDiscovery } from "./limits";
import {
  effectiveStatus,
  newSession,
  seedFirstFor,
  staticFirstFor,
  summaryOf,
  withAnswers,
  type NormalizeContext,
} from "./session";
import {
  createIdeas,
  createSessionIfAbsent,
  modifyIdeas,
  modifySession,
  readIdeas,
  readSession,
  STORE_CONFLICT,
  type StoreScope,
} from "./store";

// The guided-setup service (spec 5.2, 7, 8): entry, start, save, poll and
// discover, plus loadGuidedHost for the project page.
//
// Ground rules, each pinned by a test:
//  - start, save and poll never spend anything and never call Quick Discovery;
//    poll writes nothing at all. start and discover (once the flag gates pass)
//    also call the injected ensureActive, which may activate a CREATED project
//    and upsert its agency rows: the one write besides the session and ideas
//    rows, invisible to tests that stub ensureActive.
//  - discover is the only paid door: it claims the ideas row, takes a durable
//    reservation and asks Quick Discovery for exactly one run per claim.
//  - Nothing here imports next/server: the route hands in `schedule` (after()).
//  - Everything with side effects or a clock is injected, so a test replays any
//    interleaving on the in-memory fakes without touching a database.

// Who is asking. The route builds it from requireUser + requireProjectAccess.
export type GuidedAccess = {
  userId: string;
  workspaceId: string;
  projectId: string;
  defaultBrandId?: string;
};

export type GuidedSetupDeps = {
  nowMs: () => number;
  // A short random hex id (revs, run ids).
  randomId: () => string;
  qd: {
    claim: (
      projectId: string,
      options: { guided: true },
    ) => Promise<QuickDiscoveryTarget | null>;
    run: (target: QuickDiscoveryTarget) => Promise<QuickDiscoveryResult>;
  };
  gates: (workspaceId: string) => DiscoveryGates;
  caps: () => DiscoveryCaps;
  getChannelConnections: (projectId: string) => Promise<ChannelConnections>;
  ensureActive: (projectId: string) => Promise<unknown>;
  resolveGoalMode: (
    projectId: string,
    deps?: { connections?: ChannelConnections },
  ) => Promise<GoalModeResolution>;
  // How long the runner waits for Quick Discovery (default DISCOVERY_LIMITS).
  runDeadlineMs?: number;
};

export type SaveResult =
  | { kind: "OK"; response: SaveResponse }
  // The session is APPLYING right now (409 BUSY).
  | { kind: "BUSY" }
  // `start` has not run (400 INVALID).
  | { kind: "NO_SESSION" };

export type DiscoverResult =
  | { kind: "OK"; response: DiscoverResponse }
  | { kind: "NO_SESSION" }
  // Something unexpected: whatever was taken has been released. The route
  // answers a generic 500 FAILED (never the message).
  | { kind: "FAILED" };

type Schedule = (job: () => Promise<void>) => void;

type Project = {
  name: string;
  domain: string | null;
  language: string;
  status: string;
};

type Profile = {
  // An ACTIVE, non-mock constitution exists.
  hasProfile: boolean;
  // ... and it is a researched one (parses, not the sheet's own thin write).
  researched: BrandConstitutionPayload | null;
  version: number | null;
  // The raw row, for the display-only "Current" lines.
  row: { isMock: boolean; payload: unknown } | null;
};

const TIMED_OUT = Symbol("timed out");

// Stops WAITING, never the work: an orphan that finishes later still publishes
// its constitution and the next start/discover adopts it for free. A rejection
// of the abandoned work is swallowed (it must not become unhandled).
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

const scopeOf = (access: GuidedAccess): StoreScope => ({
  workspaceId: access.workspaceId,
  projectId: access.projectId,
  ...(access.defaultBrandId ? { brandId: access.defaultBrandId } : {}),
});

async function readProject(projectId: string): Promise<Project | null> {
  return prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true, domain: true, language: true, status: true },
  });
}

async function readProfile(projectId: string): Promise<Profile> {
  const row = await prisma.brandConstitution.findFirst({
    where: { projectId, status: "ACTIVE" },
    orderBy: { version: "desc" },
    select: { isMock: true, payload: true, version: true },
  });
  // A MOCK row is never a profile (seed and test runs fill the shared dev
  // database with them), and a guided-only one is the person's own words.
  const base = baseOf(row);
  return {
    hasProfile: row !== null && !row.isMock,
    researched:
      base.kind === "base" && !isGuidedOnly(base.payload) ? base.payload : null,
    version: row?.version ?? null,
    row: row ? { isMock: row.isMock, payload: row.payload } : null,
  };
}

// The project's own goal, for the display-only "Current" line. Best effort.
async function readGoalTitle(projectId: string): Promise<string | null> {
  try {
    const goal = await prisma.projectGoal.findFirst({
      where: {
        projectId,
        isMock: false,
        status: { in: ["ACTIVE", "APPROVED"] },
      },
      orderBy: { createdAt: "desc" },
      select: { title: true },
    });
    return goal?.title ?? null;
  } catch {
    return null;
  }
}

// A business answer that is a kind of business or the person's own words: what
// makes a paid run worth starting when there is no website.
function hasBusinessInput(answers: SessionRecord["answers"]): boolean {
  const answer = answers.business;
  if (!answer) return false;
  return (
    Boolean(answer.other?.trim()) ||
    answer.picked.some((id) => BUSINESS_KINDS.some((kind) => kind.id === id))
  );
}

function hasInputOf(
  project: Pick<Project, "domain"> | null,
  session: SessionRecord | null,
): boolean {
  return (
    Boolean(project?.domain?.trim()) ||
    Boolean(session?.seed?.text.trim()) ||
    (session ? hasBusinessInput(session.answers) : false)
  );
}

const hostOf = (project: Pick<Project, "domain"> | null): string | null => {
  const domain = project?.domain?.trim();
  return domain ? normalizeDomain(domain) : null;
};

// The business the person named, as it may enter the paid prompt: a catalog
// label (code), a stored (already sanitized) option label or their typed words
// through cleanPromptText. Anything that fails the filter is omitted.
function businessLabelOf(
  answers: SessionRecord["answers"],
  ideas: IdeasRecord | null,
): string | null {
  const answer = answers.business;
  if (!answer) return null;
  if (answer.other?.trim()) return cleanPromptText(answer.other, 140);
  const id = answer.picked[0];
  if (!id) return null;
  const kind = BUSINESS_KINDS.find((candidate) => candidate.id === id);
  if (kind) return kind.label;
  const stored = ideas?.options.business.find((option) => option.id === id);
  return stored ? cleanPromptText(stored.label, AI_TEXT_CAPS.identity) : null;
}

const PROMPT_DESCRIPTION_MAX = SEED_MAX;
const DESCRIPTION_SEPARATOR = " | ";

// What enters the paid, search-enabled prompt (spec 8.4): only text that went
// through cleanPromptText, at most 500 code points, whole code points only.
export function buildDiscoveryDescription(input: {
  seed: string | null | undefined;
  business: string | null;
}): string | undefined {
  const seed = cleanPromptText(input.seed, SEED_MAX);
  const business = input.business
    ? `Kind of business: ${input.business}`
    : null;
  const businessLength = business ? Array.from(business).length : 0;
  let seedPart = seed;
  if (seedPart && business) {
    const room =
      PROMPT_DESCRIPTION_MAX -
      Array.from(DESCRIPTION_SEPARATOR).length -
      businessLength;
    if (Array.from(seedPart).length > room) {
      seedPart = room > 0 ? Array.from(seedPart).slice(0, room).join("") : null;
      seedPart = seedPart?.trimEnd() || null;
    }
  }
  const parts = [seedPart, business].filter((part): part is string =>
    Boolean(part),
  );
  if (parts.length === 0) return undefined;
  return parts.join(DESCRIPTION_SEPARATOR);
}

// The connected account's name for the hint. A leading "@" is kept apart: the
// display filter rejects "@" (a marker), which would turn every Instagram
// handle into a plain "Connected". Anything else that looks like a link, a
// marker or an instruction still drops the whole label.
function cleanAccountLabel(label: string | undefined): string | null {
  const raw = label?.trim() ?? "";
  const at = raw.startsWith("@") ? "@" : "";
  const cleaned = cleanDisplayText(raw.slice(at.length), 40 - at.length);
  return cleaned ? `${at}${cleaned}` : null;
}

// The six channel rows with their live state. `connected` is set only for a
// channel that has something to connect (Blog/SEO has nothing).
function channelRowsOf(connections: ChannelConnections): Option[] {
  return CHANNEL_KEYS.map((key) => {
    const connection = connections[key];
    const account = connection?.connected
      ? cleanAccountLabel(connection.accountLabel)
      : null;
    const hint = connection?.connected
      ? account
        ? `Connected as ${account}`
        : "Connected"
      : CHANNEL_HINTS[key];
    return {
      id: channelOptionId(key),
      label: CHANNELS[key].label,
      hint,
      ...(connection ? { connected: connection.connected } : {}),
    };
  });
}

// Closed vocabulary for the audit trail (no free text, spec 14).
type ReleaseReason = "lost" | "busy" | "inactive" | "profile" | "error";

export function createGuidedSetupService(deps: GuidedSetupDeps) {
  const now = () => deps.nowMs();

  // Errors are swallowed on purpose: activation is a courtesy (a CREATED
  // project would otherwise strand ideas as "inactive"), never a requirement.
  async function activate(projectId: string): Promise<void> {
    try {
      await deps.ensureActive(projectId);
    } catch {
      // Best effort (spec 8.4 step 0).
    }
  }

  function ideasViewFor(input: {
    record: IdeasRecord | null;
    gates: DiscoveryGates;
    profile: Profile | null;
    project: Pick<Project, "domain"> | null;
    session: SessionRecord | null;
  }): IdeasView {
    return viewOfIdeas({
      record: input.record,
      nowMs: now(),
      gates: input.gates,
      hasResearchedProfile: input.profile?.researched != null,
      hasInput: hasInputOf(input.project, input.session),
      host: hostOf(input.project),
    });
  }

  // Free adoption of an existing researched profile into the ideas row: no
  // paid call, options only fill an empty question. Returns whether a row was
  // written.
  async function adoptFromProfile(
    access: GuidedAccess,
    profile: Profile,
  ): Promise<boolean> {
    if (!profile.researched) return false;
    const built = buildIdeaOptions(profile.researched);
    if (built.stats.kept < 1) return false;
    const input = {
      ...built,
      ...(profile.version !== null ? { version: profile.version } : {}),
    };
    const existing = await readIdeas(access.projectId);
    if (existing === null) {
      const change = adoptIdeas(null, {
        ...input,
        nowMs: now(),
        rev: deps.randomId(),
      });
      if ("error" in change) return false;
      const created = await createIdeas({
        scope: scopeOf(access),
        userId: access.userId,
        record: change.next,
      });
      // Somebody else made the row in between: fill it below instead.
      if (created.status !== "EXISTS") return true;
    }
    const modified = await modifyIdeas(access.projectId, (record) =>
      adoptIdeas(record, { ...input, nowMs: now(), rev: deps.randomId() }),
    );
    return modified.status === "OK";
  }

  // -------------------------------------------------------------------------
  // entry: what the project page needs for its first frame
  // -------------------------------------------------------------------------

  async function entry(
    projectId: string,
  ): Promise<Omit<GuidedSetupHost, "requested">> {
    const [record, ideas, project, profile] = await Promise.all([
      readSession(projectId),
      readIdeas(projectId),
      readProject(projectId),
      readProfile(projectId),
    ]);
    if (!project) throw new Error("guided setup: project not found");
    return {
      summary: summaryOf(record, {
        hasProfile: profile.hasProfile,
        // A paid run only: the free row adopted from the profile (source
        // "profile") or a refunded claim (no attempt left standing) must not
        // make an established, untouched brand read as "continue setup".
        discoveryRunExists:
          ideas?.source === "discovery" && ideas.attempts > 0,
      }),
      // The stored decision wins: the step order never changes under a person.
      seedFirst: record
        ? record.seedFirst
        : seedFirstFor({
            domain: project.domain,
            hasResearchedProfile: profile.researched !== null,
          }),
      languageCode: project.language,
    };
  }

  // -------------------------------------------------------------------------
  // start: idempotent, never paid, never Quick Discovery
  // -------------------------------------------------------------------------

  async function start(input: {
    access: GuidedAccess;
    seedCommandId?: string;
  }): Promise<GuidedSetupView> {
    const { access } = input;
    const { projectId } = access;
    await activate(projectId);

    const [project, profile] = await Promise.all([
      readProject(projectId),
      readProfile(projectId),
    ]);
    if (!project) throw new Error("guided setup: project not found");
    const gates = deps.gates(access.workspaceId);

    let session = await readSession(projectId);
    if (!session) {
      // The words come from the Command row itself: a model or a client can
      // never supply them, and only a same-project web chat message counts.
      let seedText: string | null = null;
      if (input.seedCommandId) {
        const row = await prisma.command.findFirst({
          where: {
            id: input.seedCommandId,
            projectId,
            source: "WEB",
            topic: null,
            ideaId: null,
          },
          select: { rawText: true },
        });
        seedText = cleanSeedText(row?.rawText);
      }
      const created = await createSessionIfAbsent({
        scope: scopeOf(access),
        userId: access.userId,
        record: newSession({
          rev: deps.randomId(),
          editRev: deps.randomId(),
          nowMs: now(),
          userId: access.userId,
          // Decided ONCE here and stored: the order never moves later.
          seedFirst: seedFirstFor({
            domain: project.domain,
            hasResearchedProfile: profile.researched !== null,
          }),
          staticFirst: staticFirstFor({
            gates,
            hasResearchedProfile: profile.researched !== null,
          }),
          seedText,
        }),
      });
      session = created.record;
    }

    // A researched profile already gives the questions their options, for free.
    if (profile.researched) await adoptFromProfile(access, profile);
    const ideas = await readIdeas(projectId);

    // Read once: the channel rows and the goal mode share it. When the read
    // fails the resolver reads (and fails safe) by itself: an empty map would
    // wrongly say "nothing connected".
    let connections: ChannelConnections | undefined;
    try {
      connections = await deps.getChannelConnections(projectId);
    } catch {
      connections = undefined;
    }
    const [resolution, goalTitle] = await Promise.all([
      deps
        .resolveGoalMode(projectId, connections ? { connections } : undefined)
        .catch((): GoalModeResolution => ({ mode: "proposed", handsOn: null })),
      readGoalTitle(projectId),
    ]);

    const seed = session.seed?.text
      ? cleanDisplayText(session.seed.text, 100)
      : null;
    const view: GuidedSetupView = {
      rev: session.editRev,
      status: effectiveStatus(session, now()),
      step: session.step,
      more: session.more,
      answers: session.answers,
      ...(seed ? { seed } : {}),
      brand: {
        name: project.name,
        host: hostOf(project),
        languageCode: project.language,
      },
      current: currentValuesOf(profile.row, goalTitle),
      seedFirst: session.seedFirst,
      staticFirst: session.staticFirst,
      hasProfile: profile.hasProfile,
      projectActive: project.status === "ACTIVE",
      goalMode: resolution.mode,
      handsOn: resolution.handsOn,
      channels: channelRowsOf(connections ?? {}),
      ideas: ideasViewFor({
        record: ideas,
        gates,
        profile,
        project,
        session,
      }),
    };
    if (session.applied) {
      view.appliedAt = new Date(session.applied.atMs).toISOString();
    }
    return view;
  }

  // -------------------------------------------------------------------------
  // save: whole answers, CAS write, answers with the ideas view
  // -------------------------------------------------------------------------

  async function save(input: {
    access: GuidedAccess;
    step: StepId;
    more: boolean;
    answers: Answers;
  }): Promise<SaveResult> {
    const { access } = input;
    const ideas = await readIdeas(access.projectId);
    const ctx: NormalizeContext = {
      channelIds: CHANNEL_KEYS.map(channelOptionId),
      // Only options the server stored can be picked: no client-made o_ id.
      ideas: ideas?.options ?? EMPTY_IDEA_OPTIONS,
    };
    const rev = deps.randomId();
    const editRev = deps.randomId();

    const result = await modifySession(access.projectId, (record) => {
      const written = withAnswers(record, {
        step: input.step,
        more: input.more,
        answers: input.answers,
        nowMs: now(),
        userId: access.userId,
        ctx,
        rev,
        editRev,
      });
      return "error" in written
        ? { error: written.error }
        : { next: written.next, value: null };
    });
    if (result.status === "NONE") return { kind: "NO_SESSION" };
    if (result.status === "REJECTED") {
      if (result.error === "BUSY") return { kind: "BUSY" };
      // Lost the compare-and-swap every attempt (another tab saved at the same
      // moment): retryable, not a server fault.
      if (result.error === STORE_CONFLICT) return { kind: "BUSY" };
      throw new Error(`guided setup: save failed (${result.error})`);
    }

    // Saving the business answer is what makes a paid run possible: the offer
    // must follow without a reload.
    const [project, profile] = await Promise.all([
      readProject(access.projectId),
      readProfile(access.projectId),
    ]);
    return {
      kind: "OK",
      response: {
        rev: result.record.editRev,
        status: effectiveStatus(result.record, now()),
        ideas: ideasViewFor({
          record: ideas,
          gates: deps.gates(access.workspaceId),
          profile,
          project,
          session: result.record,
        }),
      },
    };
  }

  // -------------------------------------------------------------------------
  // poll: two primary-key reads, no writes
  // -------------------------------------------------------------------------

  async function poll(input: {
    access: GuidedAccess;
  }): Promise<GuidedSetupPoll | null> {
    const { access } = input;
    const [session, ideas] = await Promise.all([
      readSession(access.projectId),
      readIdeas(access.projectId),
    ]);
    if (!session) return null;
    return {
      rev: session.editRev,
      status: effectiveStatus(session, now()),
      // Derived from the record and the gates only (rows 1, 5, 6 and 7 of the
      // view table ignore the other inputs).
      ideas: viewOfIdeas({
        record: ideas,
        nowMs: now(),
        gates: deps.gates(access.workspaceId),
        hasResearchedProfile: false,
        hasInput: true,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // discover: the only paid door (spec 8.4)
  // -------------------------------------------------------------------------

  async function failClaim(
    projectId: string,
    runId: string,
    reason: IdeasReason,
    refund: boolean,
  ): Promise<void> {
    try {
      await modifyIdeas(
        projectId,
        (record) =>
          finishFailed(record, runId, reason, { nowMs: now(), refund }),
        { attempts: 5 },
      );
    } catch (error) {
      console.error(
        "[guided-setup] could not release the ideas claim:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  async function releaseReservation(
    reservation: { auditId: string; runId: string; attempt: number },
    reason: ReleaseReason,
  ): Promise<void> {
    try {
      await releaseDiscovery({ ...reservation, reason });
    } catch (error) {
      console.error(
        "[guided-setup] could not release the discovery reservation:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  async function readCost(
    reasoningCallId: string | undefined,
  ): Promise<{ costUsd?: number; webSearchCalls?: number }> {
    const out: { costUsd?: number; webSearchCalls?: number } = {};
    if (!reasoningCallId) return out;
    // Both are lower bounds and best effort: a failed read leaves them out and
    // never fails the run.
    try {
      const call = await prisma.reasoningCall.findUnique({
        where: { id: reasoningCallId },
        select: { costUsd: true },
      });
      if (typeof call?.costUsd === "number" && Number.isFinite(call.costUsd)) {
        out.costUsd = call.costUsd;
      }
    } catch {
      // Left out.
    }
    try {
      const row = await prisma.auditLog.findFirst({
        where: {
          action: "reasoning.brand.quickDiscovery",
          entityType: "ReasoningCall",
          entityId: reasoningCallId,
        },
        select: { metadata: true },
      });
      if (row) {
        const calls = (row.metadata as { webSearchCalls?: unknown } | null)
          ?.webSearchCalls;
        // The reasoning audit row omits the field when there was no search.
        out.webSearchCalls =
          typeof calls === "number" && Number.isFinite(calls) ? calls : 0;
      }
    } catch {
      // Left out.
    }
    return out;
  }

  // WORKSPACE-LEVEL row: no projectId and no brandId (the caps' rows must
  // survive a project deletion, and so must the calibration numbers).
  async function auditFinished(
    access: GuidedAccess,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await AuditLogRepository.record({
        workspaceId: access.workspaceId,
        actorType: "SYSTEM",
        action: AUDIT.discoveryFinished,
        entityType: "Project",
        entityId: access.projectId,
        metadata,
      });
    } catch (error) {
      console.error(
        "[guided-setup] could not audit the finished run:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  // Never throws; its final write is guarded by runId (a stale runner cannot
  // overwrite a newer attempt).
  async function runDiscovery(input: {
    access: GuidedAccess;
    target: QuickDiscoveryTarget;
    runId: string;
    host: string | undefined;
  }): Promise<void> {
    const { access, target, runId } = input;
    const startedAt = now();
    const durationMs = () => Math.max(0, now() - startedAt);
    try {
      const outcome = await raceDeadline(
        deps.qd.run(target),
        deps.runDeadlineMs ?? DISCOVERY_LIMITS.runDeadlineMs,
      );

      if (outcome !== TIMED_OUT && outcome.status === "DONE") {
        const profile = await readProfile(access.projectId);
        const base = baseOf(profile.row);
        if (base.kind !== "base") {
          // A finished run whose constitution cannot be read back.
          await failClaim(access.projectId, runId, "failed", false);
          await auditFinished(access, {
            status: "FAILED",
            durationMs: durationMs(),
            reason: "failed",
          });
          return;
        }
        const built = buildIdeaOptions(base.payload);
        const cost = await readCost(outcome.reasoningCallId);
        await modifyIdeas(
          access.projectId,
          (record) =>
            finishReady(record, runId, {
              ...built,
              nowMs: now(),
              pages: outcome.pages,
              version: outcome.version,
              ...(input.host !== undefined ? { host: input.host } : {}),
            }),
          { attempts: 5 },
        );
        await auditFinished(access, {
          status: "DONE",
          durationMs: durationMs(),
          pages: outcome.pages,
          kept: built.stats.kept,
          dropped: built.stats.dropped,
          ...cost,
        });
        return;
      }

      // Timed out, FAILED (also "a profile already exists" from Quick
      // Discovery's late-landing check) or an unexpected PENDING.
      const reason: IdeasReason =
        outcome === TIMED_OUT
          ? "timeout"
          : outcome.status === "FAILED" && outcome.code === "BUDGET_EXCEEDED"
            ? "limit"
            : "failed";
      await failClaim(access.projectId, runId, reason, false);
      await auditFinished(access, {
        status: "FAILED",
        durationMs: durationMs(),
        reason,
      });
      // A profile may exist now (the orphan of a deadline, or the one that made
      // Quick Discovery decline): adopting it is free.
      const profile = await readProfile(access.projectId);
      if (profile.researched) await adoptFromProfile(access, profile);
    } catch (error) {
      console.error(
        "[guided-setup] discovery runner failed:",
        error instanceof Error ? error.message : error,
      );
      await failClaim(access.projectId, runId, "failed", false);
    }
  }

  async function discover(input: {
    access: GuidedAccess;
    schedule: Schedule;
  }): Promise<DiscoverResult> {
    const { access, schedule } = input;
    const { projectId } = access;
    const gates = deps.gates(access.workspaceId);

    const [session, ideas, project, profile] = await Promise.all([
      readSession(projectId),
      readIdeas(projectId),
      readProject(projectId),
      readProfile(projectId),
    ]);
    const viewNow = (record: IdeasRecord | null) =>
      ideasViewFor({ record, gates, profile, project, session });
    const respond = (
      outcome: DiscoverOutcome,
      ideasView: IdeasView,
    ): DiscoverResult => ({
      kind: "OK",
      response: { outcome, ideas: ideasView },
    });

    // 0. The gates: nothing else happens (no write, no Quick Discovery).
    if (!gates.enabled || gates.mock || !gates.providerOk) {
      return respond("UNAVAILABLE", viewNow(ideas));
    }
    await activate(projectId);

    // 1. `start` creates the session first.
    if (!session) return { kind: "NO_SESSION" };

    // 2. A researched profile exists: options come from it, for free.
    if (profile.researched) {
      await adoptFromProfile(access, profile);
      return respond("READY", viewNow(await readIdeas(projectId)));
    }

    // 3. What may an explicit tap do right now?
    const view = viewNow(ideas);
    if (view.status === "READY") return respond("READY", view);
    if (view.status === "RUNNING") return respond("ALREADY_RUNNING", view);
    if (!view.canStart && !view.canRetry) {
      const exhausted = (ideas?.attempts ?? 0) >= MAX_DISCOVERY_ATTEMPTS;
      return respond(exhausted ? "EXHAUSTED" : "UNAVAILABLE", view);
    }
    const decision = claimable(ideas, now());
    if (decision.kind === "ready") return respond("READY", view);
    if (decision.kind === "running") return respond("ALREADY_RUNNING", view);
    if (decision.kind === "exhausted") return respond("EXHAUSTED", view);
    if (decision.kind === "inactive") return respond("UNAVAILABLE", view);

    // What has been taken so far, so any failure below can give it back.
    const runId = deps.randomId();
    const host = hostOf(project) ?? undefined;
    let reservation: {
      auditId: string;
      runId: string;
      attempt: number;
    } | null = null;
    let claimed = false;

    try {
      // 4. The durable caps: a read-only pre-count, then insert-then-count.
      // A throw here claims nothing (fail closed, the attempt is not consumed).
      const reserved = await reserveDiscovery({
        workspaceId: access.workspaceId,
        userId: access.userId,
        projectId,
        runId,
        attempt: decision.attempts,
        nowMs: now(),
        caps: deps.caps(),
      });
      if (!reserved.ok) {
        // Nothing is stored for a refused start, so the answer itself must
        // read as "not now": an IDLE/canStart view would render the same offer
        // and a button that does nothing visible.
        return respond("LIMIT", {
          ...view,
          status: "UNAVAILABLE",
          canStart: false,
          canRetry: false,
          reason: "limit",
        });
      }
      reservation = {
        auditId: reserved.auditId,
        runId,
        attempt: decision.attempts,
      };

      // 5. Claim the ideas row: the row is what de-duplicates double clicks,
      // two tabs and reloads.
      let claimedRecord: IdeasRecord | null = null;
      if (ideas === null) {
        const created = await createIdeas({
          scope: scopeOf(access),
          userId: access.userId,
          record: newRunning({
            rev: deps.randomId(),
            runId,
            nowMs: now(),
            attempts: decision.attempts,
            host,
          }),
        });
        if (created.status !== "EXISTS") claimedRecord = created.record;
      } else {
        const modified = await modifyIdeas(projectId, (record) => {
          const again = claimable(record, now());
          if (again.kind !== "claim") return { error: again.kind };
          return {
            next: newRunning({
              rev: deps.randomId(),
              runId,
              nowMs: now(),
              attempts: again.attempts,
              host,
              base: record,
            }),
            value: null,
          };
        });
        if (modified.status === "OK") claimedRecord = modified.record;
      }
      if (!claimedRecord) {
        // Lost the claim: somebody else is running (or finished) it.
        await releaseReservation(reservation, "lost");
        reservation = null;
        const current = await readIdeas(projectId);
        const lostView = viewNow(current);
        return respond(
          lostView.status === "READY" ? "READY" : "ALREADY_RUNNING",
          lostView,
        );
      }
      claimed = true;

      // 6. Quick Discovery's own gate (cooldown, project status).
      const target = await deps.qd.claim(projectId, { guided: true });
      if (!target) {
        const [freshProject, freshProfile] = await Promise.all([
          readProject(projectId),
          readProfile(projectId),
        ]);
        const inactive =
          !freshProfile.researched && freshProject?.status !== "ACTIVE";
        await failClaim(projectId, runId, inactive ? "inactive" : "busy", true);
        claimed = false;
        await releaseReservation(
          reservation,
          freshProfile.researched ? "profile" : inactive ? "inactive" : "busy",
        );
        reservation = null;
        if (freshProfile.researched) {
          // A researched profile appeared meanwhile: adopt it, nothing was paid.
          await adoptFromProfile(access, freshProfile);
          return respond("READY", viewNow(await readIdeas(projectId)));
        }
        // A cooldown is not retryable right now: a Try again tap would only
        // repeat reserve, claim and release. The next poll or reload
        // recomputes the stored view, which offers the retry again.
        return respond("BUSY", {
          ...viewNow(await readIdeas(projectId)),
          canRetry: false,
        });
      }

      // 7. The words: only text that passed the prompt filter, else nothing.
      const description = buildDiscoveryDescription({
        seed: session.seed?.text,
        business: businessLabelOf(session.answers, ideas),
      });
      const runnable: QuickDiscoveryTarget = {
        ...target,
        ...(description ? { description } : {}),
      };
      schedule(() => runDiscovery({ access, target: runnable, runId, host }));

      return respond("STARTED", viewNow(claimedRecord));
    } catch (error) {
      console.error(
        "[guided-setup] discover failed:",
        error instanceof Error ? error.message : error,
      );
      // Whatever was taken goes back: the attempt is refunded (nothing was
      // paid) and the reservation stops counting.
      if (claimed) await failClaim(projectId, runId, "failed", true);
      if (reservation) await releaseReservation(reservation, "error");
      return { kind: "FAILED" };
    }
  }

  return { entry, start, save, poll, discover };
}

export type GuidedSetupServiceApi = ReturnType<typeof createGuidedSetupService>;

export const GuidedSetupService: GuidedSetupServiceApi =
  createGuidedSetupService({
    nowMs: () => Date.now(),
    randomId: () => randomBytes(6).toString("hex"),
    qd: {
      claim: (projectId, options) =>
        QuickDiscoveryService.claim(projectId, options),
      run: (target) => QuickDiscoveryService.run(target),
    },
    gates: discoveryGates,
    caps: discoveryCaps,
    getChannelConnections,
    ensureActive: ensureProjectActive,
    resolveGoalMode,
  });

// What the project page passes to ProjectChat. NEVER throws: when anything
// fails the feature is absent for that request instead of taking the chat down
// through the route's error boundary (guard G70).
export async function loadGuidedHost(
  projectId: string,
  requested: boolean,
  service: Pick<GuidedSetupServiceApi, "entry"> = GuidedSetupService,
): Promise<GuidedSetupHost | undefined> {
  try {
    return { ...(await service.entry(projectId)), requested };
  } catch (error) {
    console.error(
      "[guided-setup] entry failed, the page renders without setup:",
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}
