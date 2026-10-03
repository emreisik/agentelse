"use client";

import { useState, useTransition } from "react";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  approveApprovalAction,
  rejectApprovalAction,
} from "@/server/actions/approval-actions";

// Bekleyen onayı panelin altından karara bağlar. ActionForm yerine doğrudan
// çağrı: ActionForm başarıda sayfayı yeniden render ettirir (router.refresh),
// burada ise pano yalnız hafif takvim verisini yeniden okur (onDone).
// `approvalId` null iken (ayrıntı henüz yükleniyor) düğmeler pasif görünür.
export function DecisionButtons({
  approvalId,
  onDone,
}: {
  approvalId: string | null;
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [choice, setChoice] = useState<"approve" | "reject" | null>(null);

  function decide(kind: "approve" | "reject") {
    if (!approvalId) return;
    setChoice(kind);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("approvalId", approvalId);
      const action = kind === "approve" ? approveApprovalAction : rejectApprovalAction;
      const result = await action(formData);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(kind === "approve" ? "Approved" : "Rejected");
      onDone();
    });
  }

  const disabled = pending || !approvalId;
  return (
    <div className="flex gap-2">
      <Button
        type="button"
        variant="outline"
        className="flex-1"
        disabled={disabled}
        onClick={() => decide("reject")}
      >
        {pending && choice === "reject" ? (
          <LoaderCircle className="animate-spin" aria-hidden />
        ) : null}
        Reject
      </Button>
      <Button
        type="button"
        className="flex-1"
        disabled={disabled}
        onClick={() => decide("approve")}
      >
        {pending && choice === "approve" ? (
          <LoaderCircle className="animate-spin" aria-hidden />
        ) : null}
        Approve
      </Button>
    </div>
  );
}
