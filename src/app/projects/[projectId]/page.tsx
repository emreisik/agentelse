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
import { LiveRefresh } from "@/components/shared/live-refresh";
import { ownerOfCapability } from "@/server/agency/departments/department-registry";
import {
  isIdeaEventCardData,
  type IdeaEventCardData,
} from "@/types/idea-event-card";

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

  // When there's no `panel` but an `entity` is selected (a click coming from
  // the "Chats" list in the sidebar, or from cross-links in the panels) —
  // this is now that idea's REAL, active chat thread: complete with the
  // system messages written by the council/work-plan/task/creative-generation
  // pipeline, and the user can also write new messages from here (see
  // Command.ideaId). Falls back to the read-only ProjectFlowView for legacy
  // records that can't be rooted to an idea.
  if (entity) {
    const ideaId = await resolveIdeaId(entity);
    if (ideaId) {
      const [idea, ideaCommands] = await Promise.all([
        prisma.idea.findFirst({
          where: { id: ideaId, projectId },
          select: { title: true },
        }),
        prisma.command.findMany({
          where: { ideaId, source: { in: ["WEB", "SYSTEM"] } },
          orderBy: { createdAt: "desc" },
          take: 200,
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
      ]);

      if (!idea) notFound();

      // Retroactive backfill: find the pending approval for IN_REVIEW creative
      // cards that don't carry an approvalId (see the cardFromParsedIntent comment).
      const creativeIdsNeedingApproval = Array.from(
        new Set(
          ideaCommands
            .map((command) => cardFromParsedIntent(command.parsedIntent))
            .filter(
              (
                card,
              ): card is Extract<
                IdeaEventCardData,
                { kind: "creative-ready" }
              > => {
                if (!card) return false;
                return (
                  card.kind === "creative-ready" &&
                  card.status === "IN_REVIEW" &&
                  !card.approvalId
                );
              },
            )
            .map((card) => card.creativeId),
        ),
      );
      const pendingApprovalByCreativeId = creativeIdsNeedingApproval.length
        ? new Map(
            (
              await prisma.approval.findMany({
                where: {
                  entityType: "Creative",
                  entityId: { in: creativeIdsNeedingApproval },
                  status: "PENDING",
                },
                select: { id: true, entityId: true },
              })
            ).map((approval) => [approval.entityId, approval.id]),
          )
        : undefined;

      return (
        <AppShell projectId={projectId}>
          {/* key={ideaId}: so assistant-ui's ThreadPrimitive.Viewport gets
              REMOUNTED when switching from one idea to another — this project
              does the chat-to-chat transition via a Next.js route/searchParam
              change (assistant-ui's own "threadListItem.switchedTo" event never
              fires), and without the key, React kept the same Viewport instance
              and left it at its old scroll position. Remounting refreshes the
              library's scrollToBottomOnInitialize behavior (see
              useThreadViewportAutoScroll) every time — the chat always opens at
              the bottom, on the latest message. */}
          <div key={ideaId} className="relative h-[calc(100vh-4rem)]">
            <LiveRefresh
              intervalMs={7000}
              className="absolute top-3 right-4 z-10"
            />
            <ProjectChat
              projectId={projectId}
              projectName={idea.title}
              ideaId={ideaId}
              turns={ideaCommands.reverse().map((command): ChatTurn => ({
                commandId: command.id,
                source: command.source as "WEB" | "SYSTEM",
                text: command.rawText,
                reply: command.replyText,
                replyStatus: command.replyStatus,
                attachments: Array.isArray(command.attachments)
                  ? (command.attachments as ChatAttachment[])
                  : [],
                card: cardFromParsedIntent(
                  command.parsedIntent,
                  pendingApprovalByCreativeId,
                ),
                departmentKey: departmentKeyFromParsedIntent(
                  command.parsedIntent,
                ),
                createdAt: command.createdAt.toISOString(),
              }))}
            />
          </div>
        </AppShell>
      );
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
    return (
      <AppShell projectId={projectId}>
        <ProjectFlowView projectId={projectId} entity={entity} />
      </AppShell>
    );
  }

  const [project, chatCommands] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true },
    }),
    prisma.command.findMany({
      // WEB (the user's own messages) plus idea-less SYSTEM events — a
      // system-generated Task with no idea lineage (e.g.
      // PerformanceOptimizer's rule-based proposals, see
      // idea-chat.repository.ts) posts here instead of a specific idea
      // thread, so its approval/result cards are still visible somewhere.
      where: {
        projectId,
        OR: [{ source: "WEB" }, { source: "SYSTEM", ideaId: null }],
      },
      orderBy: { createdAt: "desc" },
      take: 30,
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
  ]);

  if (!project) notFound();

  return (
    <AppShell projectId={projectId}>
      {/* key: see the same explanation above in the idea-specific chat
          branch — so the Viewport remounts and starts at the bottom when
          switching from an idea chat to the project-wide chat (or vice
          versa) too. */}
      <div key="project-general" className="relative h-[calc(100vh-4rem)]">
        <LiveRefresh
          intervalMs={7000}
          className="absolute top-3 right-4 z-10"
        />
        <ProjectChat
          projectId={projectId}
          projectName={project.name}
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
            createdAt: command.createdAt.toISOString(),
          }))}
        />
      </div>
    </AppShell>
  );
}
