import type { CreativeContentFormat, SocialPlatform } from "@prisma/client";

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
      // Optional: absent for creatives produced by a taskless batch run
      // (see instagram-week-planner.ts) — there's no loading card to
      // resolve back to, so those post straight to "ready" via
      // IdeaChatRepository.postSystemMessage instead of resolveCreativeCard.
      taskId?: string;
      title: string;
      creativeId: string;
      assetId?: string;
      mimeType?: string;
      caption?: string;
      copy?: string;
      status: string;
      // Real measured pixel size of the generated image (see
      // creative-image.ts normalizeToTarget) — together with
      // platform/contentFormat, powers the "1080 x 1920 px · TikTok ·
      // Video" note shown under the image in CreativeCard.
      assetWidth?: number;
      assetHeight?: number;
      platform?: SocialPlatform | null;
      contentFormat?: CreativeContentFormat | null;
      // For showing Approve/Reject buttons directly in the chat while status
      // is "IN_REVIEW" — see CreativeCard, and the Approval.id returned by
      // ApprovalRepository.create (execution-service.ts
      // materializeCreativeFromResult).
      approvalId?: string;
      // The CreativeVersion.version this card reflects (see
      // CreativeRepository.addVersion) — shown as a "vN" badge. Optional:
      // older persisted cards (written before this field existed) simply
      // don't show a badge, rather than guessing.
      versionNumber?: number;
      // Brand.name, looked up once at card-construction time (Creative has
      // no brand relation, just a brandId column) — shown as the small
      // wordmark on the image. Optional for the same reason as above.
      brandName?: string;
      // Mirrors the publish pipeline's progress directly onto this SAME
      // card (see IdeaChatRepository.markCreativePublishState) instead of
      // that pipeline spawning its own separate chat rows. Absent on older
      // cards and on any publish not triggered through this card — renders
      // as no status line, not an error.
      publishState?: "idle" | "queued" | "publishing" | "published" | "failed";
      publishError?: string;
      publishedAt?: string; // ISO
      // What approving does for THIS project right now — "calendar": a
      // Publishing schedule is active, so it takes the next calendar slot;
      // "publish": no schedule, so it goes out immediately (see
      // approval-decisions.ts autoPublishCreative). Only set by the Agency
      // Desk's decisions tray (pending-decisions.ts); absent → plain "Approve".
      approveIntent?: "calendar" | "publish";
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
