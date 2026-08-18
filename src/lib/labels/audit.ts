// Translates raw AuditLog.action strings (e.g. "work_plan.approved") into
// readable English sentences — the single source for the sidebar activity
// feed and any other activity lists added later.
const AUDIT_ACTION_LABELS: Record<string, string> = {
  "setup.started": "Setup started",
  "agency-setup.started": "Agency setup started",
  "self-healing.stuck_job_reset": "Stuck job auto-recovered",
  "self-healing.dead_letter_requeued": "Failed job requeued",
  "department.mode_changed": "Department mode changed",
  "signal_profile.intensity_changed": "Signal profile intensity changed",
  "autonomy_policy.updated": "Autonomy policy updated",
  "work_plan.approved": "Work plan approved",
  "work_plan.cancelled": "Work plan cancelled",
  "handoff.accepted": "Handoff offer accepted",
  "handoff.rejected": "Handoff offer rejected",
  "project.created": "Project created",
  "project.deleted": "Project deleted",
  "command.received": "Command received",
  "human_action.resolved": "Human action resolved",
  "integration_credential.connected": "Integration connected",
  "integration_credential.disconnected": "Integration disconnected",
  "health.dead_letter_retried": "Dead letter record retried",
  "browser_profile.added": "Channel added",
  "browser_profile.marked_connected": "Channel marked as connected",
  "browser_profile.disabled": "Channel disabled",
  "approval.approved": "Approval granted",
  "approval.rejected": "Approval rejected",
};

// Fallback for actions that aren't in the map (newly added ones) — instead
// of silently breaking, a rough but readable transform:
// "some_thing.happened" -> "Some thing happened".
function humanize(action: string): string {
  const spaced = action.replace(/[._-]+/g, " ").trim();
  if (!spaced) return action;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function describeAuditAction(action: string): string {
  if (action.startsWith("reasoning.")) {
    return `AI reasoning: ${humanize(action.slice("reasoning.".length))}`;
  }
  return AUDIT_ACTION_LABELS[action] ?? humanize(action);
}
