import Link from "next/link";
import {
  CalendarClock,
  Gauge,
  Infinity as InfinityIcon,
  ShieldCheck,
} from "lucide-react";

import { prisma } from "@/lib/prisma";
import { autonomyFormView } from "@/lib/billing/user-limits";
import { getEntitlements } from "@/server/billing/entitlements";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/dates";
import { updateAutonomyPolicyAction } from "@/server/actions/agency-config-actions";
import {
  updateAdsAutopilotAction,
  updateSpendApproversAction,
} from "@/server/actions/ads-autopilot-actions";
import {
  fullPrerequisitesMet,
  missingFullPrerequisites,
  type AutonomyLevel,
} from "@/lib/ads/autopilot";
import { AdsFlags } from "@/lib/ads/flags";
import { toMajorUnits } from "@/lib/ads/money";
import { AdsAutopilot } from "@/server/ads/autopilot";
import { WEEKLY_AUTO_PRODUCE_COPY, weeklyDraftOn } from "@/lib/weekly-draft";
import { updateInstagramPublishScheduleAction } from "@/server/actions/publish-schedule-actions";
import { ProjectDeletionService } from "@/server/projects/project-deletion.service";
import { ActionForm } from "@/components/shared/action-form";
import { WebsiteReportSettingsCard } from "@/components/website-analytics/reports/report-settings-card";
import { DeleteProjectCard } from "@/components/projects/delete-project-card";
import { LinkTrackingCard } from "@/components/projects/link-tracking-card";
import { EmptyState } from "@/components/shared/empty-state";
import { LiveRefresh } from "@/components/shared/live-refresh";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TimePicker } from "@/components/ui/date-time-picker";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  SETTINGS_SUB_KEYS,
  buildHubHref,
  type SettingsSubKey,
} from "../hub-core-params";
import type { PanelProps } from "./panel-props";

const SUB_LABEL: Record<SettingsSubKey, string> = {
  autonomy: "Autonomy",
  publishing: "Publishing",
  activity: "Activity",
  risk: "Danger Zone",
};

export async function SettingsPanel({ projectId, sub }: PanelProps) {
  const activeSub: SettingsSubKey =
    sub && (SETTINGS_SUB_KEYS as readonly string[]).includes(sub)
      ? (sub as SettingsSubKey)
      : "autonomy";

  return (
    <div className="space-y-6 py-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1 border-b border-foreground/10">
          {SETTINGS_SUB_KEYS.map((key) => {
            const isActive = key === activeSub;
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

async function AutonomyTab({ projectId }: { projectId: string }) {
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const [policy, monthlySpend] = await Promise.all([
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
  ]);

  // The plan the workspace is on (when billing is active) sets the range the user's own
  // limits can be chosen in.
  const entitlements = policy
    ? await getEntitlements(policy.workspaceId)
    : null;
  const planKey =
    entitlements && !entitlements.unlimited ? entitlements.planKey : null;

  if (!policy) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="No autonomy policy"
        hint="The policy is created with the project; manage the agency's daily limits from here."
      />
    );
  }

  // What the limit fields show: a saved value outside today's range is shown pulled
  // into it (the browser would otherwise refuse the whole form over it), and the
  // approval size only where it does something (billing enforcing, with a plan).
  const view = autonomyFormView({
    mode: entitlements?.mode ?? "off",
    planKey,
    stored: {
      approveAboveUsd: policy.approveAboveUsd,
      dailyBudgetUsd: policy.dailyBudgetUsd,
    },
  });
  const { ranges } = view;

  const limitFields: Array<{
    name: string;
    label: string;
    value: number;
    hint: string;
  }> = [
    {
      name: "maxReasoningCallsPerDay",
      label: "Daily AI call limit",
      value: policy.maxReasoningCallsPerDay,
      hint: "AI calls per day, shared by the chat and the background loop",
    },
    {
      name: "maxActiveIdeas",
      label: "Idea pool size",
      value: policy.maxActiveIdeas,
      hint: "How many ideas can wait in the pool; new ideas stop when it is full",
    },
  ];

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
            <CardTitle className="text-base">Daily limits</CardTitle>
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
                max={ranges.dailyBudgetMax ?? undefined}
                defaultValue={view.dailyBudgetUsd ?? ""}
              />
              <p className="text-xs text-muted-foreground">
                {ranges.dailyBudgetMax !== null
                  ? `At most $${ranges.dailyBudgetMax.toFixed(2)}, your plan's AI budget for a month. `
                  : null}
                {view.dailyBudgetClamped
                  ? "Your saved budget was above that, so it is shown at the limit; saving applies it. "
                  : null}
                Daily cap on AI reasoning spend — this month so far:{" "}
                <span className="font-medium text-foreground">
                  ${(monthlySpend._sum.reasoningCostUsd ?? 0).toFixed(2)}
                </span>
              </p>
            </div>
            {view.showApproveAbove ? (
              <div className="space-y-1.5">
                <Label htmlFor="policy-approveAboveUsd">
                  Ask me before an automatic task costs more than (USD)
                </Label>
                <Input
                  id="policy-approveAboveUsd"
                  name="approveAboveUsd"
                  type="number"
                  step="0.01"
                  min={ranges.approveAbove.min}
                  max={ranges.approveAbove.max}
                  placeholder={
                    ranges.approveAbove.planDefault?.toFixed(2) ?? undefined
                  }
                  defaultValue={view.approveAboveUsd ?? ""}
                />
                <p className="text-xs text-muted-foreground">
                  Blank uses your plan&apos;s size ($
                  {ranges.approveAbove.planDefault?.toFixed(2)}). You can set it
                  between ${ranges.approveAbove.min.toFixed(2)} and $
                  {ranges.approveAbove.max.toFixed(2)}. Bigger automatic tasks
                  wait for your OK; what you start yourself never does.
                  {view.approveAboveClamped
                    ? " Your saved size was outside that range, so it is shown inside it; saving applies it."
                    : null}
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader className="flex flex-row items-center gap-2 space-y-0">
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10">
              <CalendarClock className="size-4 text-primary" />
            </span>
            <CardTitle className="text-base">Weekly plan draft</CardTitle>
          </CardHeader>
          <CardContent className="flex items-start gap-3">
            <Switch
              key={`weeklyDraft-${policy.autopilotMode}`}
              id="policy-weeklyDraft"
              name="weeklyDraft"
              defaultChecked={weeklyDraftOn(policy.autopilotMode)}
            />
            <div className="space-y-1">
              <Label htmlFor="policy-weeklyDraft">
                Draft next week&apos;s plan every Sunday evening
              </Label>
              <p className="text-xs text-muted-foreground">
                Agentelse plans next week from your idea pool in a chat of its
                own and points to it from every chat. Nothing is saved, made or
                published until you approve it.
              </p>
            </div>
          </CardContent>
          <CardContent className="flex items-start gap-3 border-t pt-4">
            <Switch
              key={`weeklyAutoProduce-${policy.weeklyAutoProduce}`}
              id="policy-weeklyAutoProduce"
              name="weeklyAutoProduce"
              defaultChecked={policy.weeklyAutoProduce}
            />
            <div className="space-y-1">
              <Label htmlFor="policy-weeklyAutoProduce">
                {WEEKLY_AUTO_PRODUCE_COPY.settingsLabel}
              </Label>
              <p className="text-xs text-muted-foreground">
                {WEEKLY_AUTO_PRODUCE_COPY.settingsDescription} Only while
                &quot;Draft next week&apos;s plan every Sunday evening&quot;
                above is also on.
              </p>
            </div>
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
                The daily AI call limit, the idea pool size and the daily budget
                above are ignored: the agency runs without stopping. Counters
                keep tracking, only the blocking is lifted — you can monitor
                spend from the Activity tab. Your plan&apos;s usage allowance
                still applies
                {view.showApproveAbove
                  ? ", and so does the size above which automatic tasks wait for your OK"
                  : null}
                .
              </p>
              {policy.unlimitedMode ? (
                <p className="text-xs font-medium text-warning">
                  Currently on — no upper limit on provider cost.
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <div className="sticky bottom-4 flex justify-end">
          <SubmitButton>Save</SubmitButton>
        </div>
      </ActionForm>

      {AdsFlags.autopilot() ? (
        <AdsAutopilotCard
          projectId={projectId}
          level={policy.adsAutonomy}
          monthlyCapMinor={
            policy.adsMonthlyCapMinor === null
              ? null
              : Number(policy.adsMonthlyCapMinor)
          }
        />
      ) : null}

      {AdsFlags.agency() ? (
        <SpendApproversCard
          projectId={projectId}
          workspaceId={policy.workspaceId}
          approverIds={policy.adsSpendApproverIds}
        />
      ) : null}

      <WebsiteReportSettingsCard projectId={projectId} />
    </div>
  );
}

// Spend approvers (docs/meta-ads-plan.md F8): müşteri tarafındaki üye bu
// projenin harcama onayını verebilir (yalnız bu proje). Owner ve admin zaten
// onaylayabildiği için listede yalnız üyeler var.
async function SpendApproversCard({
  projectId,
  workspaceId,
  approverIds,
}: {
  projectId: string;
  workspaceId: string;
  approverIds: string[];
}) {
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId, role: "MEMBER" },
    select: { userId: true, user: { select: { name: true, email: true } } },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  return (
    <ActionForm
      action={updateSpendApproversAction}
      successMessage="Spend approvers updated"
      className="space-y-4"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <Card size="sm">
        <CardHeader className="flex flex-row items-center gap-2 space-y-0">
          <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10">
            <ShieldCheck className="size-4 text-primary" />
          </span>
          <CardTitle className="text-base">Spend approvers</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Owners and admins can always approve ad spend. Pick members (for
            example your client) who may approve spend for this project only.
          </p>
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Invite your client to the workspace as a member first.
            </p>
          ) : (
            members.map((member) => (
              <label
                key={member.userId}
                className="flex cursor-pointer items-center gap-3 text-sm"
              >
                <input
                  type="checkbox"
                  name="approverIds"
                  value={member.userId}
                  defaultChecked={approverIds.includes(member.userId)}
                  className="accent-primary"
                />
                <span>
                  {member.user.name ?? member.user.email}
                  {member.user.name && member.user.email ? (
                    <span className="text-muted-foreground">
                      {" "}
                      · {member.user.email}
                    </span>
                  ) : null}
                </span>
              </label>
            ))
          )}
        </CardContent>
      </Card>
      {members.length > 0 ? (
        <div className="flex justify-end">
          <SubmitButton>Save approvers</SubmitButton>
        </div>
      ) : null}
    </ActionForm>
  );
}

// Ads autopilot (docs/meta-ads-plan.md §1.2, F7): proje bazında açık rıza.
// Ayrı form: yalnız OWNER/ADMIN kaydedebilir (sunucu denetler).
const ADS_LEVELS: {
  value: AutonomyLevel;
  label: string;
  hint: string;
}[] = [
  {
    value: "SUGGEST",
    label: "Suggest only",
    hint: "Agentelse suggests every change. Nothing changes in Meta until you approve it.",
  },
  {
    value: "GUARDED",
    label: "Guarded auto",
    hint: "Agentelse pauses ads that overspend or bring no messages or leads, and lowers budgets by up to 30%, on its own. It never raises a budget or starts an ad. You get a message each time and can undo it.",
  },
  {
    value: "FULL",
    label: "Full auto",
    hint: "Everything in Guarded auto, plus budget raises of up to 20% at most every 3 days, within your monthly cap.",
  },
];

async function AdsAutopilotCard({
  projectId,
  level,
  monthlyCapMinor,
}: {
  projectId: string;
  level: AutonomyLevel;
  monthlyCapMinor: number | null;
}) {
  const prerequisites = await AdsAutopilot.fullPrerequisites(projectId);
  const fullReady = fullPrerequisitesMet({
    ...prerequisites,
    // Tavan bu formda girilebilir: FULL seçilebilirliği ona bağlanmaz.
    monthlyCapSet: true,
  });
  const missing = missingFullPrerequisites(prerequisites);
  const currency = prerequisites.currency;
  return (
    <ActionForm
      action={updateAdsAutopilotAction}
      successMessage="Ads autopilot updated"
      className="space-y-4"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <Card size="sm">
        <CardHeader className="flex flex-row items-center gap-2 space-y-0">
          <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10">
            <Gauge className="size-4 text-primary" />
          </span>
          <CardTitle className="text-base">Ads autopilot</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {ADS_LEVELS.map((option) => {
            const disabled = option.value === "FULL" && !fullReady;
            return (
              <label
                key={option.value}
                className={cn(
                  "flex items-start gap-3 rounded-lg border border-foreground/10 p-3",
                  disabled
                    ? "cursor-not-allowed opacity-60"
                    : "cursor-pointer hover:bg-muted/40",
                )}
              >
                <input
                  type="radio"
                  name="adsAutonomy"
                  value={option.value}
                  defaultChecked={level === option.value}
                  disabled={disabled}
                  className="mt-1 accent-primary"
                />
                <span className="space-y-1">
                  <span className="block text-sm font-medium">
                    {option.label}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {option.hint}
                  </span>
                  {option.value === "FULL" && missing.length > 0 ? (
                    <span className="block text-xs text-muted-foreground">
                      Still needed: {missing.join("; ")}.
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </CardContent>
        <CardContent className="grid gap-4 border-t pt-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ads-monthly-cap">
              Monthly ad spending cap{currency ? ` (${currency})` : ""}
            </Label>
            <Input
              id="ads-monthly-cap"
              name="adsMonthlyCap"
              type="number"
              step="0.01"
              min={0}
              defaultValue={
                monthlyCapMinor === null
                  ? ""
                  : toMajorUnits(monthlyCapMinor, currency)
              }
            />
            <p className="text-xs text-muted-foreground">
              Optional. When this month&apos;s spend reaches it, Agentelse
              alerts you and, in Guarded or Full auto, pauses its campaigns.
              Full auto needs it.
            </p>
          </div>
          <div className="flex items-start gap-3">
            <input
              id="ads-autopilot-consent"
              type="checkbox"
              name="adsAutopilotConsent"
              defaultChecked={level !== "SUGGEST"}
              className="mt-1 accent-primary"
            />
            <Label htmlFor="ads-autopilot-consent" className="text-xs font-normal leading-relaxed text-muted-foreground">
              I let Agentelse make these changes to this project&apos;s Meta
              ads on its own. Only workspace owners and admins can turn this
              on.
            </Label>
          </div>
        </CardContent>
      </Card>
      <div className="flex justify-end">
        <SubmitButton>Save autopilot</SubmitButton>
      </div>
    </ActionForm>
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

async function PublishingTab({ projectId }: { projectId: string }) {
  const [schedules, queuedCount] = await Promise.all([
    prisma.projectSchedule.findMany({
      where: { projectId, capability: "INSTAGRAM_PUBLISH" },
    }),
    prisma.creative.count({
      where: { projectId, platform: "INSTAGRAM", status: "APPROVED" },
    }),
  ]);

  const bySlot = new Map<number, (typeof schedules)[number]>();
  for (const schedule of schedules) {
    const slot = (schedule.configuration as { slot?: unknown } | null)?.slot;
    if (typeof slot === "number") bySlot.set(slot, schedule);
  }
  const enabled = schedules.some((schedule) => schedule.enabled);
  const timezone = schedules[0]?.timezone ?? "Europe/Istanbul";

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
                  When on, approved Instagram posts go out at the slots below: a
                  planned post at the first slot after its planned time, oldest
                  first. When off, approving a post with no planned time
                  publishes it right away, and planned posts wait until this is
                  turned on.
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              {[1, 2, 3].map((slot) => (
                <div key={slot} className="space-y-1.5">
                  <Label htmlFor={`publishing-slot${slot}`}>Slot {slot}</Label>
                  <TimePicker
                    id={`publishing-slot${slot}`}
                    name={`slot${slot}`}
                    defaultValue={cronToTime(
                      bySlot.get(slot)?.cronExpression ?? null,
                    )}
                    // An empty slot is a slot that is off.
                    clearable
                    placeholder="Off"
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
      <LinkTrackingCard projectId={projectId} />
    </div>
  );
}

// ---------------------------------------------------------------------------

async function ActivityTab({ projectId }: { projectId: string }) {
  const [reasoningGroups, statusGroups, recentCalls] = await Promise.all([
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
  ]);

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
