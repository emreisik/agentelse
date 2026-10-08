"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { clearLayoutTemplatesAction } from "@/server/actions/brand-layout-actions";

// Shown instead of the gallery when the brand has its own saved layouts: they
// win over the designs, and this is the way back.
export function CustomLayoutsNotice({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function reset() {
    startTransition(async () => {
      const result = await clearLayoutTemplatesAction(projectId);
      if (result.ok) {
        toast.success("Posts follow the designs again");
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <div className="space-y-3 rounded-xl border border-dashed p-4">
      <p className="text-sm">
        This brand has its own custom layouts saved, and posts use them instead
        of the designs below.
      </p>
      <Button type="button" variant="outline" size="sm" onClick={reset} disabled={pending}>
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
        Use the post designs instead
      </Button>
    </div>
  );
}
