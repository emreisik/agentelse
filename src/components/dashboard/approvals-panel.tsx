import Link from "next/link";
import type { Approval } from "@prisma/client";

import { timeAgo } from "@/lib/dates";
import { APPROVAL_LEVEL, APPROVAL_TYPE } from "@/lib/labels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ActionForm } from "@/components/shared/action-form";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import {
  approveApprovalAction,
  rejectApprovalAction,
} from "@/server/actions/approval-actions";

export function ApprovalsPanel({
  approvals,
  projectNameById,
}: {
  approvals: Approval[];
  projectNameById: Map<string, string>;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">
          Onaylar
          {approvals.length > 0 ? (
            <Badge variant="outline" className="ml-2 align-middle">
              {approvals.length} bekliyor
            </Badge>
          ) : null}
        </CardTitle>
        <Link
          href="/approvals"
          className="text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          Tümünü gör
        </Link>
      </CardHeader>
      <CardContent className="space-y-3">
        {approvals.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Onay bekleyen işlem yok.
          </p>
        ) : (
          approvals.map((approval) => (
            <div
              key={approval.id}
              className="space-y-2 rounded-lg border border-border p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">
                  {projectNameById.get(approval.projectId) ??
                    "Bilinmeyen proje"}{" "}
                  — {approval.entityType}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  {approval.level ? (
                    <StatusBadge
                      meta={APPROVAL_LEVEL[approval.level]}
                      className="h-4 px-1.5 text-[10px]"
                    />
                  ) : null}
                  <StatusBadge
                    meta={APPROVAL_TYPE[approval.type]}
                    fallback={approval.type}
                    className="h-4 px-1.5 text-[10px]"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
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
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
