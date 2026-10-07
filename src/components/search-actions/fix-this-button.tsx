"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import { fixOpportunity } from "@/server/actions/seo-action-actions";
import type { FixThisState } from "@/server/seo/actions/fix-this";

// Fırsat satırındaki "Fix this" düğmesi (SC-F6, docs/search-actions.md):
// eylem varsa "Open fix · <durum>" bağı, yoksa eylemi kurup SEO Manager Work'üne
// (ya da Actions & results kontrol listesine) götüren düğme. İstemci yalnız
// tipleri ve sunucu eylemini içe aktarır.

export function FixThisButton({
  projectId,
  findingId,
  existing,
}: {
  projectId: string;
  findingId: string;
  existing: FixThisState | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (existing) {
    return (
      <Link
        href={existing.href}
        className={buttonVariants({ variant: "outline", size: "xs" })}
      >
        {`Open fix · ${existing.statusLabel}`}
      </Link>
    );
  }

  return (
    <Button
      type="button"
      size="xs"
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          try {
            const result = await fixOpportunity(projectId, findingId);
            if (result.ok) {
              router.push(result.href);
            } else {
              toast.error(result.message);
            }
          } catch {
            toast.error("We couldn't start this fix. Try again.");
          }
        });
      }}
    >
      {pending ? <Loader2 className="size-3 animate-spin" /> : null}
      Fix this
    </Button>
  );
}
