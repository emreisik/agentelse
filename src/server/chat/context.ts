import "server-only";

import { prisma } from "@/lib/prisma";
import { SETUP_STAGE } from "@/lib/labels";
import { getBrandTwin } from "@/server/brand-twin/brand-twin";
import { MemoryService } from "@/server/memory/memory-service";
import { getPublishTargets } from "@/server/integrations/meta-connection-status";
import { WorkSessionService } from "@/server/work-session/work-session-service";

import { sessionRowId } from "@/lib/guided-setup/contract";
import { parseSession } from "@/server/guided-setup/session";

import { buildAgencyCapabilities } from "./deliverables";
import { TASK_RESULTS_IN_HISTORY, taskResultOf } from "./history";
import {
  needsGuidedAppliedLookup,
  resolveLegacySetupPhase,
} from "./legacy-setup-gate";
import type { ChatPhase } from "./tools";

// Raised from 12 now that the general/single-chat branch below carries
// EVERY project pipeline event, not just idea-less ones (see the single-chat
// consolidation — docs/brand-workspace-migration.md) — a flat 12-row window
// used to be plenty for one idea's own thread; a merged multi-initiative
// stream needs more headroom so one idea's burst of activity doesn't starve
// the LLM's view of everything else going on.
const HISTORY_TURNS = 36;

// Context loading for a chat turn. Shared by the streaming agent engine
// (chat-agent.ts) and the legacy single-shot ChatService; it lives here (not
// in the legacy service) so the agent engine has no dependency on it. The
// agent also uses `recent` to build real role-tagged history messages
// instead of the flattened `history` string.
// What the client has been asking about lately, for choosing which memories
// matter: their last few messages (the newest is this turn's own, which the
// agent has already saved). A short "yes, go ahead" carries no topic by
// itself, so the messages before it supply one.
function recentUserText(
  rows: readonly { source: string; rawText: string }[],
): string {
  return rows
    .filter((row) => row.source === "WEB" && row.rawText.trim())
    .slice(-3)
    .map((row) => row.rawText.trim())
    .join("\n")
    .slice(-1_200);
}

// options.recall: the streaming agent asks for Brand Memory to be recalled for
// this conversation (only what matters, MemoryService.recall) instead of the
// store's newest entries riding along inside the brand profile. The legacy
// ChatService leaves it off and gets the profile exactly as before.
// options.session: also load the project's live work session (agent only), so
// a message that continues it starts from its checkpoint.
// options.legacyGate: guided setup is on, so the legacy onboarding gate
// (`setupPhase`) also stands down for a project that already has a profile,
// an applied guided session or a deep-research run (legacy-setup-gate.ts).
// Off, the setup-state query and the phase are exactly what they were.
export async function buildContext(
  projectId: string,
  ideaId?: string,
  options: { recall?: boolean; session?: boolean; legacyGate?: boolean } = {},
) {
  const recall = options.recall === true;
  const legacyGate = options.legacyGate === true;
  const [
    project,
    brandTwin,
    dailyStat,
    pendingApprovals,
    recent,
    setupState,
    workSession,
  ] = await Promise.all([
    prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: {
        name: true,
        domain: true,
        status: true,
        language: true,
        country: true,
      },
    }),
    // BrandTwin (src/server/brand-twin/brand-twin.ts) replaces the old
    // hand-picked BrandDossier/BrandConstitution subset here — same
    // composition the Brand Workspace right panel uses, so the chat LLM
    // sees positioning/audience/markets/voice/negativeRules/currentFocus/
    // creativePreferences/creativeMemory instead of just
    // {summary,positioning,toneOfVoice}. This is also step 4 of the spec's
    // Orchestrator ("retrieve relevant past user decisions") for free —
    // BrandTwin.creativePreferences already is the brand's recent
    // UserDecision rows.
    recall
      ? getBrandTwin(projectId, { memory: false })
      : getBrandTwin(projectId),
    latestDailyStat(projectId),
    prisma.approval.findMany({
      where: { projectId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { type: true, entityType: true, createdAt: true },
    }),
    // In an idea's chat thread (legacy deep-link, see page.tsx), history is
    // ALL messages belonging to that idea. The project-wide branch (no
    // ideaId — now the ONE primary chat) includes every WEB message and
    // every SYSTEM pipeline event project-wide (council decisions, work
    // plans, task/creative completions — regardless of which idea they
    // belong to), so the LLM replies knowing everything the pipeline just
    // did across every initiative, not just idea-less events. `topic: null`
    // excludes scoped threads that aren't this general feed — e.g. legacy
    // Command rows with topic "BRAND_BRAIN" from the now-removed Brand
    // Brain chat feature. This was previously only enforced at render time
    // (page.tsx), not here, so those turns could leak into the general
    // chat's LLM context.
    prisma.command.findMany({
      where: ideaId
        ? { ideaId, source: { in: ["WEB", "SYSTEM"] } }
        : { projectId, topic: null, source: { in: ["WEB", "SYSTEM"] } },
      orderBy: { createdAt: "desc" },
      take: HISTORY_TURNS,
      select: {
        id: true,
        source: true,
        rawText: true,
        replyText: true,
        attachments: true,
        // Only read for the finished-task result text (taskResultOf); it is
        // not passed on as-is.
        parsedIntent: true,
      },
    }),
    // Drives the NOT_STARTED/IN_PROGRESS/ACTIVE gate (see chat-turn.ts and
    // command-service.ts) — null means setup was never started at all.
    prisma.projectSetupState.findUnique({
      where: { projectId },
      select: {
        activatedAt: true,
        // Only the gate reads the run mode; a flag-off query stays as it was.
        ...(legacyGate ? { intake: true } : {}),
        stageRecords: {
          where: { status: "WAITING_CLIENT" },
          select: { stage: true },
          take: 1,
        },
      },
    }),
    // The work session this message may be continuing (agent only). An
    // optional extra: if the lookup fails the message goes on without it.
    options.session === true
      ? WorkSessionService.getLive(projectId).catch((error) => {
          console.error("[chat-context] work session lookup failed:", error);
          return null;
        })
      : Promise.resolve(null),
  ]);

  if (!brandTwin) {
    throw new Error(`Project ${projectId} has no default brand`);
  }
  const brandId = brandTwin.brandId;

  const rawSetupPhase = !setupState
    ? ("NOT_STARTED" as const)
    : setupState.activatedAt
      ? ("ACTIVE" as const)
      : ("IN_PROGRESS" as const);
  let setupPhase: "NOT_STARTED" | "IN_PROGRESS" | "ACTIVE" = rawSetupPhase;
  if (legacyGate) {
    const gate = {
      enabled: true,
      row: setupState
        ? {
            activatedAt: setupState.activatedAt,
            mode: intakeMode(
              "intake" in setupState ? setupState.intake : undefined,
            ),
          }
        : null,
      // A guided-only profile reads "medium", so it is found through
      // guidedApplied below instead.
      profileReady: brandTwin.confidence === "high",
    };
    setupPhase = resolveLegacySetupPhase({
      ...gate,
      guidedApplied: needsGuidedAppliedLookup(gate)
        ? await readGuidedApplied(projectId)
        : false,
    });
  }
  // The RAW phase on purpose: a deep-research run still reports "running" as
  // information even when it no longer blocks the chat.
  const setupWaiting = setupState?.stageRecords[0]
    ? `waiting on your decision for ${SETUP_STAGE[setupState.stageRecords[0].stage].label}`
    : rawSetupPhase === "IN_PROGRESS"
      ? "running"
      : undefined;
  // What the chat AGENT may do. Independent of setup: a project works as soon
  // as it is ACTIVE (projects/activation.ts activates it before this runs), and
  // only a paused / closed one is on hold. `setupPhase` above is kept for the
  // legacy ChatService, which still gates its onboarding on it.
  const projectPhase: ChatPhase =
    project.status === "ACTIVE" ? "ACTIVE" : "ON_HOLD";

  // The newest record comes first; reversed so the chat reads
  // chronologically. SYSTEM-sourced rows have an empty rawText (a pipeline
  // event, not a user message) — the "Client:" line is skipped and only the
  // event note is written.
  const chronological = [...recent].reverse();
  const history = chronological
    .flatMap((command) => {
      const attachmentNote = Array.isArray(command.attachments)
        ? ` [attached: ${(command.attachments as { filename?: string }[])
            .map((a) => a.filename ?? "file")
            .join(", ")}]`
        : "";
      if (command.source === "SYSTEM") {
        return command.replyText ? [`System: ${command.replyText}`] : [];
      }
      const lines = [`Client: ${command.rawText}${attachmentNote}`];
      if (command.replyText) lines.push(`You: ${command.replyText}`);
      return lines;
    })
    .join("\n");

  // The agent's role-tagged history (chat-agent.ts). Same rows, but a finished
  // task's SYSTEM row also carries what the task produced, for the newest few:
  // without it the agent only saw "Task completed" and could neither quote nor
  // adjust its own work. Older results stay behind get_task_result.
  const memory = recall
    ? await MemoryService.recall(brandId, recentUserText(chronological))
    : null;

  // Walked newest-first so the budget of results goes to the latest ones.
  let resultsLeft = TASK_RESULTS_IN_HISTORY;
  const agentHistory = [...chronological]
    .reverse()
    .map(({ parsedIntent, ...row }) => {
      const resultText =
        resultsLeft > 0 && row.source === "SYSTEM"
          ? taskResultOf(parsedIntent)
          : undefined;
      if (resultText) resultsLeft -= 1;
      return { ...row, resultText };
    })
    .reverse();

  // What the agency can hand the client right now (active departments'
  // deliverables + connected channels) — the chat agent proposes only these.
  const connectedTargets = await getPublishTargets(projectId).catch(() => []);
  const agency = buildAgencyCapabilities([
    ...new Set(connectedTargets.map((t) => t.platform)),
  ]);

  return {
    brandId,
    agency,
    project: {
      name: project.name,
      domain: project.domain,
      status: project.status,
      language: project.language,
      country: project.country,
    },
    brand: brandTwin,
    // Brand Memory recalled for this conversation (agent only; null otherwise).
    memory,
    // The project's live work session, when there is one (agent only).
    workSession,
    state: dailyStat,
    pending: pendingApprovals.map((approval) => ({
      type: approval.type,
      entityType: approval.entityType,
      waitingSince: approval.createdAt.toISOString(),
    })),
    history,
    recent: agentHistory,
    setupPhase,
    setupWaiting,
    projectPhase,
  };
}

// ProjectSetupState.intake is Json; only its run mode matters here.
function intakeMode(intake: unknown): string | null {
  if (typeof intake !== "object" || intake === null) return null;
  const mode = (intake as { mode?: unknown }).mode;
  return typeof mode === "string" ? mode : null;
}

// One primary-key read of the guided session row. A failed read is "not
// applied": the gate then keeps today's behaviour instead of failing the chat.
async function readGuidedApplied(projectId: string): Promise<boolean> {
  try {
    const row = await prisma.command.findUnique({
      where: { id: sessionRowId(projectId) },
      select: { parsedIntent: true },
    });
    return parseSession(row)?.applied != null;
  } catch (error) {
    console.error("[chat-context] guided session lookup failed:", error);
    return false;
  }
}

async function latestDailyStat(projectId: string) {
  const stat = await prisma.agencyDailyStat.findFirst({
    where: { projectId },
    orderBy: { date: "desc" },
    select: {
      date: true,
      signalsIngested: true,
      opportunitiesCreated: true,
      ideasCreated: true,
      tasksCreated: true,
    },
  });
  if (!stat) return null;
  return { ...stat, date: stat.date.toISOString().slice(0, 10) };
}
