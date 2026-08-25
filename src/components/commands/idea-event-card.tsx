"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import type { DepartmentKey } from "@prisma/client";
import {
  CheckCircle2,
  ChevronRight,
  CircleCheck,
  ClipboardList,
  Compass,
  FileSearch,
  Gauge,
  Hourglass,
  KeyRound,
  Lightbulb,
  Loader2,
  Megaphone,
  Radio,
  Send,
  Settings2,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Timer,
  XCircle,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { StatusBadge } from "@/components/shared/status-badge";
import { DepartmentBadge } from "@/components/shared/department-badge";
import {
  TONE_CLASSES,
  DEPARTMENT_KEY,
  RISK_LEVEL,
  stripCapabilityPrefix,
  type StatusTone,
} from "@/lib/labels";
import { CreativeCard } from "@/components/commands/creative-card";
import { isCreativeCardData } from "@/types/creative-card";
import type { IdeaEventCardData } from "@/types/idea-event-card";
import {
  approveApprovalAction,
  rejectApprovalAction,
} from "@/server/actions/approval-actions";

// Soft color of the card frame based on tone — from the same token family
// as TONE_CLASSES (oklch --success/--primary/--warning/--destructive/
// --special), just applied to the card background instead of a badge. NO
// new color, just reusing the existing semantic palette at the card level.
const CARD_TONE_CLASSES: Record<StatusTone, string> = {
  positive: "ring-success/20 bg-success/[0.04]",
  active: "ring-primary/20 bg-primary/[0.04]",
  waiting: "ring-warning/20 bg-warning/[0.04]",
  neutral: "ring-foreground/10 bg-card",
  danger: "ring-destructive/20 bg-destructive/[0.04]",
  special: "ring-special/20 bg-special/[0.04]",
};

// Narrows a raw department string (e.g. "BRAND_STRATEGY") to DepartmentKey
// if valid — so that EVERYWHERE a department is mentioned in cards, the
// DepartmentBadge (the SAME icon+color as on the departments page) is
// used, NO plain text/colorless icon.
function asDepartmentKey(department?: string): DepartmentKey | undefined {
  return department && department in DEPARTMENT_KEY
    ? (department as DepartmentKey)
    : undefined;
}

// The common render for EVERY pipeline event in an idea's chat — the
// "golden rule": from the originating signal to the creative generation,
// everything uses the same card format. The icon + title (+ badge, if any)
// at the top is ALWAYS visible; long bodies (council rationale, task
// output text, finding/insight description) are collapsed by default via
// EventDetailToggle and expand on click.
export function IdeaEventCard({ card }: { card: IdeaEventCardData }) {
  if (isCreativeCardData(card)) return <CreativeCard card={card} />;

  switch (card.kind) {
    case "signal":
      return (
        <EventCard icon={Radio} title={card.title} tone="special">
          {card.summary ? (
            <EventDetailToggle label="Signal details">
              {card.summary}
            </EventDetailToggle>
          ) : null}
        </EventCard>
      );

    case "finding":
      return (
        <EventCard icon={FileSearch} title={card.title} tone="neutral">
          <EventDetailToggle label="Finding details">
            {card.statement}
          </EventDetailToggle>
        </EventCard>
      );

    case "insight-opportunity":
      return (
        <EventCard icon={Sparkles} title={card.title} tone="active">
          {card.summary ? (
            <p className="text-sm text-muted-foreground">{card.summary}</p>
          ) : null}
          {card.description ? (
            <EventDetailToggle label="Opportunity details">
              {card.description}
            </EventDetailToggle>
          ) : null}
        </EventCard>
      );

    case "idea":
      return (
        <EventCard icon={Lightbulb} title={card.title} tone="active">
          <p className="text-sm text-muted-foreground">{card.description}</p>
        </EventCard>
      );

    case "council": {
      const tone: StatusTone =
        card.verdict === "REJECT"
          ? "danger"
          : card.verdict === "REVISE"
            ? "waiting"
            : "positive";
      return (
        <EventCard
          icon={Compass}
          title="Council review"
          tone={tone}
          badge={{ label: VERDICT_LABEL[card.verdict] ?? card.verdict, tone }}
        >
          <EventDetailToggle label="See council rationale">
            <div className="space-y-3">
              {card.notes.map((note, index) => (
                <div key={index}>
                  <p className="text-sm font-medium text-foreground">
                    {note.council} — {note.verdict}
                  </p>
                  {note.rationale ? (
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {note.rationale}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </EventDetailToggle>
        </EventCard>
      );
    }

    case "work-plan":
      return (
        <EventCard icon={ClipboardList} title={card.title} tone="active">
          <ul className="space-y-1.5">
            {card.nodes.map((node, index) => {
              const departmentKey = asDepartmentKey(node.department);
              return (
                <li key={index} className="flex items-start gap-1.5 text-sm">
                  {departmentKey ? (
                    <DepartmentBadge department={departmentKey} size="xs" />
                  ) : (
                    <span className="font-medium text-foreground">
                      {node.department}
                    </span>
                  )}
                  <span className="text-muted-foreground">
                    : {node.request}
                  </span>
                </li>
              );
            })}
          </ul>
        </EventCard>
      );

    case "task-running":
      return (
        <EventCard
          icon={Loader2}
          iconClassName="animate-spin"
          title={card.title}
          tone="active"
          badge={{ label: "Running", tone: "active" }}
          department={asDepartmentKey(card.department)}
        />
      );

    case "task-result": {
      const tone: StatusTone =
        card.status === "COMPLETED"
          ? "positive"
          : card.status === "CANCELLED"
            ? "neutral"
            : "danger";
      const icon =
        card.status === "COMPLETED"
          ? CheckCircle2
          : card.status === "CANCELLED"
            ? XCircle
            : XCircle;
      const badgeLabel =
        card.status === "COMPLETED"
          ? "Completed"
          : card.status === "CANCELLED"
            ? "Cancelled"
            : "Failed";
      return (
        <EventCard
          icon={icon}
          title={card.title}
          tone={tone}
          badge={{ label: badgeLabel, tone }}
          department={asDepartmentKey(card.department)}
        >
          {card.resultText ? (
            <EventDetailToggle label="See generated content">
              {card.resultText}
            </EventDetailToggle>
          ) : null}
        </EventCard>
      );
    }

    case "approval-request":
      return <ApprovalRequestCard card={card} />;

    case "limit-notice":
      return <LimitNoticeCard card={card} />;

    case "approval-decision": {
      const tone: StatusTone =
        card.decision === "APPROVED" ? "positive" : "danger";
      return (
        <EventCard
          icon={card.decision === "APPROVED" ? ShieldCheck : ShieldX}
          title={card.title}
          tone={tone}
          badge={{
            label: card.decision === "APPROVED" ? "Approved" : "Rejected",
            tone,
          }}
        >
          {card.note ? (
            <EventDetailToggle label="Note">{card.note}</EventDetailToggle>
          ) : null}
        </EventCard>
      );
    }

    case "publish-result": {
      const tone: StatusTone =
        card.status === "COMPLETED" ? "positive" : "danger";
      const hasDetails = Boolean(card.permalink || card.errorMessage);
      return (
        <EventCard
          icon={card.status === "COMPLETED" ? Send : XCircle}
          title={card.title}
          tone={tone}
          badge={{
            label:
              card.status === "COMPLETED"
                ? `${card.platform} — Published`
                : `${card.platform} — Failed`,
            tone,
          }}
        >
          {hasDetails ? (
            <EventDetailToggle label="Publish details">
              {card.permalink ? (
                <a
                  href={card.permalink}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline underline-offset-2"
                >
                  {card.permalink}
                </a>
              ) : null}
              {card.errorMessage ? <p>{card.errorMessage}</p> : null}
            </EventDetailToggle>
          ) : null}
        </EventCard>
      );
    }

    case "ads-form-prompt":
      return (
        <div className="mt-1 w-full max-w-sm space-y-2 rounded-2xl border border-border bg-card p-3.5">
          <div className="flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Megaphone className="size-3.5" />
            </span>
            <p className="text-sm font-medium text-foreground">
              {stripCapabilityPrefix(card.title)} — I&apos;ve opened a form for
              the budget and targeting details.
            </p>
          </div>
          <Link
            href={card.formHref}
            className={cn(buttonVariants({ size: "sm" }), "w-full")}
          >
            Open Form
          </Link>
        </div>
      );

    default:
      return null;
  }
}

const VERDICT_LABEL: Record<string, string> = {
  STRONG_APPROVE: "Strong Approve",
  APPROVE: "Approve",
  REVISE: "Revise",
  REJECT: "Reject",
};

type LimitNoticeData = Extract<IdeaEventCardData, { kind: "limit-notice" }>;

// One entry per reply-blocking cause (see limit-notice.ts for the error ->
// reason mapping). settingsCta marks the causes the user can actually fix
// in the autonomy settings panel; provider-level causes get an honest
// explanation instead of a link that wouldn't help.
const LIMIT_NOTICE_COPY: Record<
  LimitNoticeData["reason"],
  {
    icon: typeof Gauge;
    tone: StatusTone;
    title: string;
    description: (card: LimitNoticeData) => string;
    settingsCta: boolean;
  }
> = {
  "daily-reasoning": {
    icon: Gauge,
    tone: "waiting",
    title: "Daily AI call limit reached",
    description: (card) =>
      `This project used all of today's AI calls${
        card.cap != null ? ` (${card.cap})` : ""
      }, so a reply can't be generated right now. The counter resets at midnight (UTC) — or raise the cap in autonomy settings.`,
    settingsCta: true,
  },
  "daily-budget": {
    icon: Gauge,
    tone: "waiting",
    title: "Daily AI budget reached",
    description: (card) =>
      `Today's AI spend reached the project's daily budget${
        card.cap != null ? ` ($${card.cap})` : ""
      }. Replies resume when it resets at midnight (UTC) — or raise the budget in autonomy settings.`,
    settingsCta: true,
  },
  "daily-tasks": {
    icon: Gauge,
    tone: "waiting",
    title: "Daily task limit reached",
    description: (card) =>
      `Today's new-task limit${
        card.cap != null ? ` (${card.cap})` : ""
      } is full, so this request can't be queued right now. It resets at midnight (UTC) — or raise the cap in autonomy settings.`,
    settingsCta: true,
  },
  "open-opportunities": {
    icon: Gauge,
    tone: "waiting",
    title: "Open-opportunities cap is full",
    description: () =>
      "Close or archive some opportunities, or raise the cap in autonomy settings.",
    settingsCta: true,
  },
  "active-ideas": {
    icon: Gauge,
    tone: "waiting",
    title: "Active-ideas cap is full",
    description: () =>
      "Archive some ideas, or raise the cap in autonomy settings.",
    settingsCta: true,
  },
  "provider-unconfigured": {
    icon: KeyRound,
    tone: "danger",
    title: "AI provider isn't configured",
    description: () =>
      "No AI API key is set on the server, so replies can't be generated. This needs a deployment-side fix — it isn't a project setting.",
    settingsCta: false,
  },
  "provider-rate-limited": {
    icon: Hourglass,
    tone: "waiting",
    title: "AI provider is rate-limiting",
    description: () =>
      "Too many requests hit the AI provider at once. This usually clears within a minute — send your message again shortly.",
    settingsCta: false,
  },
  "provider-timeout": {
    icon: Timer,
    tone: "waiting",
    title: "AI provider timed out",
    description: () =>
      "The AI provider took too long to respond. Send your message again.",
    settingsCta: false,
  },
};

// Why the assistant couldn't reply — cause + (when fixable there) a CTA
// into the autonomy settings panel. The usage badge shows where the cap
// stood when it was hit.
function LimitNoticeCard({ card }: { card: LimitNoticeData }) {
  const params = useParams<{ projectId?: string }>();
  const projectId =
    typeof params?.projectId === "string" ? params.projectId : undefined;
  const copy = LIMIT_NOTICE_COPY[card.reason];

  const isBudget = card.reason === "daily-budget";
  const usage =
    card.used != null && card.cap != null
      ? isBudget
        ? `$${card.used.toFixed(2)} / $${card.cap}`
        : `${card.used} / ${card.cap}`
      : undefined;

  return (
    <EventCard
      icon={copy.icon}
      title={copy.title}
      tone={copy.tone}
      badge={usage ? { label: usage, tone: copy.tone } : undefined}
    >
      <p className="text-sm text-muted-foreground">{copy.description(card)}</p>
      {copy.settingsCta && projectId ? (
        <Link
          href={`/projects/${projectId}?panel=ayarlar&sub=otonomi`}
          className={cn(
            buttonVariants({ size: "sm", variant: "outline" }),
            "w-fit",
          )}
        >
          <Settings2 className="size-3.5" />
          Open autonomy settings
        </Link>
      ) : null}
    </EventCard>
  );
}

// A directly clickable Approve/Reject card shown in chat while a task is
// awaiting approval — the decision can be made here without navigating to
// a separate Approvals panel. After the decision, the server (see
// resolveApprovalDecisionCard) updates the SAME row to an
// "approval-decision" card; router.refresh() fetches that updated state.
// In between, an optimistic result state is shown briefly while waiting
// for the server response.
function ApprovalRequestCard({
  card,
}: {
  card: Extract<IdeaEventCardData, { kind: "approval-request" }>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [decision, setDecision] = useState<"APPROVED" | "REJECTED" | null>(
    null,
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const departmentKey = asDepartmentKey(card.department);

  const decide = (to: "APPROVED" | "REJECTED") => {
    setError(undefined);
    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.set("approvalId", card.approvalId);
        const action =
          to === "APPROVED" ? approveApprovalAction : rejectApprovalAction;
        const result = await action(formData);
        if (result.ok) {
          setDecision(to);
          toast.success(to === "APPROVED" ? "Approved" : "Rejected");
          router.refresh();
        } else {
          setError(result.message);
          toast.error(result.message);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Action failed";
        setError(message);
        toast.error(message);
      }
    });
  };

  if (decision) {
    return (
      <EventCard
        icon={decision === "APPROVED" ? ShieldCheck : ShieldX}
        title={decision === "APPROVED" ? "Approved" : "Rejected"}
        tone={decision === "APPROVED" ? "positive" : "danger"}
        department={departmentKey}
      />
    );
  }

  return (
    <div
      className={cn(
        "mt-1 w-full max-w-md space-y-3 rounded-2xl bg-card p-4 ring-1",
        CARD_TONE_CLASSES.waiting,
      )}
    >
      <div className="flex items-start justify-between gap-2.5">
        <div className="flex items-center gap-2">
          <CircleCheck className="size-4 shrink-0 text-foreground" />
          <p className="text-sm font-semibold text-foreground">
            Awaiting approval
          </p>
        </div>
        <StatusBadge meta={RISK_LEVEL[card.riskLevel]} />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          {stripCapabilityPrefix(card.title)}
        </p>
        {departmentKey ? (
          <DepartmentBadge department={departmentKey} size="xs" />
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        Your approval is required before execution. If rejected, the task will
        be cancelled.
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-full"
          disabled={isPending}
          onClick={() => decide("REJECTED")}
        >
          Reject
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={isPending}
          className="rounded-full bg-success text-success-foreground hover:bg-success/90"
          onClick={() => decide("APPROVED")}
        >
          Approve
        </Button>
      </div>
    </div>
  );
}

function EventCard({
  icon: Icon,
  iconClassName,
  title,
  tone = "neutral",
  badge,
  department,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  iconClassName?: string;
  title: string;
  tone?: StatusTone;
  badge?: { label: string; tone: StatusTone };
  department?: DepartmentKey;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "mt-1 w-full max-w-md space-y-2 rounded-2xl bg-card p-3.5 ring-1",
        CARD_TONE_CLASSES[tone],
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-lg",
            TONE_CLASSES[tone],
          )}
        >
          <Icon className={cn("size-3.5", iconClassName)} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">
            {stripCapabilityPrefix(title)}
          </p>
          {department ? (
            <DepartmentBadge
              department={department}
              size="xs"
              className="mt-0.5"
            />
          ) : null}
        </div>
        {badge ? (
          <StatusBadge meta={{ label: badge.label, tone: badge.tone }} />
        ) : null}
      </div>
      {children ? <div className="pl-9.5">{children}</div> : null}
    </div>
  );
}

// For long bodies: collapsed by default, expands on click (modeled after
// reasoning.tsx's ReasoningTrigger/ReasoningContent pattern — the same
// chevron-rotate + collapsible-up/down animation classes).
function EventDetailToggle({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group/detail">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors select-none hover:text-foreground">
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]",
            "group-open/detail:rotate-90",
          )}
        />
        {label}
      </summary>
      <div className="mt-1.5 border-l-2 border-border py-1 pl-3 text-sm whitespace-pre-wrap text-muted-foreground">
        {children}
      </div>
    </details>
  );
}
