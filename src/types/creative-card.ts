// Representation of a creative/image generation event in an idea's chat.
// Written into Command.parsedIntent as `{ card: CreativeCardData }` (see
// IdeaChatRepository) and rendered in the chat screen (project-chat.tsx +
// thread.tsx) via a dedicated card component instead of plain text. For the
// same taskId, "creative-loading" is written first, and once the job
// finishes the SAME row is updated to "creative-ready" or "creative-failed"
// (the same logic as the loading → result transition shown during
// generation in ChatGPT).
export type CreativeCardData =
  | {
      kind: "creative-loading";
      taskId: string;
      title: string;
    }
  | {
      kind: "creative-ready";
      taskId: string;
      title: string;
      creativeId: string;
      assetId?: string;
      mimeType?: string;
      caption?: string;
      copy?: string;
      status: string;
      // For showing Approve/Reject buttons directly in the chat while status
      // is "IN_REVIEW" — see CreativeCard, and the Approval.id returned by
      // ApprovalRepository.create (execution-service.ts
      // materializeCreativeFromResult).
      approvalId?: string;
    }
  | {
      kind: "creative-failed";
      taskId: string;
      title: string;
      message?: string;
    }
  | {
      // A separate prompt turn that lands in the chat after a creative is
      // approved — contains the same "Share on Social Accounts" section as
      // the one on the creative-ready card, but on its own row so it doesn't
      // get missed (see approval-decisions.ts).
      kind: "publish-prompt";
      creativeId: string;
      title: string;
    };

export function isCreativeCardData(value: unknown): value is CreativeCardData {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "creative-loading" ||
    kind === "creative-ready" ||
    kind === "creative-failed" ||
    kind === "publish-prompt"
  );
}
