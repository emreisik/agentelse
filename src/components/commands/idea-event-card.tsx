"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import type { DepartmentKey } from "@prisma/client";
import {
  CalendarClock,
  CheckCircle2,
  CircleCheck,
  CircleSlash,
  ClipboardList,
  Compass,
  FileSearch,
  Gauge,
  Hourglass,
  ImageIcon,
  KeyRound,
  Lightbulb,
  Loader2,
  Megaphone,
  Radio,
  Send,
  Settings2,
  Share2,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Timer,
  XCircle,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DepartmentBadge } from "@/components/shared/department-badge";
import {
  DEPARTMENT_KEY,
  HUMAN_INTERVENTION_TYPE,
  RISK_LEVEL,
  stripCapabilityPrefix,
} from "@/lib/labels";
import {
  WsDetailToggle,
  WsEventCard,
  WsStatusPill,
  WsTag,
  type WsTone,
} from "@/components/commands/ws-event-card";
import { CreativeCard } from "@/components/commands/creative-card";
import { isCreativeCardData } from "@/types/creative-card";
import type { IdeaEventCardData } from "@/types/idea-event-card";
import {
  approveApprovalAction,
  rejectApprovalAction,
} from "@/server/actions/approval-actions";
import {
  acceptHandoffAction,
  cancelTaskAction,
  rejectHandoffAction,
} from "@/server/actions/agency-work-actions";
import {
  cancelHumanActionAction,
  resolveHumanActionAction,
} from "@/server/actions/human-action-actions";
import { submitChatMessageAction } from "@/server/actions/command-actions";

// Narrows a raw department string (e.g. "BRAND_STRATEGY") to DepartmentKey
// if valid — so that EVERYWHERE a department is mentioned in cards, the
// DepartmentBadge (the SAME icon+color as on the departments page) is
// used, NO plain text/colorless icon.
function asDepartmentKey(department?: string): DepartmentKey | undefined {
  return department && department in DEPARTMENT_KEY
    ? (department as DepartmentKey)
    : undefined;
}

// The common render for EVERY pipeline event in the single project chat —
// the "golden rule": from the originating signal to the creative
// generation, everything uses the same card format (WsEventCard, see
// ws-event-card.tsx — the monochrome --ws-* system CreativeReadyCard
// established, now shared by all 18 card kinds instead of half using a
// separate oklch tone system). The icon + title (+ badge, if any) at the
// top is ALWAYS visible; long bodies (council rationale, task output text,
// finding/insight description) are collapsed by default via
// WsDetailToggle and expand on click.
export function IdeaEventCard({ card }: { card: IdeaEventCardData }) {
  if (isCreativeCardData(card)) return <CreativeCard card={card} />;

  switch (card.kind) {
    case "signal":
      return (
        <WsEventCard icon={Radio} title={card.title} tone="special">
          {card.summary ? (
            <WsDetailToggle label="Signal details">
              {card.summary}
            </WsDetailToggle>
          ) : null}
        </WsEventCard>
      );

    case "finding":
      return (
        <WsEventCard icon={FileSearch} title={card.title} tone="neutral">
          <WsDetailToggle label="Finding details">
            {card.statement}
          </WsDetailToggle>
        </WsEventCard>
      );

    case "insight-opportunity":
      return (
        <WsEventCard icon={Sparkles} title={card.title} tone="special">
          {card.summary ? (
            <p className="text-sm" style={{ color: "var(--ws-text-2)" }}>
              {card.summary}
            </p>
          ) : null}
          {card.description ? (
            <WsDetailToggle label="Opportunity details">
              {card.description}
            </WsDetailToggle>
          ) : null}
        </WsEventCard>
      );

    case "idea":
      return (
        <WsEventCard icon={Lightbulb} title={card.title} tone="special">
          <p className="text-sm" style={{ color: "var(--ws-text-2)" }}>
            {card.description}
          </p>
        </WsEventCard>
      );

    case "council": {
      const tone: WsTone =
        card.verdict === "REJECT"
          ? "danger"
          : card.verdict === "REVISE"
            ? "waiting"
            : "positive";
      return (
        <WsEventCard
          icon={Compass}
          title="Council review"
          tone={tone}
          badgeLabel={VERDICT_LABEL[card.verdict] ?? card.verdict}
        >
          <WsDetailToggle label="See council rationale">
            <div className="space-y-3">
              {card.notes.map((note, index) => (
                <div key={index}>
                  <p
                    className="text-sm font-medium"
                    style={{ color: "var(--ws-text)" }}
                  >
                    {note.council} — {note.verdict}
                  </p>
                  {note.rationale ? (
                    <p
                      className="mt-0.5 text-sm"
                      style={{ color: "var(--ws-text-2)" }}
                    >
                      {note.rationale}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </WsDetailToggle>
        </WsEventCard>
      );
    }

    case "work-plan":
      return (
        <WsEventCard icon={ClipboardList} title={card.title} tone="special">
          <ul className="space-y-1.5">
            {card.nodes.map((node, index) => {
              const departmentKey = asDepartmentKey(node.department);
              return (
                <li key={index} className="flex items-start gap-1.5 text-sm">
                  {departmentKey ? (
                    <DepartmentBadge department={departmentKey} size="xs" />
                  ) : (
                    <span
                      className="font-medium"
                      style={{ color: "var(--ws-text)" }}
                    >
                      {node.department}
                    </span>
                  )}
                  <span style={{ color: "var(--ws-text-2)" }}>
                    : {node.request}
                  </span>
                </li>
              );
            })}
          </ul>
        </WsEventCard>
      );

    case "task-running":
      return <TaskRunningCard card={card} />;

    case "task-result": {
      const tone: WsTone =
        card.status === "COMPLETED"
          ? "positive"
          : card.status === "CANCELLED"
            ? "neutral"
            : "danger";
      const icon =
        card.status === "COMPLETED"
          ? CheckCircle2
          : card.status === "CANCELLED"
            ? CircleSlash
            : XCircle;
      const badgeLabel =
        card.status === "COMPLETED"
          ? "Completed"
          : card.status === "CANCELLED"
            ? "Cancelled"
            : "Failed";
      return (
        <WsEventCard
          icon={icon}
          title={card.title}
          tone={tone}
          badgeLabel={badgeLabel}
          department={asDepartmentKey(card.department)}
        >
          {card.resultText ? (
            <WsDetailToggle label="See generated content">
              {card.resultText}
            </WsDetailToggle>
          ) : null}
        </WsEventCard>
      );
    }

    case "approval-request":
      return <ApprovalRequestCard card={card} />;

    case "handoff-proposed":
      return <HandoffProposedCard card={card} />;

    case "human-action-required":
      return <HumanActionRequiredCard card={card} />;

    case "limit-notice":
      return <LimitNoticeCard card={card} />;

    case "approval-decision": {
      const tone: WsTone = card.decision === "APPROVED" ? "positive" : "danger";
      return (
        <WsEventCard
          icon={card.decision === "APPROVED" ? ShieldCheck : ShieldX}
          title={card.title}
          tone={tone}
          badgeLabel={card.decision === "APPROVED" ? "Approved" : "Rejected"}
        >
          {card.note ? (
            <WsDetailToggle label="Note">{card.note}</WsDetailToggle>
          ) : null}
        </WsEventCard>
      );
    }

    case "publish-result": {
      const tone: WsTone = card.status === "COMPLETED" ? "positive" : "danger";
      // postId is written on every successful publish (see
      // task.repository.ts/execution-service.ts) but nothing populates
      // permalink today — without postId here, a successful publish
      // showed nothing beyond the "Published" badge, no reference to the
      // actual post at all.
      const hasDetails = Boolean(
        card.permalink || card.postId || card.errorMessage,
      );
      return (
        <WsEventCard
          icon={card.status === "COMPLETED" ? Send : XCircle}
          title={card.title}
          tone={tone}
          badgeLabel={
            card.status === "COMPLETED"
              ? `${card.platform} — Published`
              : `${card.platform} — Failed`
          }
        >
          {hasDetails ? (
            <WsDetailToggle label="Publish details">
              {card.permalink ? (
                <a
                  href={card.permalink}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                  style={{ color: "var(--ws-text)" }}
                >
                  {card.permalink}
                </a>
              ) : card.postId ? (
                <p>Post ID: {card.postId}</p>
              ) : null}
              {card.errorMessage ? <p>{card.errorMessage}</p> : null}
            </WsDetailToggle>
          ) : null}
        </WsEventCard>
      );
    }

    case "question":
      return <QuestionCard card={card} />;

    case "content-plan-summary":
      return <ContentPlanSummaryCard card={card} />;

    case "ads-form-prompt":
      return (
        <div
          className="mt-1 w-full max-w-sm space-y-2 rounded-2xl border p-3.5"
          style={{
            borderColor: "var(--ws-border)",
            background: "var(--ws-surface)",
          }}
        >
          <div className="flex items-center gap-2">
            <span
              className="flex size-7 shrink-0 items-center justify-center rounded-lg"
              style={{ background: "var(--ws-hover)" }}
            >
              <Megaphone
                className="size-3.5"
                style={{ color: "var(--ws-text)" }}
              />
            </span>
            <p
              className="text-sm font-medium"
              style={{ color: "var(--ws-text)" }}
            >
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
    tone: WsTone;
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
    <WsEventCard
      icon={copy.icon}
      title={copy.title}
      tone={copy.tone}
      badgeLabel={usage}
    >
      <p className="text-sm" style={{ color: "var(--ws-text-2)" }}>
        {copy.description(card)}
      </p>
      {copy.settingsCta && projectId ? (
        <Link
          href={`/projects/${projectId}?panel=ayarlar&sub=otonomi`}
          className={cn(
            buttonVariants({ size: "sm", variant: "outline" }),
            "mt-2 w-fit",
          )}
        >
          <Settings2 className="size-3.5" />
          Open autonomy settings
        </Link>
      ) : null}
    </WsEventCard>
  );
}

// Shared shell for the two "waiting for a click" cards below (approval
// and handoff) — same ring/background, same header row, same optimistic
// resolved-state swap. Not reused for QuestionCard, whose shape (multiple
// question groups + one shared Continue button) is genuinely different.
function WsDecisionCard({
  icon: Icon,
  eyebrow,
  title,
  department,
  badge,
  children,
  error,
  actions,
}: {
  icon: React.ComponentType<{
    className?: string;
    style?: React.CSSProperties;
  }>;
  eyebrow: string;
  title: string;
  department?: DepartmentKey;
  badge?: React.ReactNode;
  children?: React.ReactNode;
  error?: string;
  actions: React.ReactNode;
}) {
  return (
    <div
      className="mt-1 w-full max-w-md space-y-3 rounded-2xl border p-4"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
      }}
    >
      <div className="flex items-start justify-between gap-2.5">
        <div className="flex items-center gap-2">
          <Icon
            className="size-4 shrink-0"
            style={{ color: "var(--ws-text)" }}
          />
          <p
            className="text-sm font-semibold"
            style={{ color: "var(--ws-text)" }}
          >
            {eyebrow}
          </p>
        </div>
        {badge}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium" style={{ color: "var(--ws-text)" }}>
          {stripCapabilityPrefix(title)}
        </p>
        {department ? (
          <DepartmentBadge department={department} size="xs" />
        ) : null}
      </div>
      {children}
      {error ? (
        <p className="text-xs" style={{ color: "#dc2626" }}>
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">{actions}</div>
    </div>
  );
}

// A running task, with a Cancel button — previously view-only in chat,
// cancellation was only reachable from the Work panel even though the
// underlying action (cancelTaskAction) already resolves the SAME chat row
// to a "task-result"/CANCELLED card on its own (TaskRepository.transition
// calls postTaskChatEvent for every terminal status, cancellation
// included — see task.repository.ts), so this needed no new server code,
// only a button. Optimistic: shows "Cancelling…" immediately, then
// router.refresh() picks up the real resolved card.
function TaskRunningCard({
  card,
}: {
  card: Extract<IdeaEventCardData, { kind: "task-running" }>;
}) {
  const params = useParams<{ projectId?: string }>();
  const projectId =
    typeof params?.projectId === "string" ? params.projectId : undefined;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const cancel = () => {
    if (!projectId) return;
    setError(undefined);
    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.set("projectId", projectId);
        formData.set("taskId", card.taskId);
        const result = await cancelTaskAction(formData);
        if (result.ok) {
          setCancelling(true);
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

  return (
    <WsEventCard
      icon={Loader2}
      iconClassName="animate-spin"
      title={card.title}
      tone="special"
      badgeLabel={cancelling ? "Cancelling…" : "Running"}
      department={asDepartmentKey(card.department)}
    >
      {!cancelling && projectId ? (
        <div className="mt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 rounded-full px-2 text-xs"
            style={{ color: "var(--ws-text-3)" }}
            disabled={isPending}
            onClick={cancel}
          >
            Cancel
          </Button>
          {error ? (
            <p className="mt-1 text-xs" style={{ color: "#dc2626" }}>
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </WsEventCard>
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
      <WsEventCard
        icon={decision === "APPROVED" ? ShieldCheck : ShieldX}
        title={decision === "APPROVED" ? "Approved" : "Rejected"}
        tone={decision === "APPROVED" ? "positive" : "danger"}
        department={departmentKey}
      />
    );
  }

  return (
    <WsDecisionCard
      icon={CircleCheck}
      eyebrow="Awaiting approval"
      title={card.title}
      department={departmentKey}
      badge={
        <WsStatusPill
          label={RISK_LEVEL[card.riskLevel]?.label ?? card.riskLevel}
          tone={riskTone(card.riskLevel)}
        />
      }
      error={error}
      actions={
        <>
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
            className="rounded-full"
            style={{
              background: "var(--ws-accent)",
              color: "var(--ws-on-accent)",
            }}
            onClick={() => decide("APPROVED")}
          >
            Approve
          </Button>
        </>
      }
    >
      {card.details && card.details.length > 0 ? (
        <div
          className="space-y-1 rounded-lg p-2.5"
          style={{ background: "var(--ws-hover)" }}
        >
          {card.details.map((detail) => (
            <div
              key={detail.label}
              className="flex items-start justify-between gap-3 text-xs"
            >
              <span className="shrink-0" style={{ color: "var(--ws-text-3)" }}>
                {detail.label}
              </span>
              <span
                className="text-right font-medium"
                style={{ color: "var(--ws-text)" }}
              >
                {detail.value}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <p className="text-sm" style={{ color: "var(--ws-text-2)" }}>
        Your approval is required before execution. If rejected, the task will
        be cancelled.
      </p>
    </WsDecisionCard>
  );
}

function riskTone(risk: string): WsTone {
  if (risk === "CRITICAL" || risk === "HIGH") return "danger";
  if (risk === "MEDIUM") return "waiting";
  return "neutral";
}

// A human-intervention request (OTP/MFA/login/captcha/confirmation/manual-
// browser/etc — see execution-service.ts's WAITING_HUMAN branch),
// resolvable directly from chat instead of only the Human Action Center
// panel. Mirrors human-action-panel.tsx's own exact simplification: every
// inputType except MANUAL_BROWSER gets a plain text input + Send (this
// codebase has no structured CHOICE-picker or FILE-upload UI anywhere,
// chat included); MANUAL_BROWSER gets a disabled "Open Browser" + Cancel,
// same wording as the panel. Once resolved/cancelled, the row itself is
// updated server-side (HumanInterventionRepository.resolve/transition ->
// resolveHumanActionCard) — this local `resolved` state is only the
// optimistic preview while that write is in flight; a real refresh
// reflects card.status directly.
function HumanActionRequiredCard({
  card,
}: {
  card: Extract<IdeaEventCardData, { kind: "human-action-required" }>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [resolved, setResolved] = useState<"RESOLVED" | "CANCELLED" | null>(
    null,
  );
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  const typeLabel =
    HUMAN_INTERVENTION_TYPE[
      card.interventionType as keyof typeof HUMAN_INTERVENTION_TYPE
    ]?.label ?? card.interventionType;

  const submit = (
    action: typeof resolveHumanActionAction | typeof cancelHumanActionAction,
    outcome: "RESOLVED" | "CANCELLED",
  ) => {
    setError(undefined);
    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.set("requestId", card.requestId);
        if (action === resolveHumanActionAction) formData.set("value", value);
        const result = await action(formData);
        if (result.ok) {
          setResolved(outcome);
          toast.success(outcome === "RESOLVED" ? "Response sent" : "Cancelled");
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

  const finalStatus =
    resolved ?? (card.status !== "PENDING" ? card.status : null);
  if (finalStatus) {
    const label =
      finalStatus === "RESOLVED"
        ? "Resolved"
        : finalStatus === "CANCELLED"
          ? "Cancelled"
          : "Expired";
    return (
      <WsEventCard
        icon={finalStatus === "RESOLVED" ? ShieldCheck : ShieldX}
        title={card.title}
        tone={finalStatus === "RESOLVED" ? "positive" : "neutral"}
        badgeLabel={label}
      />
    );
  }

  return (
    <WsDecisionCard
      icon={CircleCheck}
      eyebrow="Needs your input"
      title={card.title}
      badge={<WsStatusPill label={typeLabel} tone="waiting" />}
      error={error}
      actions={
        card.inputType === "MANUAL_BROWSER" ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-full"
              disabled
              title="Remote browser session connection not yet available"
            >
              Open Browser
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="rounded-full"
              disabled={isPending}
              onClick={() => submit(cancelHumanActionAction, "CANCELLED")}
            >
              Cancel Task
            </Button>
          </>
        ) : (
          <>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={
                card.inputType === "OTP" ? "Enter code" : "Enter value"
              }
              className="h-8 max-w-40 text-xs"
              disabled={isPending}
              onKeyDown={(e) => {
                if (e.key === "Enter" && value.trim()) {
                  e.preventDefault();
                  submit(resolveHumanActionAction, "RESOLVED");
                }
              }}
            />
            <Button
              type="button"
              size="sm"
              className="rounded-full"
              style={{
                background: "var(--ws-accent)",
                color: "var(--ws-on-accent)",
              }}
              disabled={isPending || !value.trim()}
              onClick={() => submit(resolveHumanActionAction, "RESOLVED")}
            >
              Send
            </Button>
          </>
        )
      }
    >
      {card.message ? (
        <p className="text-sm" style={{ color: "var(--ws-text-2)" }}>
          {card.message}
        </p>
      ) : null}
    </WsDecisionCard>
  );
}

// A cross-department handoff proposal, directly actionable from chat —
// previously only visible/actionable in the Work panel's Handoffs tab (see
// idea-event-card.ts's comment on the "handoff-proposed" kind). Mirrors
// ApprovalRequestCard's exact pattern (optimistic resolved state, same
// FormData + useTransition shape) since it's the same "waiting for one
// human click" shape.
function HandoffProposedCard({
  card,
}: {
  card: Extract<IdeaEventCardData, { kind: "handoff-proposed" }>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [decision, setDecision] = useState<"ACCEPTED" | "REJECTED" | null>(
    null,
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const fromDept = asDepartmentKey(card.fromDepartment);
  const toDept = asDepartmentKey(card.toDepartment);

  const decide = (to: "ACCEPTED" | "REJECTED") => {
    setError(undefined);
    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.set("handoffId", card.handoffId);
        const action =
          to === "ACCEPTED" ? acceptHandoffAction : rejectHandoffAction;
        const result = await action(formData);
        if (result.ok) {
          setDecision(to);
          toast.success(
            to === "ACCEPTED" ? "Handoff accepted" : "Handoff rejected",
          );
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
      <WsEventCard
        icon={decision === "ACCEPTED" ? ShieldCheck : ShieldX}
        title={
          decision === "ACCEPTED" ? "Handoff accepted" : "Handoff rejected"
        }
        tone={decision === "ACCEPTED" ? "positive" : "danger"}
        department={toDept}
      />
    );
  }

  return (
    <WsDecisionCard
      icon={Share2}
      eyebrow="Cross-department handoff"
      title={card.reason}
      error={error}
      badge={
        <div className="flex items-center gap-1">
          {fromDept ? (
            <DepartmentBadge department={fromDept} size="xs" />
          ) : null}
          <span style={{ color: "var(--ws-text-3)" }}>→</span>
          {toDept ? <DepartmentBadge department={toDept} size="xs" /> : null}
        </div>
      }
      actions={
        <>
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
            className="rounded-full"
            style={{
              background: "var(--ws-accent)",
              color: "var(--ws-on-accent)",
            }}
            onClick={() => decide("ACCEPTED")}
          >
            Accept
          </Button>
        </>
      }
    >
      <p className="text-sm" style={{ color: "var(--ws-text-2)" }}>
        {card.toDepartment.replaceAll("_", " ")} needs to pick this up before
        work continues.
      </p>
    </WsDecisionCard>
  );
}

// The weekly batch planner's result (planWeeklyInstagramContent, see
// instagram-week-planner.ts) — a visual mini-grid of what got scheduled
// instead of a plain-text-only summary. Each item links straight to its
// creative on the Content Calendar; the numbers row always shows the
// batch's real outcome (created/scheduled/pending/failed), never just the
// happy path.
function ContentPlanSummaryCard({
  card,
}: {
  card: Extract<IdeaEventCardData, { kind: "content-plan-summary" }>;
}) {
  const params = useParams<{ projectId?: string }>();
  const projectId =
    typeof params?.projectId === "string" ? params.projectId : undefined;

  return (
    <div
      className="mt-1 w-full max-w-md space-y-3 rounded-2xl border p-3.5"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
      }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-lg"
          style={{ background: "var(--ws-hover)" }}
        >
          <CalendarClock
            className="size-3.5"
            style={{ color: "var(--ws-text)" }}
          />
        </span>
        <p
          className="text-sm font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          Weekly content plan
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <WsTag>
          {card.imagesGenerated}/{card.ideasConsidered} created
        </WsTag>
        {card.scheduled > 0 ? <WsTag>{card.scheduled} scheduled</WsTag> : null}
        {card.pendingReview > 0 ? (
          <WsStatusPill
            label={`${card.pendingReview} awaiting approval`}
            tone="waiting"
          />
        ) : null}
        {card.imagesFailed > 0 ? (
          <WsStatusPill label={`${card.imagesFailed} failed`} tone="danger" />
        ) : null}
        {card.cappedForToday ? (
          <WsStatusPill label="Stopped early — daily cap" tone="waiting" />
        ) : null}
      </div>

      {card.items.length > 0 ? (
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
          {card.items.map((item) => {
            const thumb = item.assetId ? (
              <img
                src={`/api/assets/${item.assetId}`}
                alt={item.title}
                className="size-full object-cover"
              />
            ) : (
              <ImageIcon
                className="size-4"
                style={{ color: "var(--ws-on-accent)", opacity: 0.6 }}
              />
            );
            const body = (
              <div
                className="flex aspect-square items-center justify-center overflow-hidden rounded-lg"
                style={{ background: "var(--ws-accent)" }}
                title={item.title}
              >
                {thumb}
              </div>
            );
            return projectId ? (
              <Link
                key={item.creativeId}
                href={`/projects/${projectId}/takvim?creative=${item.creativeId}`}
              >
                {body}
              </Link>
            ) : (
              <div key={item.creativeId}>{body}</div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// The chat surface's structured fork (chat-turn.ts's `questions` field,
// spec: "QUESTION CARD") — picking option(s) for every question (single-
// select behaves like radio buttons — one pick replaces the last; multi-
// select toggles) and hitting Continue sends the combined answer as the
// client's next message via the SAME submitChatMessageAction the composer
// uses (no separate answer-handling action needed), so the model sees a
// completely normal follow-up message and replies in-thread. One shared
// Continue button (not one per question) since chat-turn.ts can emit up to
// 2 questions in the same card and the client should answer both before
// sending. Reuses ApprovalRequestCard's exact useTransition + imperative
// FormData pattern above. Simplification (matches brand-brain-assistant.
// tsx's own note): unlike Brand Brain's FAB, this doesn't track "only the
// latest turn is interactive" — an old question card stays clickable,
// which just sends its answer as a new message if used again.
function QuestionCard({
  card,
}: {
  card: Extract<IdeaEventCardData, { kind: "question" }>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [answered, setAnswered] = useState(false);
  // groupKey ("q0", "q1", ...) -> selected option label(s)
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [error, setError] = useState<string | undefined>(undefined);

  const allAnswered = card.questions.every(
    (_, index) => (selected[`q${index}`]?.size ?? 0) > 0,
  );

  const submit = () => {
    setError(undefined);
    startTransition(async () => {
      try {
        const text = card.questions
          .map((q, index) => {
            const labels = Array.from(selected[`q${index}`] ?? []);
            return `${q.question} ${labels.join(", ")}`;
          })
          .join("\n");
        const formData = new FormData();
        formData.set("projectId", card.projectId);
        formData.set("text", text);
        if (card.ideaId) formData.set("ideaId", card.ideaId);
        const result = await submitChatMessageAction(formData);
        if (result.ok) {
          setAnswered(true);
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

  if (answered) {
    return <WsEventCard icon={CheckCircle2} title="Answered" tone="positive" />;
  }

  return (
    <div className="mt-1 flex w-full max-w-md flex-col gap-3">
      {card.questions.map((q, questionIndex) => {
        const groupKey = `q${questionIndex}`;
        const groupSelected = selected[groupKey] ?? new Set<string>();
        return (
          <div
            key={groupKey}
            className="space-y-2.5 rounded-2xl border p-3.5"
            style={{
              borderColor: "var(--ws-border)",
              background: "var(--ws-surface)",
            }}
          >
            <p
              className="text-sm font-medium"
              style={{ color: "var(--ws-text)" }}
            >
              {q.question}
            </p>
            <div className="flex flex-wrap gap-2">
              {q.options.map((option) => {
                const isChecked = groupSelected.has(option.label);
                return (
                  <Button
                    key={option.label}
                    type="button"
                    variant={isChecked ? "default" : "outline"}
                    size="sm"
                    className="rounded-full"
                    disabled={isPending}
                    title={option.description}
                    style={
                      isChecked
                        ? {
                            background: "var(--ws-accent)",
                            color: "var(--ws-on-accent)",
                          }
                        : undefined
                    }
                    onClick={() => {
                      setSelected((prev) => {
                        const next = new Set(prev[groupKey] ?? []);
                        if (q.multiSelect) {
                          if (next.has(option.label)) next.delete(option.label);
                          else next.add(option.label);
                        } else {
                          next.clear();
                          next.add(option.label);
                        }
                        return { ...prev, [groupKey]: next };
                      });
                    }}
                  >
                    {option.label}
                  </Button>
                );
              })}
            </div>
          </div>
        );
      })}
      {error ? (
        <p className="text-xs" style={{ color: "#dc2626" }}>
          {error}
        </p>
      ) : null}
      <Button
        type="button"
        size="sm"
        className="w-fit self-end rounded-full"
        disabled={isPending || !allAnswered}
        style={{ background: "var(--ws-accent)", color: "var(--ws-on-accent)" }}
        onClick={submit}
      >
        Continue
      </Button>
    </div>
  );
}
