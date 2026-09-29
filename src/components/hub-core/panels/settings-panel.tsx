import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  CalendarClock,
  Gavel,
  Infinity as InfinityIcon,
  Lightbulb,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { shortDate, timeAgo } from "@/lib/dates";
import {
  AGENCY_DECISION_SUBJECT,
  AGENCY_DECISION_TYPE,
  AGENCY_TRIGGER_STATUS,
  AGENCY_TRIGGER_TYPE,
  APPROVAL_LEVEL,
  councilDimensionLabel,
} from "@/lib/labels";
import { updateAutonomyPolicyAction } from "@/server/actions/agency-config-actions";
import {
  updateAutoContentPlanScheduleAction,
  updateIdeaGenerationScheduleAction,
  updateInstagramPublishScheduleAction,
} from "@/server/actions/publish-schedule-actions";
import { ProjectDeletionService } from "@/server/projects/project-deletion.service";
import { ActionForm } from "@/components/shared/action-form";
import { DeleteProjectCard } from "@/components/projects/delete-project-card";
import { EmptyState } from "@/components/shared/empty-state";
import { LiveRefresh } from "@/components/shared/live-refresh";
import { ScoreBar } from "@/components/shared/score-bar";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  SETTINGS_SUB_KEYS,
  buildHubHref,
  type SettingsSubKey,
} from "../hub-core-params";
import { CrossLinkChip } from "../primitives/cross-link-chip";
import { FieldGrid, type FieldSpec } from "../primitives/field-grid";
import { DEFAULT_LENS_MIX } from "@/server/agency/ideas/creative-lenses";
import type { PanelProps } from "./panel-props";

const SUB_LABEL: Record<SettingsSubKey, string> = {
  autonomy: "Autonomy",
  publishing: "Publishing",
  decisions: "Decisions",
  activity: "Activity",
  risk: "Danger Zone",
};

const WEIGHT_LABELS: Record<string, string> = {
  impact: "Impact",
  goalAlignment: "Goal Alignment",
  urgency: "Urgency",
  evidence: "Evidence",
  confidence: "Confidence",
  timing: "Timing",
  originality: "Originality",
  costPenalty: "Cost Penalty",
  effortPenalty: "Effort Penalty",
  riskPenalty: "Risk Penalty",
};

export async function SettingsPanel({ projectId, sub, entity }: PanelProps) {
  const activeSub: SettingsSubKey =
    sub && (SETTINGS_SUB_KEYS as readonly string[]).includes(sub)
      ? (sub as SettingsSubKey)
      : "autonomy";

  const [decisionCount, triggerCount] = await Promise.all([
    prisma.agencyDecision.count({ where: { projectId } }),
    prisma.agencyTrigger.count({ where: { projectId } }),
  ]);

  return (
    <div className="space-y-6 py-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1 border-b border-foreground/10">
          {SETTINGS_SUB_KEYS.map((key) => {
            const isActive = key === activeSub;
            const count =
              key === "decisions"
                ? decisionCount
                : key === "activity"
                  ? triggerCount
                  : undefined;
            return (
              <Link
                key={key}
                href={buildHubHref(projectId, {
                  panel: "settings",
                  sub: key,
                  entity: null,
                })}
                scroll={false}
                className={cn(
                  "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {SUB_LABEL[key]}
                {count !== undefined ? (
                  <span
                    className={cn(
                      "flex h-4 min-w-4 items-center justify-center rounded-4xl px-1 text-[10px] font-medium tabular-nums",
                      isActive
                        ? "bg-primary/15 text-primary"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {count}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
        {activeSub !== "autonomy" && activeSub !== "publishing" ? (
          <LiveRefresh />
        ) : null}
      </div>

      {activeSub === "publishing" ? (
        <PublishingTab projectId={projectId} />
      ) : activeSub === "decisions" ? (
        <DecisionsTab projectId={projectId} entity={entity} />
      ) : activeSub === "activity" ? (
        <ActivityTab projectId={projectId} />
      ) : activeSub === "risk" ? (
        <DangerTab projectId={projectId} />
      ) : (
        <AutonomyTab projectId={projectId} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

const AUTOPILOT_MODE_OPTIONS: Array<{
  value: "REVIEW_EVERYTHING" | "CREATE_AUTOMATICALLY" | "AUTOPILOT";
  label: string;
  hint: string;
}> = [
  {
    value: "REVIEW_EVERYTHING",
    label: "Review everything",
    hint: "Agentelse creates work; nothing is scheduled until you review it.",
  },
  {
    value: "CREATE_AUTOMATICALLY",
    label: "Create automatically, ask before publishing",
    hint: "Agentelse creates and schedules work, but still asks before it can publish.",
  },
  {
    value: "AUTOPILOT",
    label: "Autopilot",
    hint: "Agentelse creates, schedules and publishes within the limits below.",
  },
];

async function AutonomyTab({ projectId }: { projectId: string }) {
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const [policy, monthlySpend, ideaGenSchedule, evaluatedOpportunityCount] =
    await Promise.all([
      prisma.autonomyPolicy.findUnique({ where: { projectId } }),
      // Read-only visibility only (spec: "AI Budget: this month $18.40/$50")
      // — reuses the SAME reasoningCostUsd AgencyDailyStat already tracks for
      // the existing daily budget check (AutonomyPolicyRepository.
      // checkAndIncrement); no new monthly cap/enforcement mechanism, no
      // schema change. AgencyDailyStat.reasoningCostUsd is itself a
      // token-based LLM-call cost estimate, not aggregate provider spend
      // (image-generation cost isn't tracked anywhere yet — see
      // docs/brand-workspace-migration.md §7 Phase 6) — this total inherits
      // that same scope, not a full "everything Agentelse spent."
      prisma.agencyDailyStat.aggregate({
        where: { projectId, date: { gte: monthStart } },
        _sum: { reasoningCostUsd: true },
      }),
      prisma.projectSchedule.findFirst({
        where: { projectId, capability: "GENERATE_IDEAS" },
      }),
      // Signal scanning + opportunity evaluation keep running in the
      // background even though idea generation itself stopped being
      // continuous (see agency-wiring.ts) — this surfaces the backlog so
      // the user can see what a manual/scheduled generate would draw from.
      prisma.opportunity.count({
        where: { projectId, status: "EVALUATED" },
      }),
    ]);

  if (!policy) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="No autonomy policy"
        hint="The policy is created in step 8 of setup; manage the agency's daily limits from here."
      />
    );
  }

  const weights =
    policy.scoringWeights && typeof policy.scoringWeights === "object"
      ? (policy.scoringWeights as Record<string, number>)
      : {};

  const limitFields: Array<{
    name: string;
    label: string;
    value: number;
    hint: string;
  }> = [
    {
      name: "maxTasksPerDay",
      label: "Daily task limit",
      value: policy.maxTasksPerDay,
      hint: "The maximum number of tasks the agency can create in a day",
    },
    {
      name: "maxReasoningCallsPerDay",
      label: "Daily reasoning limit",
      value: policy.maxReasoningCallsPerDay,
      hint: "The number of AI calls that can be made in a day",
    },
    {
      name: "maxConcurrentResearchTasks",
      label: "Concurrent research limit",
      value: policy.maxConcurrentResearchTasks,
      hint: "The number of research tasks running at the same time",
    },
    {
      name: "maxOpenOpportunities",
      label: "Open opportunity limit",
      value: policy.maxOpenOpportunities,
      hint: "The number of opportunities that can stay open at the same time",
    },
    {
      name: "maxActiveIdeas",
      label: "Active idea limit",
      value: policy.maxActiveIdeas,
      hint: "The number of ideas alive at the same time",
    },
    {
      name: "taskCooldownHours",
      label: "Task cooldown period (hours)",
      value: policy.taskCooldownHours,
      hint: "The time to wait before the same work item can be recreated",
    },
  ];

  const ideaGenEnabled = ideaGenSchedule?.enabled ?? false;
  const ideaGenConfig = (ideaGenSchedule?.configuration ?? {}) as {
    cadence?: string;
    dayOfWeek?: string;
    dayOfMonth?: number;
    limit?: number;
  };
  const ideaGenCadence =
    ideaGenConfig.cadence === "MONTHLY" ? "MONTHLY" : "WEEKLY";
  const ideaGenDayOfWeek = ideaGenConfig.dayOfWeek ?? "1";
  const ideaGenDayOfMonth = ideaGenConfig.dayOfMonth ?? 1;
  const ideaGenTime =
    cronToTime(ideaGenSchedule?.cronExpression ?? null) || "09:00";
  const ideaGenTimezone = ideaGenSchedule?.timezone ?? "Europe/Istanbul";
  const ideaGenLimit = ideaGenConfig.limit ?? 5;

  return (
    <div className="space-y-6">
      <ActionForm
        action={updateAutonomyPolicyAction}
        successMessage="Autonomy policy updated"
        className="space-y-4"
      >
        <input type="hidden" name="projectId" value={projectId} />

        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-base">Daily Limits</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {limitFields.map((field) => (
              <div key={field.name} className="space-y-1.5">
                <Label htmlFor={`policy-${field.name}`}>{field.label}</Label>
                <Input
                  id={`policy-${field.name}`}
                  name={field.name}
                  type="number"
                  min={0}
                  defaultValue={field.value}
                  required
                />
                <p className="text-xs text-muted-foreground">{field.hint}</p>
              </div>
            ))}
            <div className="space-y-1.5">
              <Label htmlFor="policy-dailyBudgetUsd">
                Daily budget (USD, blank = unlimited)
              </Label>
              <Input
                id="policy-dailyBudgetUsd"
                name="dailyBudgetUsd"
                type="number"
                step="0.01"
                min={0}
                defaultValue={policy.dailyBudgetUsd ?? ""}
              />
              <p className="text-xs text-muted-foreground">
                Daily cap on AI reasoning spend — this month so far:{" "}
                <span className="font-medium text-foreground">
                  ${(monthlySpend._sum.reasoningCostUsd ?? 0).toFixed(2)}
                </span>
              </p>
            </div>
            <div className="flex items-center gap-3 pt-6">
              <Switch
                key={`setupAutoApprove-${policy.setupAutoApprove}`}
                id="policy-setupAutoApprove"
                name="setupAutoApprove"
                defaultChecked={policy.setupAutoApprove}
              />
              <div>
                <Label htmlFor="policy-setupAutoApprove">
                  Setup auto-approval
                </Label>
                <p className="text-xs text-muted-foreground">
                  The system automatically approves decisions during the setup
                  stages
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-base">Autopilot</CardTitle>
            <p className="text-xs text-muted-foreground">
              Only governs autonomously-created content (today: weekly auto
              content planning below) — human-requested work is unaffected.
            </p>
          </CardHeader>
          <CardContent className="grid gap-2.5">
            {AUTOPILOT_MODE_OPTIONS.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-input p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
              >
                <input
                  type="radio"
                  name="autopilotMode"
                  value={option.value}
                  defaultChecked={policy.autopilotMode === option.value}
                  className="mt-0.5"
                />
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium">
                    {option.label}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {option.hint}
                  </span>
                </span>
              </label>
            ))}
          </CardContent>
        </Card>

        <Card
          size="sm"
          className={
            policy.unlimitedMode ? "ring-1 ring-warning/40" : undefined
          }
        >
          <CardHeader className="flex flex-row items-center gap-2 space-y-0">
            <span className="flex size-7 items-center justify-center rounded-lg bg-warning/15">
              <InfinityIcon className="size-4 text-warning" />
            </span>
            <CardTitle className="text-base">Unlimited Mode</CardTitle>
          </CardHeader>
          <CardContent className="flex items-start gap-3">
            <Switch
              key={`unlimitedMode-${policy.unlimitedMode}`}
              id="policy-unlimitedMode"
              name="unlimitedMode"
              defaultChecked={policy.unlimitedMode}
            />
            <div className="space-y-1">
              <Label htmlFor="policy-unlimitedMode">Disable daily limits</Label>
              <p className="text-xs text-muted-foreground">
                All the caps above and the daily budget are ignored: the agency
                runs without stopping. Counters keep tracking, only the blocking
                is lifted — you can monitor spend from the Activity tab.
              </p>
              {policy.unlimitedMode ? (
                <p className="text-xs font-medium text-warning">
                  Currently on — no upper limit on provider cost.
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-base">NBA Score Weights</CardTitle>
            <p className="text-xs text-muted-foreground">
              Between 0-1; a field left blank uses the engine&apos;s default.
              Penalties lower the score.
            </p>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            {Object.entries(WEIGHT_LABELS).map(([key, label]) => (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={`weight-${key}`} className="text-xs">
                  {label}
                </Label>
                <Input
                  id={`weight-${key}`}
                  name={`weight_${key}`}
                  type="number"
                  step="0.05"
                  min={0}
                  max={1}
                  defaultValue={weights[key] ?? ""}
                  placeholder="default"
                />
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="sticky bottom-4 flex justify-end">
          <SubmitButton>Save</SubmitButton>
        </div>
      </ActionForm>

      <ActionForm
        action={updateIdeaGenerationScheduleAction}
        successMessage="Idea generation schedule updated"
        className="space-y-4"
      >
        <input type="hidden" name="projectId" value={projectId} />

        <Card size="sm">
          <CardHeader className="flex flex-row items-center gap-2 space-y-0">
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10">
              <Lightbulb className="size-4 text-primary" />
            </span>
            <CardTitle className="text-base">
              Idea Generation Frequency
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex items-start gap-3">
              <Switch
                key={`idea-gen-enabled-${ideaGenEnabled}`}
                id="idea-gen-enabled"
                name="enabled"
                defaultChecked={ideaGenEnabled}
              />
              <div className="space-y-1">
                <Label htmlFor="idea-gen-enabled">
                  Turn evaluated opportunities into new ideas on a schedule
                </Label>
                <p className="text-xs text-muted-foreground">
                  Idea generation is on-demand only otherwise — ask for ideas
                  from chat any time. Turn this on for a predictable
                  weekly/monthly rhythm instead of an ad-hoc request every time.{" "}
                  {evaluatedOpportunityCount} evaluated opportunit
                  {evaluatedOpportunityCount === 1 ? "y" : "ies"} currently
                  waiting to become ideas.
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="idea-gen-cadence">Cadence</Label>
                <select
                  id="idea-gen-cadence"
                  name="cadence"
                  defaultValue={ideaGenCadence}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm"
                >
                  <option value="WEEKLY">Weekly</option>
                  <option value="MONTHLY">Monthly</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="idea-gen-day-of-week">Day of week</Label>
                <select
                  id="idea-gen-day-of-week"
                  name="dayOfWeek"
                  defaultValue={ideaGenDayOfWeek}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm"
                >
                  {WEEKDAY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Used when cadence is Weekly.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="idea-gen-day-of-month">Day of month</Label>
                <select
                  id="idea-gen-day-of-month"
                  name="dayOfMonth"
                  defaultValue={String(ideaGenDayOfMonth)}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm"
                >
                  {MONTHDAY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Used when cadence is Monthly.
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="idea-gen-time">Time</Label>
                <Input
                  id="idea-gen-time"
                  name="time"
                  type="time"
                  defaultValue={ideaGenTime}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="idea-gen-limit">Ideas per run</Label>
                <Input
                  id="idea-gen-limit"
                  name="limit"
                  type="number"
                  min={1}
                  max={10}
                  defaultValue={ideaGenLimit}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="idea-gen-timezone">Timezone</Label>
                <Input
                  id="idea-gen-timezone"
                  name="timezone"
                  defaultValue={ideaGenTimezone}
                  placeholder="Europe/Istanbul"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="sticky bottom-4 flex justify-end">
          <SubmitButton>Save</SubmitButton>
        </div>
      </ActionForm>
    </div>
  );
}

// ---------------------------------------------------------------------------

// A schedule row's cronExpression is always "M H * * *" (built by
// updateInstagramPublishScheduleAction) — this reads the HH:mm back out for
// the time input's defaultValue.
function cronToTime(cronExpression: string | null): string {
  if (!cronExpression) return "";
  const [minute, hour] = cronExpression.split(" ");
  if (!hour || !minute) return "";
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

// Same idea as cronToTime, but for the auto content plan's single weekly
// row ("M H * * D") — also reads the day-of-week field back out.
function cronToWeekly(cronExpression: string | null): {
  time: string;
  day: string;
} {
  if (!cronExpression) return { time: "09:00", day: "1" };
  const [minute, hour, , , dow] = cronExpression.split(" ");
  if (!hour || !minute) return { time: "09:00", day: "1" };
  return {
    time: `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`,
    day: dow && /^[0-6]$/.test(dow) ? dow : "1",
  };
}

const WEEKDAY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "0", label: "Sunday" },
];

// Capped at 28 (not 29-31) — a cron day-of-month past what a given month
// has just silently never fires that month, a confusing gap the UI avoids
// by never offering those values (see updateIdeaGenerationScheduleAction).
const MONTHDAY_OPTIONS: Array<{ value: string; label: string }> = Array.from(
  { length: 28 },
  (_, index) => ({ value: String(index + 1), label: String(index + 1) }),
);

async function PublishingTab({ projectId }: { projectId: string }) {
  const [schedules, queuedCount, autoPlanSchedule, shortlistedCount] =
    await Promise.all([
      prisma.projectSchedule.findMany({
        where: { projectId, capability: "INSTAGRAM_PUBLISH" },
      }),
      prisma.creative.count({
        where: { projectId, platform: "INSTAGRAM", status: "APPROVED" },
      }),
      prisma.projectSchedule.findFirst({
        where: {
          projectId,
          capability: "CREATE_CONTENT_PLAN",
          configuration: { path: ["mode"], equals: "AUTO_PLAN_GRID_WEEK" },
        },
      }),
      prisma.idea.count({ where: { projectId, status: "SHORTLISTED" } }),
    ]);

  const bySlot = new Map<number, (typeof schedules)[number]>();
  for (const schedule of schedules) {
    const slot = (schedule.configuration as { slot?: unknown } | null)?.slot;
    if (typeof slot === "number") bySlot.set(slot, schedule);
  }
  const enabled = schedules.some((schedule) => schedule.enabled);
  const timezone = schedules[0]?.timezone ?? "Europe/Istanbul";

  const autoPlanEnabled = autoPlanSchedule?.enabled ?? false;
  const autoPlanTimezone = autoPlanSchedule?.timezone ?? timezone;
  const { time: autoPlanTime, day: autoPlanDay } = cronToWeekly(
    autoPlanSchedule?.cronExpression ?? null,
  );
  const autoPlanCapRaw = (
    autoPlanSchedule?.configuration as { dailyImageCap?: unknown } | null
  )?.dailyImageCap;
  const autoPlanCap = typeof autoPlanCapRaw === "number" ? autoPlanCapRaw : 3;
  const autoPlanLensMix =
    (
      autoPlanSchedule?.configuration as {
        lensMix?: Record<string, number>;
      } | null
    )?.lensMix ?? {};

  return (
    <div className="space-y-6">
      <ActionForm
        action={updateInstagramPublishScheduleAction}
        successMessage="Publishing schedule updated"
        className="space-y-4"
      >
        <input type="hidden" name="projectId" value={projectId} />

        <Card size="sm">
          <CardHeader className="flex flex-row items-center gap-2 space-y-0">
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10">
              <CalendarClock className="size-4 text-primary" />
            </span>
            <CardTitle className="text-base">
              Instagram Publishing Schedule
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex items-start gap-3">
              <Switch
                key={`publishing-enabled-${enabled}`}
                id="publishing-enabled"
                name="enabled"
                defaultChecked={enabled}
              />
              <div className="space-y-1">
                <Label htmlFor="publishing-enabled">
                  Enable scheduled publishing
                </Label>
                <p className="text-xs text-muted-foreground">
                  When on, an approved Instagram creative no longer publishes
                  immediately — it waits in a queue and goes out at the next
                  slot below, oldest approved first. When off, approval
                  publishes immediately, same as today.
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              {[1, 2, 3].map((slot) => (
                <div key={slot} className="space-y-1.5">
                  <Label htmlFor={`publishing-slot${slot}`}>Slot {slot}</Label>
                  <Input
                    id={`publishing-slot${slot}`}
                    name={`slot${slot}`}
                    type="time"
                    defaultValue={cronToTime(
                      bySlot.get(slot)?.cronExpression ?? null,
                    )}
                  />
                </div>
              ))}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="publishing-timezone">Timezone</Label>
              <Input
                id="publishing-timezone"
                name="timezone"
                defaultValue={timezone}
                placeholder="Europe/Istanbul"
              />
              <p className="text-xs text-muted-foreground">
                An IANA zone name (e.g. Europe/Istanbul, UTC) — the slot times
                above are read in this zone.
              </p>
            </div>

            <p className="text-xs text-muted-foreground">
              {queuedCount} approved Instagram creative
              {queuedCount === 1 ? "" : "s"} currently waiting in the queue.
            </p>
          </CardContent>
        </Card>

        <div className="sticky bottom-4 flex justify-end">
          <SubmitButton>Save</SubmitButton>
        </div>
      </ActionForm>

      <ActionForm
        action={updateAutoContentPlanScheduleAction}
        successMessage="Auto content planning updated"
        className="space-y-4"
      >
        <input type="hidden" name="projectId" value={projectId} />

        <Card size="sm">
          <CardHeader className="flex flex-row items-center gap-2 space-y-0">
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10">
              <Sparkles className="size-4 text-primary" />
            </span>
            <CardTitle className="text-base">Auto Content Planning</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex items-start gap-3">
              <Switch
                key={`auto-plan-enabled-${autoPlanEnabled}`}
                id="auto-plan-enabled"
                name="enabled"
                defaultChecked={autoPlanEnabled}
              />
              <div className="space-y-1">
                <Label htmlFor="auto-plan-enabled">
                  Plan new Instagram posts automatically, every week
                </Label>
                <p className="text-xs text-muted-foreground">
                  When on, once a week the agency turns its own shortlisted
                  ideas into real images and schedules them — no manual request
                  needed. Capped at the daily limit below (× 7 days/week).{" "}
                  {shortlistedCount} idea
                  {shortlistedCount === 1 ? "" : "s"} currently shortlisted and
                  eligible.
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="auto-plan-day">Day of week</Label>
                <select
                  id="auto-plan-day"
                  name="dayOfWeek"
                  defaultValue={autoPlanDay}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm"
                >
                  {WEEKDAY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="auto-plan-time">Time</Label>
                <Input
                  id="auto-plan-time"
                  name="time"
                  type="time"
                  defaultValue={autoPlanTime}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="auto-plan-cap">Max images/day</Label>
                <Input
                  id="auto-plan-cap"
                  name="dailyImageCap"
                  type="number"
                  min={1}
                  max={10}
                  defaultValue={autoPlanCap}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="auto-plan-timezone">Timezone</Label>
              <Input
                id="auto-plan-timezone"
                name="timezone"
                defaultValue={autoPlanTimezone}
                placeholder="Europe/Istanbul"
              />
            </div>

            <div className="space-y-1.5 border-t border-border pt-4">
              <Label>Content mix (optional)</Label>
              <p className="text-xs text-muted-foreground">
                Relative weights — leave all at 0 to keep picking purely by
                score (default). E.g. Product 3, Brand 1 aims for roughly 3
                product posts per 1 brand post.
              </p>
              <div className="grid grid-cols-2 gap-3 pt-1 sm:grid-cols-3">
                {DEFAULT_LENS_MIX.map((lens) => (
                  <div key={lens} className="space-y-1">
                    <Label
                      htmlFor={`lens-weight-${lens}`}
                      className="text-xs font-normal text-muted-foreground"
                    >
                      {lens.charAt(0) + lens.slice(1).toLowerCase()}
                    </Label>
                    <Input
                      id={`lens-weight-${lens}`}
                      name={`lensWeight_${lens}`}
                      type="number"
                      min={0}
                      max={10}
                      step={1}
                      defaultValue={autoPlanLensMix[lens] ?? 0}
                    />
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="sticky bottom-4 flex justify-end">
          <SubmitButton>Save</SubmitButton>
        </div>
      </ActionForm>
    </div>
  );
}

// ---------------------------------------------------------------------------

// AgencyDecision.inputsSnapshot (agency-director.ts) — a free-form JSON
// snapshot, only one shape of which (the council fan-out on an idea
// decision) is worth a dedicated render; anything else in there (or on
// non-IDEA decisions, which don't set this field the same way) is
// silently ignored rather than guessed at.
function parseCouncilRecommendations(
  inputsSnapshot: unknown,
): { council: string; recommendation: string; overallScore: number | null }[] {
  if (!inputsSnapshot || typeof inputsSnapshot !== "object") return [];
  const raw = (inputsSnapshot as { councilRecommendations?: unknown })
    .councilRecommendations;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => {
      return (
        Boolean(entry) &&
        typeof entry === "object" &&
        typeof (entry as { council?: unknown }).council === "string" &&
        typeof (entry as { recommendation?: unknown }).recommendation ===
          "string"
      );
    })
    .map((entry) => ({
      council: entry.council as string,
      recommendation: entry.recommendation as string,
      overallScore:
        typeof entry.overallScore === "number" ? entry.overallScore : null,
    }));
}

async function DecisionsTab({
  projectId,
  entity,
}: {
  projectId: string;
  entity: PanelProps["entity"];
}) {
  if (entity && entity.kind === "decision") {
    return <DecisionDetail projectId={projectId} decisionId={entity.id} />;
  }

  const decisions = await prisma.agencyDecision.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  if (decisions.length === 0) {
    return (
      <EmptyState
        icon={Gavel}
        title="No decisions"
        hint="As the agency director makes decisions about opportunities and ideas, they're logged here with their rationale."
      />
    );
  }

  const opportunityIds = decisions
    .filter((d) => d.subjectType === "OPPORTUNITY")
    .map((d) => d.subjectId);
  const ideaIds = decisions
    .filter((d) => d.subjectType === "IDEA")
    .map((d) => d.subjectId);
  const [opportunities, ideas] = await Promise.all([
    opportunityIds.length
      ? prisma.opportunity.findMany({
          where: { id: { in: opportunityIds } },
          select: { id: true, title: true },
        })
      : [],
    ideaIds.length
      ? prisma.idea.findMany({
          where: { id: { in: ideaIds } },
          select: { id: true, title: true },
        })
      : [],
  ]);
  const subjectTitle = new Map([
    ...opportunities.map((o) => [o.id, o.title] as const),
    ...ideas.map((i) => [i.id, i.title] as const),
  ]);

  return (
    <Card size="sm">
      <CardContent className="divide-y divide-foreground/5">
        {decisions.map((decision) => {
          const breakdown =
            decision.scoreBreakdown &&
            typeof decision.scoreBreakdown === "object"
              ? (decision.scoreBreakdown as Record<string, unknown>)
              : null;
          // Written by agency-director.ts on every idea decision
          // (reject/backlog/create) but never rendered anywhere — the one
          // place that would show WHY beyond the one-line rationale
          // string (which council(s) actually recommended what, and at
          // what confidence).
          const councilRecommendations = parseCouncilRecommendations(
            decision.inputsSnapshot,
          );
          return (
            <div key={decision.id} className="space-y-2 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge meta={AGENCY_DECISION_TYPE[decision.decision]} />
                <StatusBadge
                  meta={AGENCY_DECISION_SUBJECT[decision.subjectType]}
                  className="h-4 px-1.5 text-[10px]"
                />
                {decision.approvalLevel ? (
                  <StatusBadge
                    meta={APPROVAL_LEVEL[decision.approvalLevel]}
                    className="h-4 px-1.5 text-[10px]"
                  />
                ) : null}
                {decision.isMock ? (
                  <StatusBadge
                    meta={{ label: "Demo", tone: "special" }}
                    className="h-4 px-1.5 text-[10px]"
                  />
                ) : null}
                <span className="text-xs text-muted-foreground">
                  {timeAgo(decision.createdAt)}
                </span>
              </div>
              <Link
                href={buildHubHref(projectId, {
                  panel: "settings",
                  sub: "decisions",
                  entity: { kind: "decision", id: decision.id },
                })}
                scroll={false}
                className="block text-sm font-medium underline-offset-2 hover:underline"
              >
                {subjectTitle.get(decision.subjectId) ??
                  `${AGENCY_DECISION_SUBJECT[decision.subjectType].label} record`}
              </Link>
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  Rationale
                </summary>
                <p className="mt-1 text-xs text-muted-foreground">
                  {decision.rationale}
                </p>
                {breakdown ? (
                  <div className="mt-2 grid max-w-md grid-cols-2 gap-x-4 gap-y-1">
                    {Object.entries(breakdown).map(([key, val]) =>
                      typeof val === "number" ? (
                        <ScoreBar
                          key={key}
                          value={val}
                          label={councilDimensionLabel(key)}
                        />
                      ) : null,
                    )}
                  </div>
                ) : null}
                {councilRecommendations.length > 0 ? (
                  <div className="mt-2 max-w-md space-y-1">
                    {councilRecommendations.map((rec, index) => (
                      <div
                        key={`${rec.council}-${index}`}
                        className="flex items-center justify-between gap-3 text-xs"
                      >
                        <span className="text-muted-foreground">
                          {rec.council}
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="font-medium text-foreground">
                            {rec.recommendation}
                          </span>
                          {rec.overallScore != null ? (
                            <span className="text-muted-foreground">
                              {Math.round(rec.overallScore * 100) / 100}
                            </span>
                          ) : null}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </details>
              {decision.workPlanId ? (
                <CrossLinkChip
                  projectId={projectId}
                  entity={{ kind: "workPlan", id: decision.workPlanId }}
                  text="Created work plan"
                  sub="plans"
                />
              ) : null}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

async function DecisionDetail({
  projectId,
  decisionId,
}: {
  projectId: string;
  decisionId: string;
}) {
  const decision = await prisma.agencyDecision.findUnique({
    where: { id: decisionId },
  });

  if (!decision || decision.projectId !== projectId) {
    return (
      <EmptyState
        icon={Gavel}
        title="Decision not found"
        hint="It may have been deleted."
      />
    );
  }

  const subjectTitle = await (async () => {
    if (decision.subjectType === "OPPORTUNITY") {
      const o = await prisma.opportunity.findUnique({
        where: { id: decision.subjectId },
        select: { title: true },
      });
      return o?.title;
    }
    if (decision.subjectType === "IDEA") {
      const i = await prisma.idea.findUnique({
        where: { id: decision.subjectId },
        select: { title: true },
      });
      return i?.title;
    }
    return undefined;
  })();

  const fields: FieldSpec[] = [
    {
      type: "badge",
      label: "Decision",
      meta: AGENCY_DECISION_TYPE[decision.decision],
    },
    {
      type: "badge",
      label: "Subject Type",
      meta: AGENCY_DECISION_SUBJECT[decision.subjectType],
    },
    {
      type: "badge",
      label: "Approval Level",
      meta: decision.approvalLevel
        ? APPROVAL_LEVEL[decision.approvalLevel]
        : undefined,
      fallback: "—",
    },
    { type: "boolean", label: "Demo Data (mock)", value: decision.isMock },
    {
      type: "date",
      label: "Created",
      value: decision.createdAt,
      relative: true,
    },
    { type: "text", label: "Rationale", value: decision.rationale },
  ];

  return (
    <div className="space-y-6">
      <Link
        href={buildHubHref(projectId, {
          panel: "settings",
          sub: "decisions",
          entity: null,
        })}
        scroll={false}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Back to list
      </Link>

      <Card size="sm">
        <CardContent className="space-y-3">
          <h3 className="font-heading text-lg font-semibold text-foreground">
            {subjectTitle ??
              `${AGENCY_DECISION_SUBJECT[decision.subjectType].label} record`}
          </h3>
          <FieldGrid fields={fields} />
          {decision.workPlanId ? (
            <CrossLinkChip
              projectId={projectId}
              entity={{ kind: "workPlan", id: decision.workPlanId }}
              text="Created work plan"
              sub="plans"
            />
          ) : null}
          {decision.taskIds.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {decision.taskIds.map((taskId) => (
                <CrossLinkChip
                  key={taskId}
                  projectId={projectId}
                  entity={{ kind: "task", id: taskId }}
                  text={`Task ${taskId.slice(0, 8)}`}
                  sub="tasks"
                />
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

async function ActivityTab({ projectId }: { projectId: string }) {
  const now = new Date();
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [stats, reasoningGroups, statusGroups, recentCalls, triggers] =
    await Promise.all([
      prisma.agencyDailyStat.findMany({
        where: { projectId, date: { gte: since } },
        orderBy: { date: "asc" },
      }),
      prisma.reasoningCall.groupBy({
        by: ["purpose", "isMock"],
        where: { projectId },
        _count: { id: true },
        _sum: { costUsd: true },
        _avg: { durationMs: true },
      }),
      prisma.reasoningCall.groupBy({
        by: ["status"],
        where: { projectId },
        _count: { id: true },
      }),
      prisma.reasoningCall.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take: 25,
      }),
      prisma.agencyTrigger.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    ]);

  const series: Array<{
    key:
      | "tasksCreated"
      | "signalsIngested"
      | "opportunitiesCreated"
      | "ideasCreated"
      | "reasoningCalls";
    label: string;
  }> = [
    { key: "tasksCreated", label: "Tasks" },
    { key: "signalsIngested", label: "Signals" },
    { key: "opportunitiesCreated", label: "Opportunities" },
    { key: "ideasCreated", label: "Ideas" },
    { key: "reasoningCalls", label: "AI Calls" },
  ];

  const totalCalls = reasoningGroups.reduce((sum, g) => sum + g._count.id, 0);
  const mockCalls = reasoningGroups
    .filter((g) => g.isMock)
    .reduce((sum, g) => sum + g._count.id, 0);
  const totalCost = reasoningGroups.reduce(
    (sum, g) => sum + (g._sum.costUsd ?? 0),
    0,
  );

  const purposeRows = new Map<
    string,
    { count: number; mock: number; cost: number; avgMs: number }
  >();
  for (const group of reasoningGroups) {
    const row = purposeRows.get(group.purpose) ?? {
      count: 0,
      mock: 0,
      cost: 0,
      avgMs: 0,
    };
    row.count += group._count.id;
    if (group.isMock) row.mock += group._count.id;
    row.cost += group._sum.costUsd ?? 0;
    row.avgMs = group._avg.durationMs ?? row.avgMs;
    purposeRows.set(group.purpose, row);
  }

  return (
    <div className="space-y-4">
      {stats.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No activity data"
          hint="Daily statistics accumulate here once the agency starts working."
        />
      ) : (
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-base">Last 30 Days</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {series.map((serie) => {
              const max = Math.max(...stats.map((s) => s[serie.key]), 1);
              const total = stats.reduce((sum, s) => sum + s[serie.key], 0);
              return (
                <div key={serie.key}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{serie.label}</span>
                    <span className="font-medium tabular-nums">{total}</span>
                  </div>
                  <div className="flex h-8 items-end gap-px">
                    {stats.map((stat) => (
                      <div
                        key={stat.id}
                        title={`${shortDate(stat.date)}: ${stat[serie.key]}`}
                        className={cn(
                          "min-w-0 flex-1 rounded-t-sm",
                          stat[serie.key] > 0 ? "bg-primary/70" : "bg-muted",
                        )}
                        style={{
                          height: `${Math.max(6, (stat[serie.key] / max) * 100)}%`,
                        }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <Card size="sm">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base">AI Reasoning</CardTitle>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="tabular-nums">{totalCalls} calls</span>
              {totalCalls > 0 ? (
                <StatusBadge
                  meta={{
                    label: `${Math.round((mockCalls / totalCalls) * 100)}% mock`,
                    tone: "special",
                  }}
                  className="h-4 px-1.5 text-[10px]"
                />
              ) : null}
              <span className="tabular-nums">${totalCost.toFixed(2)}</span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {purposeRows.size === 0 ? (
            <p className="text-sm text-muted-foreground">
              No AI calls made yet.
            </p>
          ) : (
            <>
              <div className="divide-y divide-foreground/5">
                {[...purposeRows.entries()]
                  .sort((a, b) => b[1].count - a[1].count)
                  .map(([purpose, row]) => (
                    <div
                      key={purpose}
                      className="flex items-center justify-between gap-3 py-1.5 text-xs"
                    >
                      <span className="min-w-0 truncate font-medium">
                        {purpose}
                      </span>
                      <div className="flex shrink-0 items-center gap-3 tabular-nums text-muted-foreground">
                        <span>{row.count} calls</span>
                        <span>{row.mock} mock</span>
                        <span>{Math.round(row.avgMs)} ms</span>
                        <span>${row.cost.toFixed(3)}</span>
                      </div>
                    </div>
                  ))}
              </div>

              {statusGroups.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {statusGroups.map((group) => (
                    <span
                      key={group.status}
                      className="rounded-4xl bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
                    >
                      {group.status}: {group._count.id}
                    </span>
                  ))}
                </div>
              ) : null}

              {recentCalls.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-sm font-medium text-foreground">
                    Recent Calls
                  </p>
                  <div className="divide-y divide-foreground/5">
                    {recentCalls.map((call) => (
                      <div key={call.id} className="space-y-1 py-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{call.purpose}</span>
                          <span className="rounded-4xl bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                            {call.model}
                          </span>
                          <StatusBadge
                            meta={{
                              label: call.status,
                              tone:
                                call.status === "ERROR" ||
                                call.status === "FAILED"
                                  ? "danger"
                                  : call.status === "OK" ||
                                      call.status === "SUCCESS"
                                    ? "positive"
                                    : "neutral",
                            }}
                            className="h-4 px-1.5 text-[10px]"
                          />
                          {call.isMock ? (
                            <StatusBadge
                              meta={{ label: "mock", tone: "special" }}
                              className="h-4 px-1.5 text-[10px]"
                            />
                          ) : null}
                          <span className="ml-auto text-muted-foreground">
                            {timeAgo(call.createdAt)}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
                          <span>input: {call.inputTokens ?? "—"} tok</span>
                          <span>output: {call.outputTokens ?? "—"} tok</span>
                          <span>{call.durationMs} ms</span>
                          <span>${(call.costUsd ?? 0).toFixed(4)}</span>
                        </div>
                        {call.errorMessage ? (
                          <p className="text-destructive">
                            {call.errorMessage}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-base">Triggers</CardTitle>
        </CardHeader>
        <CardContent>
          {triggers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No triggers yet.</p>
          ) : (
            <div className="divide-y divide-foreground/5">
              {triggers.map((trigger) => (
                <div key={trigger.id} className="space-y-1.5 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <StatusBadge meta={AGENCY_TRIGGER_TYPE[trigger.type]} />
                      {trigger.error ? (
                        <span className="min-w-0 truncate text-xs text-destructive">
                          {trigger.error}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatusBadge
                        meta={AGENCY_TRIGGER_STATUS[trigger.status]}
                        className="h-4 px-1.5 text-[10px]"
                      />
                      <span className="text-xs text-muted-foreground">
                        {timeAgo(trigger.createdAt)}
                      </span>
                    </div>
                  </div>
                  <details>
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      Details
                    </summary>
                    <FieldGrid
                      className="mt-1"
                      fields={[
                        {
                          type: "date",
                          label: "Scheduled For",
                          value: trigger.scheduledFor,
                        },
                        {
                          type: "date",
                          label: "Processed At",
                          value: trigger.processedAt,
                        },
                      ]}
                    />
                  </details>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

// The deletion preview counts table by table, so it's only computed
// when this tab is opened — it shouldn't add load to the other tabs.
async function DangerTab({ projectId }: { projectId: string }) {
  const preview = await ProjectDeletionService.preview(projectId);
  if (!preview) return null;

  return (
    <div className="space-y-3">
      <p className="flex items-center justify-between rounded-lg bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
        <span>Local asset files</span>
        <span className="font-mono tabular-nums text-foreground">
          {preview.localAssetFiles}
        </span>
      </p>
      <DeleteProjectCard
        projectId={preview.projectId}
        projectName={preview.projectName}
        totalRows={preview.totalRows}
        topTables={preview.byTable.slice(0, 12)}
      />
    </div>
  );
}
