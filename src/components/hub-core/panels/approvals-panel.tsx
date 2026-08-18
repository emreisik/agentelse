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
  Task: "Task",
  Creative: "Creative",
  WorkPlan: "Work Plan",
  ProjectGoal: "Goal",
  WorkHandoff: "Handoff",
};

// Link that takes you to the approved/rejected record's own panel — the
// same mapping that used to live locally in the /approvals page is now
// produced via hub-core's buildHubHref (relative to the project root).
// Creative approvals aren't an "entity kind" of hub-core, they go to their
// own separate /creatives/[id] page — this is out of scope, left untouched.
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
        panel: "work",
        sub: "tasks",
        entity: { kind: "task", id: approval.entityId },
      });
    case "WorkPlan":
      return buildHubHref(approval.projectId, {
        panel: "work",
        sub: "plans",
        entity: { kind: "workPlan", id: approval.entityId },
      });
    case "ProjectGoal":
      return buildHubHref(approval.projectId, { panel: "goals" });
    case "WorkHandoff":
      return buildHubHref(approval.projectId, {
        panel: "work",
        sub: "cycles",
      });
    default:
      return approval.taskId
        ? buildHubHref(approval.projectId, {
            panel: "work",
            sub: "tasks",
            entity: { kind: "task", id: approval.taskId },
          })
        : null;
  }
}

// The Approval Center used to live under /approvals (workspace-wide,
// OUTSIDE the project context, a separate page) — now it's a panel opened
// from each project's own Tools menu (see hub-core-params.ts PANEL_KEYS).
// You never leave the project context to make a decision; the project
// name/selector is no longer needed since we're already inside that
// project.
export async function ApprovalsPanel({ projectId }: PanelProps) {
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
                Requested by{" "}
                {approval.requestedByType === "USER"
                  ? "User"
                  : approval.requestedByType === "SYSTEM"
                    ? "System"
                    : "Agent"}{" "}
                · {timeAgo(approval.createdAt)}
              </p>
              <div className="flex gap-2">
                <ActionForm
                  action={rejectApprovalAction}
                  successMessage="Approval rejected"
                >
                  <input type="hidden" name="approvalId" value={approval.id} />
                  <SubmitButton variant="outline" size="sm">
                    Reject
                  </SubmitButton>
                </ActionForm>
                <ActionForm
                  action={approveApprovalAction}
                  successMessage="Approved"
                >
                  <input type="hidden" name="approvalId" value={approval.id} />
                  <SubmitButton size="sm">Approve</SubmitButton>
                </ActionForm>
              </div>
            </CardContent>
          </Card>
        );
      })}

      {approvals.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title="No pending approvals"
          hint="Appears here when the agency prepares work that requires approval."
        />
      ) : null}
    </div>
  );
}
