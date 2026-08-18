"use client";

import Link from "next/link";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import type { BrowserProfilePurpose } from "@prisma/client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { statusBadgeVariant } from "@/lib/utils";
import { PURPOSE_ICONS } from "@/features/dashboard/purpose-icons";

const PROJECT_STATUS_LABELS: Record<string, string> = {
  CREATED: "Oluşturuldu",
  DISCOVERY: "Keşif",
  NEEDS_INFORMATION: "Bilgi Gerekli",
  PROFILE_REVIEW: "Profil İncelemesi",
  NEEDS_ASSESSMENT: "Değerlendirme Gerekli",
  STRATEGY: "Strateji",
  ACTIVE: "Aktif",
  PAUSED: "Duraklatıldı",
  CLOSED: "Kapatıldı",
};

export function ProjectOverviewCard({
  project,
  purposes,
  healthPercent,
  sparkline,
}: {
  project: { id: string; name: string; status: string };
  purposes: BrowserProfilePurpose[];
  healthPercent: number | null;
  sparkline: { day: string; rate: number }[];
}) {
  return (
    <Card className="transition-colors hover:bg-muted/40">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <Link href={`/projects/${project.id}`}>
          <CardTitle className="text-base hover:underline">
            {project.name}
          </CardTitle>
        </Link>
        <Badge variant={statusBadgeVariant(project.status)}>
          {PROJECT_STATUS_LABELS[project.status] ?? project.status}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {purposes.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              Henüz aktif entegrasyon yok.
            </span>
          ) : (
            purposes.map((purpose) => {
              const { label, icon: Icon } = PURPOSE_ICONS[purpose];
              return (
                <span
                  key={purpose}
                  title={label}
                  className="flex size-7 items-center justify-center rounded-lg bg-muted text-foreground"
                >
                  <Icon className="size-3.5" />
                </span>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs text-muted-foreground">
              Sağlık (son 30 gün)
            </div>
            <div className="text-lg font-semibold">
              {healthPercent === null ? "—" : `${healthPercent}%`}
            </div>
          </div>
          {sparkline.length > 1 ? (
            <div className="h-8 w-24">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={sparkline}>
                  <Line
                    type="monotone"
                    dataKey="rate"
                    stroke="var(--chart-1)"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
