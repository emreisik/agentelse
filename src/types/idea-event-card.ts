import { type CreativeCardData, isCreativeCardData } from "./creative-card";
import type { ChatQuestion } from "@/server/reasoning/prompts/chat-turn";

// Representation of EVERY pipeline event in an idea's chat (origin
// signal/finding, insight/opportunity, idea birth, council decision, work
// plan, task result, creative generation) — the "golden rule": all of them
// use the same card format, written into Command.parsedIntent as
// `{ card: IdeaEventCardData }` (see IdeaChatRepository) and rendered in the
// chat screen (project-chat.tsx + thread.tsx) via the IdeaEventCard
// component instead of plain text. Long bodies (council rationale, task
// result text, finding/insight description) are shown collapsed by default,
// in an area that expands on click.
export type IdeaEventCardData =
  | { kind: "signal"; title: string; summary?: string }
  | { kind: "finding"; title: string; statement: string }
  | {
      kind: "insight-opportunity";
      title: string;
      summary?: string;
      description?: string;
    }
  | { kind: "idea"; title: string; description: string }
  | {
      kind: "council";
      verdict: string;
      notes: { council: string; verdict: string; rationale?: string }[];
    }
  | {
      kind: "work-plan";
      title: string;
      nodes: { department: string; request: string }[];
    }
  | {
      kind: "task-running";
      taskId: string;
      title: string;
      department?: string;
    }
  | {
      kind: "task-result";
      taskId: string;
      title: string;
      department?: string;
      status: "COMPLETED" | "FAILED" | "CANCELLED";
      resultText?: string;
    }
  | {
      kind: "approval-request";
      approvalId: string;
      taskId: string;
      title: string;
      department?: string;
      riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
      // Concrete before/after numbers for a system-generated proposal (e.g.
      // a performance-driven budget cut) — see approval-details.ts. Absent
      // for ordinary human-requested/creative approvals, which have
      // nothing structured to show beyond the title.
      details?: { label: string; value: string }[];
    }
  | {
      kind: "approval-decision";
      title: string;
      entityType: "Task" | "Creative";
      decision: "APPROVED" | "REJECTED";
      note?: string;
    }
  | {
      kind: "publish-result";
      taskId: string;
      platform: string;
      title: string;
      status: "COMPLETED" | "FAILED";
      postId?: string;
      permalink?: string;
      errorMessage?: string;
    }
  // A cross-department handoff proposal (WorkHandoffEngine.propose) —
  // previously invisible outside the Work panel's Handoffs tab (a silent
  // gap: the receiving department's own agent has to actually accept it
  // before work continues, and nothing surfaced that in chat). Accept
  // routes through WorkHandoffEngine.accept (department-mode gate,
  // decision record, task creation) exactly as the Work panel does; Reject
  // just transitions the handoff to REJECTED — see
  // agency-work-actions.ts's acceptHandoffAction/rejectHandoffAction.
  | {
      kind: "handoff-proposed";
      handoffId: string;
      fromDepartment: string;
      toDepartment: string;
      reason: string;
    }
  // A CTA card shown when the chat recognizes a Meta ads request but the
  // parameters (budget, targeting, creative) need to come from a structured
  // form instead of free text — see FORM_REQUIRED_CAPABILITIES in
  // command-service.ts. Clicking through opens the Ads Manager's create
  // dialog (see /projects/[projectId]/ads/page.tsx), pre-filled with
  // whatever the LLM's taskBrief captured.
  | {
      kind: "ads-form-prompt";
      title: string;
      formHref: string;
    }
  // Why the assistant couldn't reply: a daily cap/budget was hit or the AI
  // provider is unavailable. Rendered with an explanation + (for caps) a
  // CTA into the autonomy settings panel (see limit-notice.ts for the
  // error -> reason mapping).
  | {
      kind: "limit-notice";
      reason:
        | "daily-budget"
        | "daily-reasoning"
        | "daily-tasks"
        | "open-opportunities"
        | "active-ideas"
        | "provider-unconfigured"
        | "provider-rate-limited"
        | "provider-timeout";
      cap?: number;
      used?: number;
    }
  // The chat surface's structured "AskUserQuestion"-style fork (see
  // chat-turn.ts's `questions` field) — clickable options instead of a
  // vague open-ended reply. `ideaId` is baked in at write time (chat-
  // service.ts) so the answer round-trips into whichever thread (general
  // or idea-scoped) the question was asked in.
  | {
      kind: "question";
      questions: ChatQuestion[];
      projectId: string;
      ideaId?: string;
    }
  // The weekly batch planner's result (planWeeklyInstagramContent) — a
  // visual mini-grid of what it scheduled, replacing what used to be a
  // plain-text-only summary (see instagram-week-planner.ts). Posted
  // project-wide (ideaId: null), not per-idea — the individual
  // creative-ready cards already cover per-idea detail; this is the
  // "what did the batch as a whole do" view "tüm planlar listelensin"
  // asked for.
  | {
      kind: "content-plan-summary";
      ideasConsidered: number;
      imagesGenerated: number;
      imagesFailed: number;
      scheduled: number;
      pendingReview: number;
      cappedForToday: boolean;
      items: {
        creativeId: string;
        assetId?: string;
        title: string;
        scheduledFor?: string;
      }[];
    }
  | CreativeCardData;

const EVENT_KINDS = new Set([
  "signal",
  "finding",
  "insight-opportunity",
  "idea",
  "council",
  "work-plan",
  "task-running",
  "task-result",
  "approval-request",
  "approval-decision",
  "publish-result",
  "handoff-proposed",
  "limit-notice",
  "ads-form-prompt",
  "question",
  "content-plan-summary",
]);

export function isIdeaEventCardData(
  value: unknown,
): value is IdeaEventCardData {
  if (isCreativeCardData(value)) return true;
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" && EVENT_KINDS.has(kind);
}
