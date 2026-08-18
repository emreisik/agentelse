import { timeAgo } from "@/lib/dates";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const ACTION_LABELS: Record<string, string> = {
  "approval.approved": "approved",
  "approval.rejected": "rejected",
  "task.cancelled": "task cancelled",
  "task.retried": "task retried",
  "task.unblocked": "task unblocked",
  "agency-setup.started": "agency setup started",
  "goal.approved": "goal approved",
  "goal.rejected": "goal rejected",
  "goal.updated": "goal updated",
  "autonomy_policy.updated": "autonomy policy updated",
};

function describeAction(action: string) {
  return (
    ACTION_LABELS[action] ?? action.replaceAll(".", " ").replaceAll("_", " ")
  );
}

export function ActivityFeed({
  activities,
}: {
  activities: {
    id: string;
    action: string;
    entityType: string;
    actorLabel: string;
    projectName: string | null;
    createdAt: Date;
  }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent Activity</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {activities.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity yet.</p>
        ) : (
          activities.map((activity) => (
            <div
              key={activity.id}
              className="flex items-start justify-between gap-3 text-sm"
            >
              <p className="min-w-0">
                <span className="font-medium">{activity.entityType}</span>{" "}
                <span className="text-muted-foreground">
                  {describeAction(activity.action)}
                </span>{" "}
                <span className="text-muted-foreground">
                  · {activity.actorLabel}
                  {activity.projectName ? ` · ${activity.projectName}` : ""}
                </span>
              </p>
              <span className="shrink-0 text-xs text-muted-foreground">
                {timeAgo(activity.createdAt)}
              </span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
