import Link from "next/link";
import { ClipboardCheck } from "lucide-react";

import { prisma } from "@/lib/prisma";
import { timeAgo } from "@/lib/dates";
import { APPROVAL_LEVEL, APPROVAL_TYPE } from "@/lib/labels";
import {
  approveApprovalAction,
  rejectApprovalAction,
} from "@/server/actions/approval-actions";
import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildHubHref } from "../hub-core-params";
import type { PanelProps } from "./panel-props";

const ENTITY_LABELS: Record<string, string> = {
  Task: "Görev",
  Creative: "Kreatif",
  WorkPlan: "İş Planı",
  ProjectGoal: "Hedef",
  WorkHandoff: "Devir",
};

// Onaylanan/reddedilen kaydın kendi paneline götüren link — eskiden
// /approvals sayfasının kendi local'i olan aynı eşleme, artık hub-core'un
// buildHubHref'iyle (proje köküne göreli) üretiliyor. Creative onayları
// hub-core'un bir "entity kind"i değil, kendi ayrı /creatives/[id] sayfasına
// gider — bu, kapsam dışı, dokunulmadı.
function entityHref(approval: {
  entityType: string;
  entityId: string;
  taskId: string | null;
  projectId: string;
}): string | null {
  switch (approval.entityType) {
    case "Creative":
      return `/creatives/${approval.entityId}`;
    case "Task":
      return buildHubHref(approval.projectId, {
        panel: "isler",
        sub: "gorevler",
        entity: { kind: "task", id: approval.entityId },
      });
    case "WorkPlan":
      return buildHubHref(approval.projectId, {
        panel: "isler",
        sub: "planlar",
        entity: { kind: "workPlan", id: approval.entityId },
      });
    case "ProjectGoal":
      return buildHubHref(approval.projectId, { panel: "hedefler" });
    case "WorkHandoff":
      return buildHubHref(approval.projectId, {
        panel: "isler",
        sub: "devirler",
      });
    default:
      return approval.taskId
        ? buildHubHref(approval.projectId, {
            panel: "isler",
            sub: "gorevler",
            entity: { kind: "task", id: approval.taskId },
          })
        : null;
  }
}

// Eskiden /approvals (workspace geneli, proje bağlamının DIŞINDA, ayrı bir
// sayfa) altında yaşayan Onay Merkezi — artık her projenin kendi Araçlar
// menüsünden açılan bir panel (bkz. hub-core-params.ts PANEL_KEYS). Karar
// vermek için proje bağlamından hiç çıkılmıyor; proje adı/seçici artık
// gereksiz çünkü zaten o projenin içindeyiz.
export async function OnaylarPanel({ projectId }: PanelProps) {
  const approvals = await prisma.approval.findMany({
    where: { projectId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-3">
      {approvals.map((approval) => {
        const href = entityHref({ ...approval, projectId });
        const entityLabel =
          ENTITY_LABELS[approval.entityType] ?? approval.entityType;
        return (
          <Card key={approval.id} className="transition-shadow hover:shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">
                {href ? (
                  <Link href={href} className="hover:underline">
                    {entityLabel}
                  </Link>
                ) : (
                  entityLabel
                )}
              </CardTitle>
              <div className="flex items-center gap-1.5">
                {approval.level ? (
                  <StatusBadge meta={APPROVAL_LEVEL[approval.level]} />
                ) : null}
                <StatusBadge
                  meta={APPROVAL_TYPE[approval.type]}
                  fallback={approval.type}
                />
              </div>
            </CardHeader>
            <CardContent className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {approval.requestedByType === "USER"
                  ? "Kullanıcı"
                  : approval.requestedByType === "SYSTEM"
                    ? "Sistem"
                    : "Ajan"}{" "}
                talep etti · {timeAgo(approval.createdAt)}
              </p>
              <div className="flex gap-2">
                <ActionForm
                  action={rejectApprovalAction}
                  successMessage="Onay reddedildi"
                >
                  <input type="hidden" name="approvalId" value={approval.id} />
                  <SubmitButton variant="outline" size="sm">
                    Reddet
                  </SubmitButton>
                </ActionForm>
                <ActionForm
                  action={approveApprovalAction}
                  successMessage="Onaylandı"
                >
                  <input type="hidden" name="approvalId" value={approval.id} />
                  <SubmitButton size="sm">Onayla</SubmitButton>
                </ActionForm>
              </div>
            </CardContent>
          </Card>
        );
      })}

      {approvals.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title="Onay bekleyen işlem yok"
          hint="Ajans onay gerektiren bir iş hazırladığında burada görünür."
        />
      ) : null}
    </div>
  );
}
