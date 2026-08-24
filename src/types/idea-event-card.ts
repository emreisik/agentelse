import { type CreativeCardData, isCreativeCardData } from "./creative-card";

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
  "limit-notice",
]);

export function isIdeaEventCardData(
  value: unknown,
): value is IdeaEventCardData {
  if (isCreativeCardData(value)) return true;
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" && EVENT_KINDS.has(kind);
}
