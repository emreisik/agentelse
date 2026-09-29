import "server-only";

import { prisma } from "@/lib/prisma";
import { SETUP_STAGE } from "@/lib/labels";
import { getBrandTwin } from "@/server/brand-twin/brand-twin";
import { getPublishTargets } from "@/server/integrations/meta-connection-status";

import { buildAgencyCapabilities } from "./deliverables";

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
export async function buildContext(projectId: string, ideaId?: string) {
  const [project, brandTwin, dailyStat, pendingApprovals, recent, setupState] =
    await Promise.all([
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
      getBrandTwin(projectId),
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
        },
      }),
      // Drives the NOT_STARTED/IN_PROGRESS/ACTIVE gate (see chat-turn.ts and
      // command-service.ts) — null means setup was never started at all.
      prisma.projectSetupState.findUnique({
        where: { projectId },
        select: {
          activatedAt: true,
          stageRecords: {
            where: { status: "WAITING_CLIENT" },
            select: { stage: true },
            take: 1,
          },
        },
      }),
    ]);

  if (!brandTwin) {
    throw new Error(`Project ${projectId} has no default brand`);
  }
  const brandId = brandTwin.brandId;

  const setupPhase = !setupState
    ? ("NOT_STARTED" as const)
    : setupState.activatedAt
      ? ("ACTIVE" as const)
      : ("IN_PROGRESS" as const);
  const setupWaiting = setupState?.stageRecords[0]
    ? `waiting on your decision for ${SETUP_STAGE[setupState.stageRecords[0].stage].label}`
    : setupPhase === "IN_PROGRESS"
      ? "running"
      : undefined;

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
    state: dailyStat,
    pending: pendingApprovals.map((approval) => ({
      type: approval.type,
      entityType: approval.entityType,
      waitingSince: approval.createdAt.toISOString(),
    })),
    history,
    recent: chronological,
    setupPhase,
    setupWaiting,
  };
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
