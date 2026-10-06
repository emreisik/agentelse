"use client";

import { useTransition } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { markCreativePublishedAction } from "@/server/actions/plan-progress-actions";

// Elle paylaşılan (Reel, carousel, blog yazısı...) onaylı bir parçayı "paylaştım"
// diye işaretler; parça diğer tüm yayınlar gibi aynı durum makinesinden geçer.
export function MarkPostedButton({
  creativeId,
  className,
  onDone,
}: {
  creativeId: string;
  className?: string;
  // Başarıdan sonra: pano taze durumu okusun.
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      size="sm"
      className={className}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await markCreativePublishedAction(creativeId);
          if (!result.ok) {
            toast.error(result.message);
            return;
          }
          toast.success("Marked as posted by you");
          onDone();
        })
      }
    >
      {pending ? (
        <LoaderCircle className="animate-spin" aria-hidden />
      ) : (
        <Check aria-hidden />
      )}
      I posted it myself
    </Button>
  );
}
