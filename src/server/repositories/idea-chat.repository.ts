import "server-only";

import type { DepartmentKey, RiskLevel } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { isWorksEnabled } from "@/server/works/flag";
import type { CommandAttachment } from "./command.repository";
import type { CreativeCardData } from "@/types/creative-card";
import type {
  ApprovalCategory,
  IdeaEventCardData,
} from "@/types/idea-event-card";

// System messages the agency pipeline (council evaluation, conversion to a
// work plan, task/creative completion) writes to an idea's chat thread —
// these accumulate under the SAME ideaId as the user's actual messages
// about that idea (source: WEB), forming a single chat stream (see
// Command.ideaId). Callers must wrap this write in try/catch: failure to
// write a chat message must NEVER stop the underlying business logic
// (idea/council/work plan/task).
export const IdeaChatRepository = {
  // ideaId is nullable: system events for a Task with no idea lineage (e.g.
  // PerformanceOptimizer's rule-based proposals, which bypass Idea/Council
  // entirely — see performance-optimizer.ts) still need to reach the user.
  // Command.ideaId is nullable in the schema; a null here lands the row in
  // the project's general chat stream instead of a specific idea thread
  // (see the general-chat query in page.tsx / chat-service.ts buildContext).
  async postSystemMessage(input: {
    workspaceId: string;
    projectId: string;
    ideaId: string | null;
    // The Work (conversation) the event belongs to. Given a taskId instead, it
    // is the Work of the Command that started the task, so a result lands in
    // the conversation that asked for it. Neither (background pipeline
    // events): no Work, it lives in the panels only (docs/works.md).
    workId?: string | null;
    taskId?: string;
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
    const workId =
      input.workId !== undefined
        ? input.workId
        : input.taskId
          ? await IdeaChatRepository.resolveWorkIdForTask(input.taskId)
          : null;
    return prisma.command.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ideaId: input.ideaId,
        ...(workId ? { workId } : {}),
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
  // (like the waiting state ChatGPT shows while generating an image). Tasks
  // that can't be linked to an idea (ideaId can't be resolved) still post —
  // with ideaId: null, landing in the single project-wide chat — same
  // null-safe pattern as postTaskRunningCard/resolveTaskResultCard below.
  // Used to silently drop the message entirely when unresolvable, which is
  // exactly the kind of "invisible content" the single-chat consolidation
  // exists to fix.
  async postCreativeLoadingCard(input: {
    workspaceId: string;
    projectId: string;
    taskId: string;
    title: string;
    departmentKey?: DepartmentKey;
  }): Promise<void> {
    const ideaId = await IdeaChatRepository.resolveIdeaIdForTask(input.taskId);
    await IdeaChatRepository.postSystemMessage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      taskId: input.taskId,
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
  // time), posts a new row instead — best-effort. ideaId may be null (task
  // has no idea lineage) — the lookup/post below are both null-safe, same
  // reasoning as postCreativeLoadingCard above.
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
      taskId: input.taskId,
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
    await IdeaChatRepository.postSystemMessage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      taskId: input.taskId,
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
      taskId: input.taskId,
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
      taskId: input.taskId,
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
    // Concrete before/after numbers for a system-generated proposal (e.g.
    // a performance-driven budget cut) — see approval-details.ts. Absent
    // for ordinary approvals, which render exactly as before.
    details?: { label: string; value: string }[];
    category?: ApprovalCategory;
  }): Promise<void> {
    const ideaId = await IdeaChatRepository.resolveIdeaIdForTask(input.taskId);
    await IdeaChatRepository.postSystemMessage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      taskId: input.taskId,
      ideaId,
      text: `⏸️ Awaiting approval: ${input.title}`,
      card: {
        kind: "approval-request",
        approvalId: input.approvalId,
        taskId: input.taskId,
        title: input.title,
        riskLevel: input.riskLevel,
        department: input.departmentKey ?? undefined,
        details: input.details,
        category: input.category,
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
    ideaId: string | null;
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
    // Nullable: an orphan creative (no idea lineage) still gets its
    // approve/reject decision reflected in the single project-wide chat.
    ideaId: string | null;
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

  // Mirrors a publish-pipeline transition (queued -> publishing ->
  // published/failed) onto the SAME creative-ready card the Post/Story
  // buttons live on, instead of the publish quick-action/task-running/
  // publish-result/auto-publish-confirmation flow spawning its own
  // separate rows — the whole point being "one evolving card, not five
  // chat bubbles for one publish". Same findFirst-by-creativeId pattern as
  // resolveCreativeApprovalDecision above. Returns false (no-op) when no
  // matching creative-ready row exists — e.g. a taskless/batch-planned
  // creative with no card to attach to, or a scheduled/cron publish with
  // no interactive card currently in the chat window — so every caller can
  // fall back to its own pre-existing chat message in that case.
  async markCreativePublishState(input: {
    taskId: string;
    creativeId: string;
    publishState: "queued" | "publishing" | "published" | "failed";
    publishError?: string;
    publishedAt?: Date;
  }): Promise<boolean> {
    const ideaId = await IdeaChatRepository.resolveIdeaIdForTask(input.taskId);
    const existing = await prisma.command.findFirst({
      where: {
        ideaId,
        source: "SYSTEM",
        parsedIntent: {
          path: ["card", "creativeId"],
          equals: input.creativeId,
        },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, parsedIntent: true },
    });
    if (!existing) return false;

    const parsed = existing.parsedIntent as {
      card?: { kind?: string; [key: string]: unknown };
      departmentKey?: DepartmentKey;
    } | null;
    if (!parsed?.card || parsed.card.kind !== "creative-ready") return false;

    await prisma.command.update({
      where: { id: existing.id },
      data: {
        parsedIntent: {
          card: {
            ...parsed.card,
            publishState: input.publishState,
            publishError: input.publishError,
            publishedAt: input.publishedAt?.toISOString(),
            ...(input.publishState === "published"
              ? { status: "PUBLISHED" }
              : null),
          },
          departmentKey: parsed.departmentKey,
        } as never,
      },
    });
    return true;
  },

  // Appends one demo-post item to the project's single setup carousel card
  // (see demo-post-generator.ts) — same "one evolving card" shape as
  // markCreativePublishState above, keyed by card kind instead of a
  // creativeId since there's exactly one carousel per project, not one per
  // entity. Called from project-setup-orchestrator.ts's completeStage as
  // each stage finishes; deduped by stage so a retried/re-run stage never
  // adds a second tile for the same stage.
  async appendSetupDemoPost(input: {
    workspaceId: string;
    projectId: string;
    item: Extract<
      IdeaEventCardData,
      { kind: "setup-demo-carousel" }
    >["items"][number];
  }): Promise<void> {
    const existing = await prisma.command.findFirst({
      where: {
        projectId: input.projectId,
        ideaId: null,
        source: "SYSTEM",
        parsedIntent: { path: ["card", "kind"], equals: "setup-demo-carousel" },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, parsedIntent: true },
    });

    if (!existing) {
      await IdeaChatRepository.postSystemMessage({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ideaId: null,
        text: "",
        card: { kind: "setup-demo-carousel", items: [input.item] },
      });
      return;
    }

    const parsed = existing.parsedIntent as {
      card?: { kind?: string; items?: { stage?: string }[] };
    } | null;
    const items = parsed?.card?.items ?? [];
    if (items.some((existingItem) => existingItem.stage === input.item.stage)) {
      return;
    }

    await prisma.command.update({
      where: { id: existing.id },
      data: {
        parsedIntent: {
          card: { kind: "setup-demo-carousel", items: [...items, input.item] },
        } as never,
      },
    });
  },

  // Updates a "human-action-required" card's status in place (same row) —
  // called from HumanInterventionRepository.resolve/transition so a page
  // refresh reflects the real outcome instead of reverting to "pending"
  // (see idea-event-card.ts's comment on this card kind). ideaId is
  // nullable the same way resolveCreativeApprovalDecision's is: a
  // WAITING_HUMAN request with no task lineage still posted into the
  // project's general chat stream, and still needs to resolve there.
  async resolveHumanActionCard(input: {
    ideaId: string | null;
    requestId: string;
    status: "RESOLVED" | "CANCELLED" | "EXPIRED";
  }): Promise<void> {
    const existing = await prisma.command.findFirst({
      where: {
        ideaId: input.ideaId,
        source: "SYSTEM",
        parsedIntent: {
          path: ["card", "requestId"],
          equals: input.requestId,
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
    if (!parsed?.card || parsed.card.kind !== "human-action-required") return;

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

  // The Work of the Command that started a task (null: none, or a legacy row).
  // Works only: flag off there is no Work, so no extra reads (the post is one
  // insert, as before). Fail-open: a failed lookup lands the row outside any
  // Work instead of failing the post.
  async resolveWorkIdForTask(taskId: string): Promise<string | null> {
    try {
      if (!isWorksEnabled()) return null;
      const task = await prisma.task.findUnique({
        where: { id: taskId },
        select: { commandId: true },
      });
      if (!task?.commandId) return null;
      const command = await prisma.command.findUnique({
        where: { id: task.commandId },
        select: { workId: true },
      });
      return command?.workId ?? null;
    } catch {
      return null;
    }
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
