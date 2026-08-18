import { timeAgo } from "@/lib/dates";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const ACTION_LABELS: Record<string, string> = {
  "approval.approved": "onaylandı",
  "approval.rejected": "reddedildi",
  "task.cancelled": "görev iptal edildi",
  "task.retried": "görev yeniden denendi",
  "task.unblocked": "görev blokajı kaldırıldı",
  "agency-setup.started": "ajans kurulumu başlatıldı",
  "goal.approved": "hedef onaylandı",
  "goal.rejected": "hedef reddedildi",
  "goal.updated": "hedef güncellendi",
  "autonomy_policy.updated": "otonomi politikası güncellendi",
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
        <CardTitle className="text-base">Son Aktivite</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {activities.length === 0 ? (
          <p className="text-sm text-muted-foreground">Henüz aktivite yok.</p>
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
