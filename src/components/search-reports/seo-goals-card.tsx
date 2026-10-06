import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import {
  SeoGoalPaceBadge,
  goalValueText,
} from "@/components/search-reports/seo-goal-pace-badge";
import { SEO_GOAL_METRICS } from "@/lib/seo/reports/goals";
import { SEO_GOAL_METRIC_KEYS, type SeoReportGoal } from "@/lib/seo/reports/types";
import { dayLabel } from "@/lib/seo/reports/text";
import {
  archiveSeoGoalAction,
  createSeoGoalAction,
} from "@/server/actions/seo-report-actions";

// Search sayfasındaki "SEO goals" kartı (SC-F5, docs/search-reports.md
// "Hedefler"): hedefler, temposu, hedef ve güncel değer, ölçüm günü ve
// arşivleme; altında "Add a goal" formu. Beş ölçüt sabittir (SEO_GOAL_METRICS).
// Hedef değeri Brand Brain'de değil burada girilir.

const selectClass =
  "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
const inputClass =
  "h-8 w-28 rounded-lg border border-input bg-background px-2 text-sm tabular-nums outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

function GoalRow({
  projectId,
  goal,
}: {
  projectId: string;
  goal: SeoReportGoal;
}) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 rounded-xl p-3 ring-1 ring-foreground/10">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">{goal.title}</p>
          <SeoGoalPaceBadge pace={goal.pace} label={goal.paceLabel} />
        </div>
        <p className="text-xs tabular-nums text-muted-foreground">
          Target {goalValueText(goal.metricKey, goal.target)} · Now{" "}
          {goalValueText(goal.metricKey, goal.current)}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {goal.measuredThrough
            ? `Measured through ${dayLabel(goal.measuredThrough)}`
            : "Not measured yet"}
          {goal.projected !== null
            ? ` · 13-week projection ${goalValueText(goal.metricKey, goal.projected)}`
            : ""}
        </p>
      </div>
      <ActionForm
        action={archiveSeoGoalAction}
        successMessage="Goal archived"
        className="flex"
      >
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="goalId" value={goal.goalId} />
        <SubmitButton size="xs" variant="ghost">
          Archive
        </SubmitButton>
      </ActionForm>
    </li>
  );
}

export function SeoGoalsCard({
  projectId,
  goals,
}: {
  projectId: string;
  goals: SeoReportGoal[];
}) {
  return (
    <div data-card="seo-goals" className="space-y-3">
      <h3 className="text-sm font-semibold">SEO goals</h3>
      {goals.length > 0 ? (
        <ul className="space-y-2">
          {goals.map((goal) => (
            <GoalRow key={goal.goalId} projectId={projectId} goal={goal} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No SEO goals yet. Add one to see whether you are on pace.
        </p>
      )}
      <ActionForm
        action={createSeoGoalAction}
        successMessage="Goal saved"
        className="space-y-2"
      >
        <input type="hidden" name="projectId" value={projectId} />
        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1 text-xs text-muted-foreground">
            <span className="block">Goal</span>
            <select
              name="metricKey"
              defaultValue={SEO_GOAL_METRIC_KEYS[0]}
              className={selectClass}
            >
              {SEO_GOAL_METRIC_KEYS.map((key) => (
                <option key={key} value={key}>
                  {SEO_GOAL_METRICS[key].label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span className="block">Target</span>
            <input
              name="target"
              type="number"
              inputMode="decimal"
              min={1}
              step="any"
              required
              className={inputClass}
            />
          </label>
          <SubmitButton size="sm" variant="outline">
            Add a goal
          </SubmitButton>
        </div>
        <ul className="space-y-0.5 text-[11px] text-muted-foreground">
          {SEO_GOAL_METRIC_KEYS.map((key) => {
            const metric = SEO_GOAL_METRICS[key];
            return (
              <li key={key}>
                {metric.label}:{" "}
                {metric.unit === "percent"
                  ? "a percent, up to 100"
                  : "a whole number"}
                . Measured: {metric.window}.
              </li>
            );
          })}
        </ul>
        <p className="text-[11px] text-muted-foreground">
          The pace is a 13-week projection from your weekly measurements.
        </p>
      </ActionForm>
    </div>
  );
}
