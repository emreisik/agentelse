import "server-only";

import type { DepartmentKey, RiskLevel } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { CommandAttachment } from "./command.repository";
import type { CreativeCardData } from "@/types/creative-card";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// System messages the agency pipeline (council evaluation, conversion to a
// work plan, task/creative completion) writes to an idea's chat thread —
// these accumulate under the SAME ideaId as the user's actual messages
// about that idea (source: WEB), forming a single chat stream (see
// Command.ideaId). Callers must wrap this write in try/catch: failure to
// write a chat message must NEVER stop the underlying business logic
// (idea/council/work plan/task).
export const IdeaChatRepository = {
  postSystemMessage(input: {
    workspaceId: string;
    projectId: string;
    ideaId: string;
    text: string;
    attachments?: CommandAttachment[];
    card?: IdeaEventCardData;
    // Marks events tied to a SINGLE department only (task/creative) — shown
    // in the chat view as a department-colored side stripe (see
    // project-chat.tsx, assistant-ui/thread.tsx). Not provided for
    // multi-department events like council/work-plan.
    departmentKey?: DepartmentKey;
    // For when the provenance chain (Signal/Finding/Insight-Opportunity) is
    // written retroactively, so each step shows with its OWN actual creation
    // moment — if omitted, Command.createdAt's @default(now()) behavior is
    // preserved.
    createdAt?: Date;
  }) {
    const parsedIntent =
      input.card || input.departmentKey
        ? { card: input.card, departmentKey: input.departmentKey }
        : undefined;
    return prisma.command.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ideaId: input.ideaId,
        source: "SYSTEM",
        rawText: "",
        replyText: input.text,
        replyStatus: "ANSWERED",
        attachments: (input.attachments?.length
          ? input.attachments
          : undefined) as never,
        parsedIntent: parsedIntent as never,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      },
    });
  },

  // When a creative generation starts, posts a "loading" card to the chat
  // (like the waiting state ChatGPT shows while generating an image). For
  // tasks that can't be linked to an idea (ideaId can't be resolved), this
  // is silently skipped.
  async postCreativeLoadingCard(input: {
    workspaceId: string;
    projectId: string;
    taskId: string;
    title: string;
    departmentKey?: DepartmentKey;
  }): Promise<void> {
    const ideaId = await IdeaChatRepository.resolveIdeaIdForTask(input.taskId);
    if (!ideaId) return;
    await IdeaChatRepository.postSystemMessage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      ideaId,
      text: `🎨 Generating image: ${input.title}`,
      card: {
        kind: "creative-loading",
        taskId: input.taskId,
        title: input.title,
      },
      departmentKey: input.departmentKey,
    });
  },

  // When a creative generation finishes (success or failure), updates the
  // SAME loading card for that task to the result — so "loading" never
  // stays stuck permanently on page refresh/revisit. If the matching
  // loading card can't be found (e.g. postCreativeLoadingCard failed at the
  // time), posts a new row instead — best-effort.
  async resolveCreativeCard(input: {
    workspaceId: string;
    projectId: string;
    taskId: string;
    text: string;
    card: CreativeCardData;
    attachments?: CommandAttachment[];
    departmentKey?: DepartmentKey;
  }): Promise<void> {
    const ideaId = await IdeaChatRepository.resolveIdeaIdForTask(input.taskId);
    if (!ideaId) return;

    const existing = await prisma.command.findFirst({
      where: {
        ideaId,
        source: "SYSTEM",
        parsedIntent: { path: ["card", "taskId"], equals: input.taskId },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    if (existing) {
      await prisma.command.update({
        where: { id: existing.id },
        data: {
          replyText: input.text,
          parsedIntent: {
            card: input.card,
            departmentKey: input.departmentKey,
          } as never,
          attachments: (input.attachments?.length
            ? input.attachments
            : undefined) as never,
        },
      });
      return;
    }

    await IdeaChatRepository.postSystemMessage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      ideaId,
      text: input.text,
      card: input.card,
      attachments: input.attachments,
      departmentKey: input.departmentKey,
    });
  },

  // When a non-creative task transitions to RUNNING, posts a "running" card
  // to the chat — the same visual language as the creative generation
  // loading card (see postCreativeLoadingCard), but for ALL task types: the
  // "started" moment is now visible everywhere, not just for creatives.
  async postTaskRunningCard(input: {
    workspaceId: string;
    projectId: string;
    taskId: string;
    title: string;
    departmentKey?: DepartmentKey;
  }): Promise<void> {
    const ideaId = await IdeaChatRepository.resolveIdeaIdForTask(input.taskId);
    if (!ideaId) return;
    await IdeaChatRepository.postSystemMessage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      ideaId,
      text: `⏳ Task started: ${input.title}`,
      card: {
        kind: "task-running",
        taskId: input.taskId,
        title: input.title,
        department: input.departmentKey ?? undefined,
      },
      departmentKey: input.departmentKey,
    });
  },

  // When a task completes/fails/is cancelled, updates the OPEN "running"
  // card for that task (postTaskRunningCard) to the result in the SAME
  // row — the task-result counterpart of what resolveCreativeCard does for
  // creatives. If the matching running card can't be found (e.g. a task
  // completed/cancelled without ever going through RUNNING), posts a new
  // row.
  async resolveTaskResultCard(input: {
    workspaceId: string;
    projectId: string;
    taskId: string;
    text: string;
    card: Extract<IdeaEventCardData, { kind: "task-result" }>;
    departmentKey?: DepartmentKey;
  }): Promise<void> {
    const ideaId = await IdeaChatRepository.resolveIdeaIdForTask(input.taskId);
    if (!ideaId) return;

    const existing = await prisma.command.findFirst({
      where: {
        ideaId,
        source: "SYSTEM",
        parsedIntent: { path: ["card", "taskId"], equals: input.taskId },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    if (existing) {
      await prisma.command.update({
        where: { id: existing.id },
        data: {
          replyText: input.text,
          parsedIntent: {
            card: input.card,
            departmentKey: input.departmentKey,
          } as never,
        },
      });
      return;
    }

    await IdeaChatRepository.postSystemMessage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      ideaId,
      text: input.text,
      card: input.card,
      departmentKey: input.departmentKey,
    });
  },

  // The counterpart of resolveTaskResultCard for publish tasks
  // (INSTAGRAM_PUBLISH etc.) — updates the same "running" card to the
  // result (postId/error).
  async resolvePublishResultCard(input: {
    workspaceId: string;
    projectId: string;
    taskId: string;
    text: string;
    card: Extract<IdeaEventCardData, { kind: "publish-result" }>;
    departmentKey?: DepartmentKey;
  }): Promise<void> {
    const ideaId = await IdeaChatRepository.resolveIdeaIdForTask(input.taskId);
    if (!ideaId) return;

    const existing = await prisma.command.findFirst({
      where: {
        ideaId,
        source: "SYSTEM",
        parsedIntent: { path: ["card", "taskId"], equals: input.taskId },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    if (existing) {
      await prisma.command.update({
        where: { id: existing.id },
        data: {
          replyText: input.text,
          parsedIntent: {
            card: input.card,
            departmentKey: input.departmentKey,
          } as never,
        },
      });
      return;
    }

    await IdeaChatRepository.postSystemMessage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      ideaId,
      text: input.text,
      card: input.card,
      departmentKey: input.departmentKey,
    });
  },

  // When a task drops into WAITING_APPROVAL because it requires approval
  // (see TaskPlanner.planForCapability), posts a card with Approve/Reject
  // buttons to the chat — matching the mockup design: "Awaiting approval" +
  // risk badge + description + two buttons (see idea-event-card.tsx
  // ApprovalRequestCard). Once decided, the SAME row is updated to the
  // result by resolveApprovalDecisionCard, and the buttons disappear.
  async postApprovalRequestCard(input: {
    workspaceId: string;
    projectId: string;
    taskId: string;
    approvalId: string;
    title: string;
    riskLevel: RiskLevel;
    departmentKey?: DepartmentKey;
  }): Promise<void> {
    const ideaId = await IdeaChatRepository.resolveIdeaIdForTask(input.taskId);
    if (!ideaId) return;
    await IdeaChatRepository.postSystemMessage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      ideaId,
      text: `⏸️ Awaiting approval: ${input.title}`,
      card: {
        kind: "approval-request",
        approvalId: input.approvalId,
        taskId: input.taskId,
        title: input.title,
        riskLevel: input.riskLevel,
        department: input.departmentKey ?? undefined,
      },
      departmentKey: input.departmentKey,
    });
  },

  // When an approval decision (approve/reject) is made, updates the OPEN
  // "approval-request" card (postApprovalRequestCard) to the result in the
  // SAME row — this prevents the button pair from staying there and
  // looking clickable after the decision. If the matching request card
  // can't be found (e.g. an approval that came from Telegram or outside
  // the chat), posts a new row.
  async resolveApprovalDecisionCard(input: {
    workspaceId: string;
    projectId: string;
    ideaId: string;
    approvalId: string;
    text: string;
    card: Extract<IdeaEventCardData, { kind: "approval-decision" }>;
    departmentKey?: DepartmentKey;
  }): Promise<void> {
    const existing = await prisma.command.findFirst({
      where: {
        ideaId: input.ideaId,
        source: "SYSTEM",
        parsedIntent: {
          path: ["card", "approvalId"],
          equals: input.approvalId,
        },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    if (existing) {
      await prisma.command.update({
        where: { id: existing.id },
        data: {
          replyText: input.text,
          parsedIntent: {
            card: input.card,
            departmentKey: input.departmentKey,
          } as never,
        },
      });
      return;
    }

    await IdeaChatRepository.postSystemMessage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      ideaId: input.ideaId,
      text: input.text,
      card: input.card,
      departmentKey: input.departmentKey,
    });
  },

  // When a creative is approved/rejected — unlike task approvals — we do
  // NOT convert the card into a generic "approval-decision" card, because
  // the creative-ready card already carries the image/title: to avoid
  // losing that, only the `status` field of the SAME card is updated
  // (IN_REVIEW -> APPROVED/REJECTED), and the card's shape (image, caption,
  // copy) stays as-is. If there's no matching creative-ready card in the
  // chat (e.g. a creative created manually outside the chat), this is
  // silently skipped.
  async resolveCreativeApprovalDecision(input: {
    ideaId: string;
    creativeId: string;
    status: "APPROVED" | "REJECTED";
  }): Promise<void> {
    const existing = await prisma.command.findFirst({
      where: {
        ideaId: input.ideaId,
        source: "SYSTEM",
        parsedIntent: {
          path: ["card", "creativeId"],
          equals: input.creativeId,
        },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, parsedIntent: true },
    });
    if (!existing) return;

    const parsed = existing.parsedIntent as {
      card?: { kind?: string; [key: string]: unknown };
      departmentKey?: DepartmentKey;
    } | null;
    if (!parsed?.card || parsed.card.kind !== "creative-ready") return;

    await prisma.command.update({
      where: { id: existing.id },
      data: {
        parsedIntent: {
          card: { ...parsed.card, status: input.status },
          departmentKey: parsed.departmentKey,
        } as never,
      },
    });
  },

  // Posted instead of a Task/Approval when a chat capability is in
  // FORM_REQUIRED_CAPABILITIES (see command-service.ts) — budget/targeting/
  // creative parameters need a structured form, not free text. No taskId
  // exists yet at this point (no Task was created), so unlike the other
  // post*Card methods this isn't resolved into a result card later; it's a
  // standalone CTA into the Ads Manager's create dialog.
  async postAdsFormPromptCard(input: {
    workspaceId: string;
    projectId: string;
    ideaId: string;
    title: string;
    formHref: string;
    departmentKey?: DepartmentKey;
  }): Promise<void> {
    await IdeaChatRepository.postSystemMessage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      ideaId: input.ideaId,
      text: `📣 ${input.title} — opened a form for the details.`,
      card: {
        kind: "ads-form-prompt",
        title: input.title,
        formHref: input.formHref,
      },
      departmentKey: input.departmentKey,
    });
  },

  // A WorkPlan/Task can end up without an ideaId in idea-less flows (manual
  // creation, isMock) — in that case this returns null, and the caller
  // should skip writing a chat message / routing to the idea chat.
  async resolveIdeaIdForWorkPlan(workPlanId: string): Promise<string | null> {
    const workPlan = await prisma.workPlan.findUnique({
      where: { id: workPlanId },
      select: { ideaId: true },
    });
    return workPlan?.ideaId ?? null;
  },

  // A task can be linked to an idea through two paths: (1) if it's part of
  // a work plan, workPlanId -> WorkPlan.ideaId; (2) if it was requested
  // directly via a command from an idea's chat (no workPlanId),
  // commandId -> Command.ideaId. commandId is tried first — if the user
  // wrote from that idea's thread, that's the task's "real" context; we
  // only fall back to the work-plan chain if that path isn't available.
  async resolveIdeaIdForTask(taskId: string): Promise<string | null> {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { workPlanId: true, commandId: true },
    });
    if (!task) return null;

    if (task.commandId) {
      const command = await prisma.command.findUnique({
        where: { id: task.commandId },
        select: { ideaId: true },
      });
      if (command?.ideaId) return command.ideaId;
    }

    if (!task.workPlanId) return null;
    return IdeaChatRepository.resolveIdeaIdForWorkPlan(task.workPlanId);
  },
};
