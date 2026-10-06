"use client";

import { useState } from "react";

import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import {
  acceptOpportunityAction,
  dismissOpportunityAction,
} from "@/server/actions/search-opportunity-actions";

// Rapordaki fırsat ve yol haritası satırları için Accept / Dismiss (SC-F4
// eylemleri). Durum, rapor anlık görüntüsünden değil okuma anındaki CANLI
// bulgudan gelir; yalnız OPEN bulgu karar bekler. Hook yok: ActionForm kendi
// durumunu taşır. Dismiss nedeni isteğe bağlıdır, burada gönderilmez.
// Sohbet kartı raporu bir kez yükler (router.refresh onu yeniden çekmez):
// başarıdan sonra karar yerel durumda tutulur ve düğmeler tekrar çizilmez.

function Hidden({
  projectId,
  findingId,
}: {
  projectId: string;
  findingId: string;
}) {
  return (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="findingId" value={findingId} />
    </>
  );
}

export function FindingDecision({
  projectId,
  findingId,
  status,
}: {
  projectId: string;
  findingId: string;
  status: string | null;
}) {
  const [decided, setDecided] = useState<"Accepted" | "Dismissed" | null>(
    null,
  );
  if (status !== "OPEN") return null;
  if (decided) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {decided}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1" data-finding={findingId}>
      <ActionForm
        action={acceptOpportunityAction}
        successMessage="Accepted"
        onSuccess={() => setDecided("Accepted")}
        className="flex"
      >
        <Hidden projectId={projectId} findingId={findingId} />
        <SubmitButton size="xs" variant="outline">
          Accept
        </SubmitButton>
      </ActionForm>
      <ActionForm
        action={dismissOpportunityAction}
        successMessage="Dismissed"
        onSuccess={() => setDecided("Dismissed")}
        className="flex"
      >
        <Hidden projectId={projectId} findingId={findingId} />
        <SubmitButton size="xs" variant="ghost">
          Dismiss
        </SubmitButton>
      </ActionForm>
    </div>
  );
}
