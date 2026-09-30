import { notFound, redirect } from "next/navigation";
import type { DepartmentKey } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getEnv } from "@/lib/env";
import { DEPARTMENT_KEY } from "@/lib/labels";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { AppShell } from "@/components/layout/app-shell";
import {
  entityHref,
  parseHubParams,
} from "@/components/hub-core/hub-core-params";
import { PanelShell } from "@/components/hub-core/panel-shell";
import { ProjectFlowView } from "@/components/hub-core/project-flow-view";
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
import { getPendingDecisions } from "@/server/agency/pending-decisions";
import { computeNextSteps } from "@/server/agency/journey/next-steps";
import { withPlanSlots } from "@/server/agency/journey/plan-slots";
import { loadJourneySnapshot } from "@/server/agency/journey/snapshot";
import { GUIDE_PARAM, GUIDE_VALUE } from "@/lib/guided-setup/contract";
import { isGuidedSetupEnabled } from "@/server/guided-setup/flag";
import { loadGuidedHost } from "@/server/guided-setup/service";

// Card kinds a content-package task leaves in the chat over its life: the
// in-progress card, then its result or failure. creative-ready is also in the
// general creatives query (which only keeps the newest 40) — listing it here
// keeps a package's image from dropping out of the chat when older ones pile
// up, or when its row flips from loading to ready between the two queries.
// Rows matched by both queries are merged by id.
const PACKAGE_ROW_KINDS = [
  "creative-loading",
  "creative-ready",
  "creative-failed",
  "task-running",
  "task-result",
] as const;

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

// Root of the in-project experience — now the project chat itself (like
// ChatGPT's main screen: the left sidebar lists projects/chats, clicking a
// project opens its chat). Modules like Departments/Work/Signals are reached
// from the header's Advanced menu and the sidebar; when a panel is selected
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
  // Right panel's inline Calendar tab (see calendar-panel.tsx) — its own
  // month-paging/item-selection params, independent of panel/sub/entity.
  const calMonthRaw = Array.isArray(sp.calMonth) ? sp.calMonth[0] : sp.calMonth;
  const calMonth =
    calMonthRaw && /^\d{4}-\d{2}$/.test(calMonthRaw) ? calMonthRaw : undefined;
  const calItemRaw = Array.isArray(sp.calItem) ? sp.calItem[0] : sp.calItem;
  const calItem = typeof calItemRaw === "string" ? calItemRaw : undefined;

  // Opt-in escape hatch to the old, isolated per-idea thread view
  // (ProjectFlowView/IdeaFlow) — only used when something explicitly links
  // to it with &thread=1 (see the `entity` branch below).
  const wantsThreadView =
    (Array.isArray(sp.thread) ? sp.thread[0] : sp.thread) === "1";

  // ?guide=setup opens the setup sheet on landing. It is read only for the
  // chat below: the panel and entity branches return earlier and ignore it.
  const guideRaw = Array.isArray(sp[GUIDE_PARAM])
    ? sp[GUIDE_PARAM][0]
    : sp[GUIDE_PARAM];
  const guideRequested = guideRaw === GUIDE_VALUE;

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

  // A bare `?entity=kind:id` link (no `panel`) — an old bookmark or a
  // cross-link. Idea/work pipeline events no longer live in the general
  // chat (it only shows the user's own requests), so this forwards to the
  // panel that owns the record instead. &thread=1 is the opt-in exception:
  // it falls through to the isolated, read-only ProjectFlowView below.
  if (entity) {
    if (!wantsThreadView) redirect(entityHref(projectId, entity));
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
    decisions,
    guidedSetup,
    journey,
  ] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true },
    }),
    prisma.command.findMany({
      // The Agency Desk only shows the user's own planning/requests and the
      // assistant's replies to them — SYSTEM pipeline events (ideas,
      // council, work plans, task/creative results, reports) live in the
      // Ideas/Work panels, not here. ideaId: null drops messages typed
      // inside an idea's isolated thread; topic: null drops legacy scoped
      // threads (e.g. "BRAND_BRAIN" from the removed Brand Brain chat).
      where: {
        projectId,
        topic: null,
        ideaId: null,
        source: "WEB",
      },
      orderBy: { createdAt: "desc" },
      take: 72,
      select: {
        id: true,
        source: true,
        rawText: true,
        replyText: true,
        replyStatus: true,
        attachments: true,
        parsedIntent: true,
        createdAt: true,
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
    getPendingDecisions(projectId),
    // Never throws (undefined on any failure: the chat renders without the
    // feature). Flag off: nothing is read.
    isGuidedSetupEnabled()
      ? loadGuidedHost(projectId, guideRequested)
      : Promise.resolve(undefined),
    // Where every piece of the saved content plans stands, and what to do
    // next. Never throws (null on any failure: the chat shows its default
    // shortcuts and plain plan cards).
    loadJourneySnapshot(projectId),
  ]);

  if (!project) notFound();

  const firstName = (currentUser?.name ?? currentUser?.email ?? "").split(
    /[\s@]/,
  )[0];

  // Every creative the pipeline ever produced stays in the conversation as
  // the same creative-ready card (SYSTEM rows, whichever idea they belong
  // to — the rest of the pipeline noise stays out of this chat). The
  // stored card is kept current by IdeaChatRepository (status, publish
  // state), so history and new creatives look and behave identically.
  const creativeCommands = await prisma.command.findMany({
    where: {
      projectId,
      topic: null,
      source: "SYSTEM",
      parsedIntent: { path: ["card", "kind"], equals: "creative-ready" },
    },
    orderBy: { createdAt: "desc" },
    take: 40,
    select: {
      id: true,
      source: true,
      rawText: true,
      replyText: true,
      replyStatus: true,
      attachments: true,
      parsedIntent: true,
      createdAt: true,
    },
  });

  // creativeId → open approval, to (re)attach Approve/Reject to the newest
  // card of a creative that is still awaiting a decision.
  const pendingApprovalByCreativeId = new Map(
    decisions.flatMap((d) =>
      d.card.kind === "creative-ready"
        ? [[d.card.creativeId, d.approvalId] as const]
        : [],
    ),
  );
  // A revision posts a NEW card and leaves the earlier version's card
  // untouched — only the newest card per creative may keep a live decision.
  const newestCardByCreativeId = new Map<string, string>();
  for (const command of creativeCommands) {
    const card = cardFromParsedIntent(command.parsedIntent);
    if (card?.kind === "creative-ready" && !newestCardByCreativeId.has(card.creativeId)) {
      newestCardByCreativeId.set(card.creativeId, command.id);
    }
  }

  // Everything a content package's tasks post to the chat — the running /
  // loading card while a piece is being made, then its result (SEO article,
  // Reel script...) or failure — is pulled into the conversation, so a piece
  // is visible from the moment it starts, also after a reload.
  // (A saved content plan's production runs its tasks under the plan's own
  // Command, exactly like a package does.)
  const packageCommandIds = chatCommands
    .filter((command) => {
      const kind = cardFromParsedIntent(command.parsedIntent)?.kind;
      return kind === "content-package" || kind === "content-plan-draft";
    })
    .map((command) => command.id);
  const packageTaskIds = packageCommandIds.length
    ? (
        await prisma.task.findMany({
          where: { projectId, commandId: { in: packageCommandIds } },
          select: { id: true },
        })
      ).map((task) => task.id)
    : [];
  const packageRowCommands = packageTaskIds.length
    ? await prisma.command.findMany({
        where: {
          projectId,
          topic: null,
          source: "SYSTEM",
          AND: [
            {
              OR: PACKAGE_ROW_KINDS.map((kind) => ({
                parsedIntent: { path: ["card", "kind"], equals: kind },
              })),
            },
            {
              OR: packageTaskIds.map((taskId) => ({
                parsedIntent: { path: ["card", "taskId"], equals: taskId },
              })),
            },
          ],
        },
        select: {
          id: true,
          source: true,
          rawText: true,
          replyText: true,
          replyStatus: true,
          attachments: true,
          parsedIntent: true,
          createdAt: true,
        },
      })
    : [];

  // A creative's card can match both queries — one row, one message.
  const rowsById = new Map(
    [...chatCommands, ...creativeCommands, ...packageRowCommands].map(
      (command) => [command.id, command] as const,
    ),
  );
  const stageByCreativeId = new Map(
    (journey?.items ?? []).map((item) => [item.id, item] as const),
  );
  const nextSteps = journey ? computeNextSteps(journey) : [];
  const chatTurns = [...rowsById.values()]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((command): ChatTurn => {
      let card = withPlanSlots(
        cardFromParsedIntent(command.parsedIntent, pendingApprovalByCreativeId),
        stageByCreativeId,
      );
      if (
        card?.kind === "creative-ready" &&
        card.status === "IN_REVIEW" &&
        newestCardByCreativeId.get(card.creativeId) !== command.id
      ) {
        card = { ...card, status: "ARCHIVED", approvalId: undefined };
      }
      return {
        commandId: command.id,
        source: command.source as "WEB" | "SYSTEM",
        text: command.rawText,
        reply: command.replyText,
        replyStatus: command.replyStatus,
        departmentKey: departmentKeyFromParsedIntent(command.parsedIntent),
        // Limit-notice cards are also written to WEB-sourced rows (see
        // chat-service.ts) — without this, the card would only show
        // until the next refresh, then fall back to plain text.
        card,
        attachments: Array.isArray(command.attachments)
          ? (command.attachments as ChatAttachment[])
          : [],
        createdAt: command.createdAt.toISOString(),
      };
    });

  // Pending approvals are decided inside the conversation. A creative that
  // already has its card above is decided there; anything else (task
  // approvals, creatives with no chat card) is appended at the bottom as
  // the same card, rebuilt from the records. Oldest first; a decided one
  // drops out on router.refresh().
  const shownApprovalIds = new Set(
    chatTurns.flatMap((t) =>
      t.card && "approvalId" in t.card && t.card.approvalId
        ? [t.card.approvalId]
        : [],
    ),
  );
  const decisionTurns = decisions
    .filter((d) => !shownApprovalIds.has(d.approvalId))
    .map(
      (d): ChatTurn => ({
        commandId: `decision-${d.approvalId}`,
        source: "SYSTEM",
        text: "",
        reply: "Waiting for your decision",
        replyStatus: null,
        card: d.card,
        attachments: [],
        createdAt: d.createdAt,
      }),
    );
  const turns = [...chatTurns, ...decisionTurns];

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
              kit={rightPanelData.brandKit}
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
          chatEngine={getEnv().CHAT_ENGINE}
          projectName={project.name}
          userFirstName={firstName || null}
          publishTargets={publishTargets}
          turns={turns}
          guidedSetup={guidedSetup}
          nextSteps={nextSteps}
          autoNext={typeof sp.next === "string" ? sp.next : undefined}
        />
      </div>
    </AppShell>
  );
}
