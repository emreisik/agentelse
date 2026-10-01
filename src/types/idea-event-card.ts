import { type CreativeCardData, isCreativeCardData } from "./creative-card";
import type { ChatQuestion } from "@/server/chat/constants";
import type { ChannelConnections, ChannelKey } from "@/lib/content-channels";
import type { ChannelOption } from "@/lib/works/work";
import type { GuidedSetupCardData } from "@/lib/guided-setup/contract";
import type { PlanItemStage } from "@/lib/journey";
import type { BrandCheckState, BrandFlag } from "@/lib/works/brand-rules";
import type { PlanOptionsCardData } from "@/lib/works/plan-options";
import type { IdeaOptionsCardData } from "@/lib/works/idea-options";
import type { MasterContentCardData } from "@/lib/works/master-content";
import type { DailyBrief } from "@/lib/works/daily-brief";
import type { AdsInsightCardData } from "@/lib/works/ads-insight";

// Representation of EVERY pipeline event in an idea's chat (origin
// signal/finding, insight/opportunity, idea birth, council decision, work
// plan, task result, creative generation) — the "golden rule": all of them
// use the same card format, written into Command.parsedIntent as
// `{ card: IdeaEventCardData }` (see IdeaChatRepository) and rendered in the
// chat screen (project-chat.tsx + thread.tsx) via the IdeaEventCard
// component instead of plain text. Long bodies (council rationale, task
// result text, finding/insight description) are shown collapsed by default,
// in an area that expands on click.
export type ApprovalCategory = "spend" | "publish" | "action";

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
      // The result IS the deliverable the client asked for (an article, a
      // Reel script, ad copy...) — shown open instead of behind a toggle.
      expanded?: boolean;
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
      // What kind of decision this is, so the card can say it plainly —
      // "spend" (campaign/ad set/budget writes: real money), "publish"
      // (goes live on a social account), "action" (anything else). Absent
      // on cards written before this field existed → rendered as "action".
      category?: ApprovalCategory;
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
  // A human-intervention request (HumanInterventionRepository.create,
  // fired from execution-service.ts whenever a provider reports
  // WAITING_HUMAN — OTP/MFA/login/captcha/confirmation/manual-browser/
  // account-selection/file/information/decision) — previously invisible
  // outside the Human Action Center panel despite being architecturally
  // central (drives task/job status, the "Needs you" dashboard badge).
  // Mirrors human-action-panel.tsx's own simplification exactly: every
  // inputType except MANUAL_BROWSER gets a plain text input + Send
  // (CHOICE/FILE have no structured options/upload UI anywhere in this
  // codebase today, chat included); MANUAL_BROWSER gets a disabled "Open
  // Browser" placeholder + Cancel, same as the panel.
  | {
      kind: "human-action-required";
      requestId: string;
      title: string;
      message?: string;
      interventionType: string;
      inputType:
        "TEXT" | "OTP" | "CONFIRM" | "CHOICE" | "MANUAL_BROWSER" | "FILE";
      // Resolved/cancelled in place (same row) by
      // HumanInterventionRepository.resolve/transition — so a page
      // refresh reflects the real outcome instead of reverting to
      // "pending" (this card's own optimistic client state is only a
      // preview while that server write is in flight).
      status: "PENDING" | "RESOLVED" | "CANCELLED" | "EXPIRED";
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
  // A content plan the chat agent drafted in conversation (propose_content_
  // plan, src/server/chat/tools.ts) — day-by-day slots, NOT yet stored on the
  // calendar. "Save plan" (saveContentPlanAction) turns the slots into dated
  // DRAFT creatives (no image yet) and flips `state` to "saved"; a newer
  // proposal in the same project flips older open drafts to "superseded".
  // `date`/`time` are wall-clock in `timezone`, exactly as the calendar
  // reads them.
  | {
      kind: "content-plan-draft";
      title: string;
      timezone: string;
      state: "draft" | "saved" | "superseded";
      // What the plan is for (a PLAN_GOALS value) and, per channel, whether
      // it can publish right now — a snapshot taken when the plan was drawn.
      // Absent on plans drafted before channels existed.
      goal?: string;
      connections?: ChannelConnections;
      items: {
        date: string;
        time: string;
        // Absent for channels that are not a social platform (Blog/SEO, Ads).
        platform?: string;
        // Free text on plans drafted before channels existed.
        format?: string;
        // Catalog keys (src/lib/content-channels.ts).
        channel?: string;
        formatKey?: string;
        topic: string;
        captionIdea: string;
        // Works-only, all optional so stored rows stay valid.
        // Other takes on the same slot (other directions, "More ideas").
        alternatives?: { topic: string; captionIdea: string; from?: string }[];
        // Source label of the idea when it came from a direction.
        from?: string;
        origin?: { kind: "idea" | "master" | "brief" | "creative"; ref: string };
        ideaId?: string;
        brandFlags?: BrandFlag[];
        // Set by removeSlotAction.
        removed?: boolean;
      }[];
      // Claim + run cap of "More ideas" (Works only).
      alternativesMeta?: { runs: number; runningSince?: string };
      fromOption?: { id: string; label: string };
      // The master content this plan was adapted from (Works only).
      master?: { title: string; message: string; ideaId?: string };
      brandCheck?: BrandCheckState;
      via?: "idea" | "master" | "suggestion" | "brief" | "generate" | "options";
      savedCreativeIds?: string[];
      // Production of the saved slots (plan-run.ts): set when a run is claimed
      // so a double click or a second tab cannot start the same pieces twice.
      // A "running" claim older than the run time limit counts as abandoned.
      production?: {
        state: "running" | "done";
        // The slots (Creative ids) the current/last run took.
        creativeIds: string[];
        startedAt: string;
        finishedAt?: string;
      };
      // Where each saved slot stands right now, aligned with `items` (same
      // index). Filled in from the records when the page renders (journey/
      // plan-progress.ts), never stored: a saved card is a plan, its progress
      // is whatever the calendar says today.
      // null = a slot whose piece is gone (archived or deleted).
      slots?: ({ id: string; stage: PlanItemStage; assetId?: string } | null)[];
    }
  // The plan wizard (start_plan_brief): a step-by-step card that collects
  // goal, channels, formats and rhythm, then sends them back as ONE chat
  // message (plan-brief.ts) so the agent drafts exactly what was picked.
  // `connections` is the live publish status the channel step shows.
  | {
      kind: "plan-brief";
      projectId: string;
      ideaId?: string;
      // The project's "today" (YYYY-MM-DD, its scheduling timezone): the
      // start-date choices are computed from it.
      today: string;
      connections: ChannelConnections;
      // The channels of the Work this plan is for (docs/works.md). Present: the
      // wizard offers only these, all ticked. Absent: every channel, as before.
      workChannels?: ChannelKey[];
      // Prefilled from the brand's current focus; the client can edit it.
      theme?: string;
      // What the next plan inherits from the last one (journey/continuation.ts):
      // the goal, the channels with their formats, and a start date right after
      // the last planned piece. Absent on the first plan.
      continuation?: {
        goal?: string;
        formats?: Partial<Record<string, string[]>>;
        continueFrom?: string;
      };
    }
  // The agency's answer to a topic-only request: a package of deliverables
  // from the active departments, each with a topic-specific angle. The client
  // ticks what they want and starts production with ONE click (see
  // startContentPackageAction) — `state` flips to "started" so it can't run
  // twice; a newer proposal flips older open ones to "superseded".
  | {
      kind: "content-package";
      topic: string;
      state: "draft" | "started" | "superseded";
      items: {
        id: string;
        // A DELIVERABLE_KEYS value (src/server/chat/deliverables.ts).
        deliverable: string;
        title: string;
        angle: string;
        // Only for Instagram post items — a CreativeContentFormat value.
        contentFormat?: string;
      }[];
      startedCount?: number;
      // Which items the client ticked when they started it (the rest were
      // skipped) — set together with `state: "started"`.
      startedItemIds?: string[];
      // When it was started (ISO) — lets the chat tell a package that is
      // still spinning up from a long-finished one.
      startedAt?: string;
    }
  // Setup's own "here's what we're finding" preview — a horizontally
  // scrolling row of quick, no-image-generation mockup posts, one per
  // setup stage that produced something concrete (signals, brand
  // constitution, goals, opportunities, ideas, work plan — see
  // demo-post-generator.ts's DEMO_POST_STAGES). ONE evolving card per
  // project (same pattern as markCreativePublishState's creative-ready
  // card): each newly completed stage appends an item in place rather than
  // posting a new message, so the client always finds a single up-to-date
  // carousel instead of a growing pile of near-duplicate messages. Posted
  // project-wide (ideaId: null) — setup isn't scoped to any one idea.
  // The channel gate of a Work (docs/works.md): which channel(s) the Work is
  // for, with each channel's live connection state. Picking saves them on the
  // Work; an unconnected one may be picked ("I'll connect later").
  | {
      kind: "channel-select";
      projectId: string;
      workId: string;
      options: ChannelOption[];
      selected: ChannelKey[];
    }
  | {
      kind: "setup-demo-carousel";
      items: {
        id: string;
        stage: string;
        headline: string;
        caption: string;
        platform: "INSTAGRAM" | "TIKTOK" | "LINKEDIN";
        accentIndex: number;
        createdAt: string;
      }[];
    }
  | PlanOptionsCardData
  | IdeaOptionsCardData
  | MasterContentCardData
  // daily-brief and ads-insight are LIVE cards: built on every render, never
  // persisted. They are registered only so the client accepts them.
  | DailyBrief
  | AdsInsightCardData
  | GuidedSetupCardData
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
  "human-action-required",
  "handoff-proposed",
  "limit-notice",
  "ads-form-prompt",
  "question",
  "content-plan-summary",
  "content-plan-draft",
  "plan-brief",
  "content-package",
  "setup-demo-carousel",
  "guided-setup",
  "channel-select",
  "content-plan-options",
  "idea-options",
  "master-content",
  "daily-brief",
  "ads-insight",
]);

const CREATIVE_KINDS = [
  "creative-loading",
  "creative-ready",
  "creative-failed",
  "publish-prompt",
];

// Every kind a stored card may have (render-every-kind guard).
export function cardKinds(): string[] {
  return [...EVENT_KINDS, ...CREATIVE_KINDS].sort();
}

// Cards whose message keeps the model's lead-in sentence above them (the chat
// hides the text of every other card kind).
export const CARDS_THAT_KEEP_TEXT: ReadonlySet<string> = new Set([
  "content-plan-draft",
  "plan-brief",
  "content-package",
  "guided-setup",
]);

export function isIdeaEventCardData(
  value: unknown,
): value is IdeaEventCardData {
  if (isCreativeCardData(value)) return true;
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" && EVENT_KINDS.has(kind);
}
