import { UserRoundCog } from "lucide-react";

import { prisma } from "@/lib/prisma";
import { timeAgo } from "@/lib/dates";
import { HUMAN_INTERVENTION_TYPE } from "@/lib/labels";
import {
  requireUser,
  requireWorkspaceMembership,
} from "@/server/security/tenant-context";
import {
  cancelHumanActionAction,
  resolveHumanActionAction,
} from "@/server/actions/human-action-actions";
import { AppShell } from "@/components/layout/app-shell";
import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export default async function HumanActionsPage() {
  const { userId } = await requireUser();
  const { workspaceId } = await requireWorkspaceMembership(userId);

  const requests = await prisma.humanInterventionRequest.findMany({
    where: { workspaceId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });

  const projects = await prisma.project.findMany({
    where: { id: { in: requests.map((request) => request.projectId) } },
  });
  const projectNameById = new Map(
    projects.map((project) => [project.id, project.name]),
  );

  return (
    <AppShell>
      <div className="space-y-4 p-6">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Human Action Center
          </h1>
          <p className="text-sm text-muted-foreground">
            OTP, MFA, CAPTCHA, and manual browser requests wait here for a human
            response.
          </p>
        </div>

        <div className="space-y-3">
          {requests.map((request) => (
            <Card
              key={request.id}
              className="transition-shadow hover:shadow-sm"
            >
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">
                  {projectNameById.get(request.projectId) ?? "Unknown project"}{" "}
                  — {request.title}
                </CardTitle>
                <StatusBadge
                  meta={HUMAN_INTERVENTION_TYPE[request.type]}
                  fallback={request.type}
                />
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  {request.message}
                </p>
                <p className="text-xs text-muted-foreground">
                  {timeAgo(request.createdAt)}
                  {request.expiresAt
                    ? ` · Expires: ${timeAgo(request.expiresAt)}`
                    : ""}
                </p>

                {request.inputType === "MANUAL_BROWSER" ? (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled
                      title="Remote browser session connection is not yet available"
                    >
                      Open Browser
                    </Button>
                    <ActionForm
                      action={cancelHumanActionAction}
                      successMessage="Task cancelled"
                    >
                      <input
                        type="hidden"
                        name="requestId"
                        value={request.id}
                      />
                      <SubmitButton variant="ghost" size="sm">
                        Cancel Task
                      </SubmitButton>
                    </ActionForm>
                  </div>
                ) : (
                  <ActionForm
                    action={resolveHumanActionAction}
                    successMessage="Response sent"
                    className="flex items-center gap-2"
                  >
                    <input type="hidden" name="requestId" value={request.id} />
                    <Input
                      name="value"
                      placeholder={
                        request.inputType === "OTP"
                          ? "Enter code"
                          : "Enter value"
                      }
                      className="max-w-48"
                    />
                    <SubmitButton size="sm">Send</SubmitButton>
                  </ActionForm>
                )}
              </CardContent>
            </Card>
          ))}

          {requests.length === 0 ? (
            <EmptyState
              icon={UserRoundCog}
              title="No pending human actions"
              hint="Appears here when agents need a verification code or manual intervention."
            />
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}
