import Link from "next/link";
import { ClipboardCheck } from "lucide-react";

import { prisma } from "@/lib/prisma";
import { timeAgo } from "@/lib/dates";
import { APPROVAL_LEVEL, APPROVAL_TYPE } from "@/lib/labels";
import {
  requireUser,
  requireWorkspaceMembership,
} from "@/server/security/tenant-context";
import {
  approveApprovalAction,
  rejectApprovalAction,
} from "@/server/actions/approval-actions";
import { AppShell } from "@/components/layout/app-shell";
import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const ENTITY_LABELS: Record<string, string> = {
  Task: "Task",
  Creative: "Creative",
  WorkPlan: "Work Plan",
  ProjectGoal: "Goal",
  WorkHandoff: "Handoff",
};

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
      return `/projects/${approval.projectId}?panel=isler&sub=gorevler&entity=task:${approval.entityId}`;
    case "WorkPlan":
      return `/projects/${approval.projectId}?panel=isler&sub=planlar&entity=workPlan:${approval.entityId}`;
    case "ProjectGoal":
      return `/projects/${approval.projectId}?panel=hedefler`;
    case "WorkHandoff":
      return `/projects/${approval.projectId}?panel=isler&sub=devirler`;
    default:
      return approval.taskId
        ? `/projects/${approval.projectId}?panel=isler&sub=gorevler&entity=task:${approval.taskId}`
        : null;
  }
}

export default async function ApprovalsPage({
  searchParams,
}: PageProps<"/approvals">) {
  const { userId } = await requireUser();
  const { workspaceId } = await requireWorkspaceMembership(userId);
  const { projectId } = await searchParams;

  const approvals = await prisma.approval.findMany({
    where: {
      workspaceId,
      status: "PENDING",
      projectId: typeof projectId === "string" ? projectId : undefined,
    },
    orderBy: { createdAt: "desc" },
  });

  const projects = await prisma.project.findMany({
    where: { id: { in: approvals.map((approval) => approval.projectId) } },
  });
  const projectNameById = new Map(
    projects.map((project) => [project.id, project.name]),
  );

  return (
    <AppShell>
      <div className="space-y-4 p-6">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Approval Center
          </h1>
          <p className="text-sm text-muted-foreground">
            Publishing, campaign, and account actions never run without approval
            from here.
          </p>
        </div>

        <div className="space-y-3">
          {approvals.map((approval) => {
            const href = entityHref(approval);
            const entityLabel =
              ENTITY_LABELS[approval.entityType] ?? approval.entityType;
            return (
              <Card
                key={approval.id}
                className="transition-shadow hover:shadow-sm"
              >
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                  <CardTitle className="text-base">
                    {projectNameById.get(approval.projectId) ??
                      "Unknown project"}{" "}
                    —{" "}
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
                      ? "User"
                      : approval.requestedByType === "SYSTEM"
                        ? "System"
                        : "Agent"}{" "}
                    requested · {timeAgo(approval.createdAt)}
                  </p>
                  <div className="flex gap-2">
                    <ActionForm
                      action={rejectApprovalAction}
                      successMessage="Approval rejected"
                    >
                      <input
                        type="hidden"
                        name="approvalId"
                        value={approval.id}
                      />
                      <SubmitButton variant="outline" size="sm">
                        Reject
                      </SubmitButton>
                    </ActionForm>
                    <ActionForm
                      action={approveApprovalAction}
                      successMessage="Approved"
                    >
                      <input
                        type="hidden"
                        name="approvalId"
                        value={approval.id}
                      />
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
              title="No approvals pending"
              hint="Appears here when the agency prepares work that requires approval."
            />
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}
