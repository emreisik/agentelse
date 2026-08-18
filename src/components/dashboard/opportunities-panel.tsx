import Link from "next/link";
import type { Opportunity } from "@prisma/client";

import { OPPORTUNITY_STATUS } from "@/lib/labels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/shared/status-badge";

export function OpportunitiesPanel({
  opportunities,
  projectNameById,
}: {
  opportunities: Opportunity[];
  projectNameById: Map<string, string>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Öne Çıkan Fırsatlar</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {opportunities.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Henüz fırsat tespit edilmedi.
          </p>
        ) : (
          opportunities.map((opportunity) => (
            <div key={opportunity.id} className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <Link
                  href={`/projects/${opportunity.projectId}?panel=icgoru-firsat&entity=opportunity:${opportunity.id}`}
                  className="truncate text-sm font-medium underline-offset-2 hover:underline"
                >
                  {opportunity.title}
                </Link>
                <StatusBadge
                  meta={OPPORTUNITY_STATUS[opportunity.status]}
                  className="shrink-0"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {projectNameById.get(opportunity.projectId) ??
                  "Bilinmeyen proje"}
                {opportunity.description ? ` · ${opportunity.description}` : ""}
              </p>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
