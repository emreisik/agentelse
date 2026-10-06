"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import type { ActionResult } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import {
  acceptGaFindingAction,
  dismissGaFindingAction,
  loadOpenGaFindingIdsAction,
} from "@/server/actions/website-insights-actions";

// Rapor kartındaki bulgu için Accept / Dismiss (GA-F4'ün eylemleri). ActionForm
// başarıdan sonra düğmeleri geri getirir (router.refresh kartı yeniden
// çizer ama saklı kart değişmez); bu yüzden kendi küçük formu var: başarıdan
// sonra yerel "Saved" / "Dismissed" durumu düğmelerin yerini alır.
// Saklı kart bulgunun gönderim anındaki durumunu taşır; bulgu sonradan karara
// bağlanmış ya da haftalık taramada SUPERSEDED olmuş olabilir. Bu yüzden
// düğmeler yalnız bulgunun ŞİMDİKİ durumu OPEN ise çizilir (ilk çizimde ve
// denetim başarısız olursa gizli kalır: yanlış düğme göstermektense yok).

type ServerAction = (formData: FormData) => Promise<ActionResult | void>;

function useDecision(action: ServerAction) {
  return useActionState(
    async (_prev: ActionResult | null, formData: FormData) => {
      try {
        return (await action(formData)) ?? ({ ok: true } as const);
      } catch {
        return { ok: false, message: "Action failed" } as const;
      }
    },
    null,
  );
}

export function FindingDecisionButtons(props: {
  projectId: string;
  findingId: string;
  title: string;
}) {
  const { projectId, findingId } = props;
  const [live, setLive] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadOpenGaFindingIdsAction(projectId, [findingId])
      .then((ids) => {
        if (!cancelled) setLive(ids.includes(findingId));
      })
      .catch(() => {
        if (!cancelled) setLive(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, findingId]);
  if (!live) return null;
  return <DecisionForms {...props} />;
}

export function DecisionForms({
  projectId,
  findingId,
  title,
}: {
  projectId: string;
  findingId: string;
  title: string;
}) {
  const router = useRouter();
  const [accepted, acceptForm] = useDecision(acceptGaFindingAction);
  const [dismissed, dismissForm] = useDecision(dismissGaFindingAction);

  const decided = accepted?.ok ? "Saved" : dismissed?.ok ? "Dismissed" : null;
  useEffect(() => {
    if (!decided) return;
    toast.success(decided === "Saved" ? "Accepted" : "Dismissed");
    router.refresh();
  }, [decided, router]);

  if (decided) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {decided}
      </p>
    );
  }

  const error =
    accepted && !accepted.ok
      ? accepted.message
      : dismissed && !dismissed.ok
        ? dismissed.message
        : null;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <form action={acceptForm}>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="findingId" value={findingId} />
          <SubmitButton
            variant="outline"
            size="xs"
            aria-label={`Accept: ${title}`}
          >
            Accept
          </SubmitButton>
        </form>
        <form action={dismissForm}>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="findingId" value={findingId} />
          <SubmitButton
            variant="ghost"
            size="xs"
            aria-label={`Dismiss: ${title}`}
          >
            Dismiss
          </SubmitButton>
        </form>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
