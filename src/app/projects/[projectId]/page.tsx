import { notFound, redirect } from "next/navigation";
import type { DepartmentKey } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { DEPARTMENT_KEY } from "@/lib/labels";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { AppShell } from "@/components/layout/app-shell";
import {
  parseHubParams,
  type EntityRef,
} from "@/components/hub-core/hub-core-params";
import { PanelShell } from "@/components/hub-core/panel-shell";
import { ProjectFlowView } from "@/components/hub-core/project-flow-view";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import {
  ProjectChat,
  type ChatAttachment,
  type ChatTurn,
} from "@/components/commands/project-chat";
import { getPublishTargets } from "@/server/integrations/meta-connection-status";
import { ownerOfCapability } from "@/server/agency/departments/department-registry";
import { isIdeaEventCardData } from "@/types/idea-event-card";
import { getWorkspaceRightPanelData } from "@/components/workspace/workspace-right-panel-data";
import { WorkspaceRightPanel } from "@/components/workspace/workspace-right-panel";
import { BrandSummaryPanel } from "@/components/workspace/brand-summary-panel";
import { OutputsPanel } from "@/components/workspace/outputs-panel";
import { CalendarPanel } from "@/components/workspace/calendar-panel";
import { FilesPanel } from "@/components/workspace/files-panel";

// Command.parsedIntent is written as { card: IdeaEventCardData } on rows
// sourced from SYSTEM (see IdeaChatRepository) — on WEB rows it carries the
// command parser's output instead, so its shape can't be used without validation.
// pendingApprovalByCreativeId: if a "creative-ready" card is IN_REVIEW but
// doesn't carry an approvalId (legacy records generated BEFORE approvalId was
// added to execution-service.ts), it's backfilled here retroactively — so
// approvals already pending also show Approve/Reject in the chat, without
// needing a separate backfill script.
function cardFromParsedIntent(
  parsedIntent: unknown,
  pendingApprovalByCreativeId?: Map<string, string>,
) {
  if (!parsedIntent || typeof parsedIntent !== "object") return undefined;
  const card = (parsedIntent as { card?: unknown }).card;
  if (!isIdeaEventCardData(card)) return undefined;
  if (
    pendingApprovalByCreativeId &&
    card.kind === "creative-ready" &&
    card.status === "IN_REVIEW" &&
    !card.approvalId
  ) {
    const approvalId = pendingApprovalByCreativeId.get(card.creativeId);
    if (approvalId) return { ...card, approvalId };
  }
  return card;
}

// For event messages tied to a SINGLE department (task/creative completion —
// see IdeaChatRepository.postSystemMessage), if parsedIntent.departmentKey is
// set it's shown in chat as a color strip (see project-chat.tsx,
// assistant-ui/thread.tsx). WEB-sourced rows never have departmentKey written
// (parsedIntent has the shape of ParsedIntent there — see
// command-service.ts attachParsedIntent) — in that case the department is
// derived from the task's capability (the fixed ownership map in
// department-registry.ts), so the "Task created" note can also show which
// department it went to.
function departmentKeyFromParsedIntent(
  parsedIntent: unknown,
): DepartmentKey | undefined {
  if (!parsedIntent || typeof parsedIntent !== "object") return undefined;
  const key = (parsedIntent as { departmentKey?: unknown }).departmentKey;
  if (typeof key === "string" && key in DEPARTMENT_KEY) {
    return key as DepartmentKey;
  }
  const intent = parsedIntent as { kind?: unknown; capability?: unknown };
  if (intent.kind === "CAPABILITY" && typeof intent.capability === "string") {
    return ownerOfCapability(intent.capability as never);
  }
  return undefined;
}

// Resolves which idea's chat thread an entity link (the "Chats" list in the
// sidebar, or cross-links in the panels) belongs to.
// idea → itself; workPlan/task → the idea at their root (a plain-field
// relation, see WorkPlan.ideaId / Task.workPlanId). Returns null if not
// found: this falls back to the read-only ProjectFlowView for idea-less
// records left over from before the "everything in one chat" architecture.
async function resolveIdeaId(entity: EntityRef): Promise<string | null> {
  if (entity.kind === "idea") return entity.id;
  if (entity.kind === "workPlan") {
    return IdeaChatRepository.resolveIdeaIdForWorkPlan(entity.id);
  }
  if (entity.kind === "task") {
    return IdeaChatRepository.resolveIdeaIdForTask(entity.id);
  }
  return null;
}

// Root of the in-project experience — now the project chat itself (like
// ChatGPT's main screen: the left sidebar lists projects/chats, clicking a
// project opens its chat). Modules like Departments/Work/Signals are reached
// from the Tools menu in the TopBar; when a panel is selected
// (`?panel=&sub=&entity=`, see hub-core-params.ts) that panel is rendered as
// full-page content IN PLACE OF the chat — not a modal.
export default async function ProjectChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;
  const { userId } = await requireUser();

  try {
    await requireProjectAccess(userId, projectId);
  } catch {
    notFound();
  }

  const { panel, sub, entity } = parseHubParams(sp);
  // Widens the general-chat query's date floor instead of the default
  // recent-window cap — set by the "Initiatives" sidebar list (see
  // sidebar-nav.tsx) and the legacy ?entity= redirect above, so the
  // #idea-<id> anchor they link to is guaranteed to be in the fetched
  // range even if it's older than the default window.
  const sinceRaw = Array.isArray(sp.since) ? sp.since[0] : sp.since;
  const sinceDate = sinceRaw ? new Date(sinceRaw) : null;
  const since =
    sinceDate && !Number.isNaN(sinceDate.getTime()) ? sinceDate : null;

  // Right panel's inline Calendar tab (see calendar-panel.tsx) — its own
  // month-paging/item-selection params, independent of panel/sub/entity.
  const calMonthRaw = Array.isArray(sp.calMonth) ? sp.calMonth[0] : sp.calMonth;
  const calMonth =
    calMonthRaw && /^\d{4}-\d{2}$/.test(calMonthRaw) ? calMonthRaw : undefined;
  const calItemRaw = Array.isArray(sp.calItem) ? sp.calItem[0] : sp.calItem;
  const calItem = typeof calItemRaw === "string" ? calItemRaw : undefined;

  if (panel) {
    return (
      <AppShell projectId={projectId}>
        <PanelShell
          projectId={projectId}
          panel={panel}
          sub={sub}
          entity={entity}
        />
      </AppShell>
    );
  }

  // When there's no `panel` but an `entity` is selected — a legacy bare
  // `?entity=idea:id` link (old bookmark, browser history; the sidebar's
  // "Initiatives" list now links straight to the anchor below and no
  // longer produces this URL, see sidebar-nav.tsx). There is no separate
  // idea thread anymore (see docs/brand-workspace-migration.md single-chat
  // consolidation) — every idea's events live in the one general chat
  // below, so this just forwards into it, anchored to where that idea's
  // conversation starts. `since` guarantees the anchor target is inside
  // the fetched window even if normal activity since then has pushed it
  // past the default `take` cap.
  if (entity) {
    const ideaId = await resolveIdeaId(entity);
    if (ideaId) {
      const earliestCommand = await prisma.command.findFirst({
        where: { ideaId, topic: null, source: { in: ["WEB", "SYSTEM"] } },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      });
      const since = earliestCommand
        ? `?since=${encodeURIComponent(earliestCommand.createdAt.toISOString())}`
        : "";
      redirect(`/projects/${projectId}${since}#idea-${ideaId}`);
    }

    // A task with no idea lineage (e.g. PerformanceOptimizer's rule-based
    // proposals — see idea-chat.repository.ts) has nowhere else to show its
    // approval card: ProjectFlowView's TaskFlow is read-only (no Approve/
    // Reject buttons), and the card itself only ever posts to the general
    // chat (see chat-service.ts / the general-chat query above). Sending
    // the user there directly avoids the dead end a sidebar click on an
    // orphan task's "needs approval" entry would otherwise land on.
    if (entity.kind === "task") {
      redirect(`/projects/${projectId}`);
    }
    // Any other entity kind that can't be rooted to an idea (workPlan-only
    // orphan records left over from before the single-chat architecture) —
    // read-only fallback, kept rather than deleted.
    return (
      <AppShell projectId={projectId}>
        <ProjectFlowView projectId={projectId} entity={entity} />
      </AppShell>
    );
  }

  const [
    project,
    chatCommands,
    publishTargets,
    rightPanelData,
    currentUser,
    selectedCalendarItem,
  ] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true },
    }),
    prisma.command.findMany({
      // The ONE single chat (see docs/brand-workspace-migration.md,
      // single-chat consolidation): every WEB message and every SYSTEM
      // pipeline event project-wide, regardless of which idea (if any)
      // it belongs to — council decisions, work plans, task/creative
      // results all land here now, not just idea-less events. topic:
      // null excludes scoped threads that aren't this general feed —
      // e.g. legacy Command rows with topic "BRAND_BRAIN" from the
      // now-removed Brand Brain chat feature.
      where: {
        projectId,
        topic: null,
        source: { in: ["WEB", "SYSTEM"] },
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      orderBy: { createdAt: "desc" },
      // `since` present: an anchor jump needs every message from that
      // date forward, not just the most recent 72 — 500 is a sane
      // ceiling, not a real limit (the Command_projectId_createdAt_idx
      // index keeps this cheap either way).
      take: since ? 500 : 72,
      select: {
        id: true,
        source: true,
        rawText: true,
        replyText: true,
        replyStatus: true,
        attachments: true,
        parsedIntent: true,
        createdAt: true,
        ideaId: true,
      },
    }),
    getPublishTargets(projectId),
    getWorkspaceRightPanelData(projectId, { month: calMonth }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    }),
    // Tenant-scoped: findFirst with projectId, not findUnique(id) alone —
    // calItem is a plain user-suppliable query param.
    calItem
      ? prisma.creative.findFirst({
          where: { id: calItem, projectId },
          select: {
            id: true,
            title: true,
            platform: true,
            status: true,
            scheduledFor: true,
            versions: {
              orderBy: { version: "desc" },
              take: 1,
              select: { assetId: true },
            },
          },
        })
      : Promise.resolve(null),
  ]);

  if (!project) notFound();

  // Read-time idea label (see docs/brand-workspace-migration.md single-chat
  // consolidation) — resolved here instead of at every one of the 10+
  // postSystemMessage call sites, so the pill just needs the ids the query
  // already selected above.
  const ideaIds = Array.from(
    new Set(
      chatCommands
        .map((command) => command.ideaId)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const ideaTitleById = ideaIds.length
    ? new Map(
        (
          await prisma.idea.findMany({
            where: { id: { in: ideaIds } },
            select: { id: true, title: true },
          })
        ).map((idea) => [idea.id, idea.title]),
      )
    : new Map<string, string>();

  const firstName = (currentUser?.name ?? currentUser?.email ?? "").split(
    /[\s@]/,
  )[0];

  return (
    <AppShell
      projectId={projectId}
      rightPanel={
        <WorkspaceRightPanel
          projectId={projectId}
          autopilotMode={rightPanelData.autopilotMode}
          brand={
            <BrandSummaryPanel
              projectId={projectId}
              brand={rightPanelData.brand}
              website={rightPanelData.website}
            />
          }
          files={
            <FilesPanel projectId={projectId} assets={rightPanelData.files} />
          }
          outputs={<OutputsPanel outputs={rightPanelData.outputs} />}
          calendar={
            <CalendarPanel
              projectId={projectId}
              calendar={rightPanelData.calendar}
              selectedItem={
                selectedCalendarItem
                  ? {
                      id: selectedCalendarItem.id,
                      title: selectedCalendarItem.title,
                      platform: selectedCalendarItem.platform,
                      status: selectedCalendarItem.status,
                      assetId:
                        selectedCalendarItem.versions[0]?.assetId ?? null,
                      scheduledFor:
                        selectedCalendarItem.scheduledFor?.toISOString() ??
                        null,
                    }
                  : undefined
              }
            />
          }
        />
      }
    >
      <div key="project-general" className="relative h-full">
        <ProjectChat
          projectId={projectId}
          projectName={project.name}
          userFirstName={firstName || null}
          resumeStats={rightPanelData.resumeStats}
          publishTargets={publishTargets}
          turns={chatCommands.reverse().map((command): ChatTurn => ({
            commandId: command.id,
            source: command.source as "WEB" | "SYSTEM",
            text: command.rawText,
            reply: command.replyText,
            replyStatus: command.replyStatus,
            departmentKey: departmentKeyFromParsedIntent(command.parsedIntent),
            // Limit-notice cards are also written to WEB-sourced rows (see
            // chat-service.ts) — without this, the card would only show
            // until the next refresh, then fall back to plain text.
            card: cardFromParsedIntent(command.parsedIntent),
            attachments: Array.isArray(command.attachments)
              ? (command.attachments as ChatAttachment[])
              : [],
            ideaTitle: command.ideaId
              ? ideaTitleById.get(command.ideaId)
              : undefined,
            // Used only to place the #idea-<id> anchor the "Initiatives"
            // sidebar list and the legacy ?entity= redirect jump to (see
            // project-chat.tsx) — distinct from ideaTitle above so the
            // anchor still lands correctly even if the title lookup ever
            // misses.
            ideaId: command.ideaId ?? undefined,
            createdAt: command.createdAt.toISOString(),
          }))}
        />
      </div>
    </AppShell>
  );
}
