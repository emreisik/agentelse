import { UserRoundCog } from "lucide-react";

import { prisma } from "@/lib/prisma";
import { timeAgo } from "@/lib/dates";
import { HUMAN_INTERVENTION_TYPE } from "@/lib/labels";
import {
  cancelHumanActionAction,
  resolveHumanActionAction,
} from "@/server/actions/human-action-actions";
import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { PanelProps } from "./panel-props";

// Formerly lived under /human-actions (a workspace-wide page OUTSIDE the
// project context, with no projectId filter at all) as the Human Action
// Center — now a panel opened from each project's own Tools menu, showing
// ONLY that project's pending requests.
export async function HumanActionPanel({ projectId }: PanelProps) {
  const requests = await prisma.humanInterventionRequest.findMany({
    where: { projectId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-3">
      {requests.map((request) => (
        <Card key={request.id} className="transition-shadow hover:shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">{request.title}</CardTitle>
            <StatusBadge
              meta={HUMAN_INTERVENTION_TYPE[request.type]}
              fallback={request.type}
            />
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{request.message}</p>
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
                  title="Remote browser session connection not yet available"
                >
                  Open Browser
                </Button>
                <ActionForm
                  action={cancelHumanActionAction}
                  successMessage="Task cancelled"
                >
                  <input type="hidden" name="requestId" value={request.id} />
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
                    request.inputType === "OTP" ? "Enter code" : "Enter value"
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
  );
}
