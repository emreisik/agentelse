import Link from "next/link";
import type { BrowserProfile, HumanInterventionRequest } from "@prisma/client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { statusBadgeVariant } from "@/lib/utils";
import { HUMAN_INTERVENTION_TYPE } from "@/lib/labels";
import { StatusBadge } from "@/components/shared/status-badge";
import { PURPOSE_ICONS } from "@/features/dashboard/purpose-icons";

const PROFILE_STATUS_LABELS: Record<string, string> = {
  READY: "Hazır",
  PENDING_SETUP: "Kurulum Bekliyor",
  NEEDS_LOGIN: "Giriş Gerekli",
  ERROR: "Hata",
  DISABLED: "Devre Dışı",
};

export function OpsPanel({
  browserProfiles,
  humanActions,
  projectNameById,
}: {
  browserProfiles: BrowserProfile[];
  humanActions: HumanInterventionRequest[];
  projectNameById: Map<string, string>;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">
          Tarayıcı Ajanları & İnsan Eylemleri
        </CardTitle>
        <Link
          href="/human-actions"
          className="text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          Tümünü gör
        </Link>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          {browserProfiles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Henüz tarayıcı profili yok.
            </p>
          ) : (
            browserProfiles.map((profile) => {
              const Icon = PURPOSE_ICONS[profile.purpose].icon;
              return (
                <div
                  key={profile.id}
                  className="flex items-center justify-between py-1 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{profile.name}</span>
                  </span>
                  <Badge variant={statusBadgeVariant(profile.status)}>
                    {PROFILE_STATUS_LABELS[profile.status] ?? profile.status}
                  </Badge>
                </div>
              );
            })
          )}
        </div>

        {humanActions.length > 0 ? (
          <div className="space-y-1.5 border-t border-border pt-3">
            {humanActions.map((request) => (
              <Link
                key={request.id}
                href="/human-actions"
                className="flex items-center justify-between rounded-md py-1 text-sm transition-colors hover:bg-accent"
              >
                <span className="truncate pr-2">
                  {projectNameById.get(request.projectId) ?? "Bilinmeyen proje"}{" "}
                  — {request.title}
                </span>
                <StatusBadge
                  meta={HUMAN_INTERVENTION_TYPE[request.type]}
                  fallback={request.type}
                  className="h-4 px-1.5 text-[10px]"
                />
              </Link>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
