"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { SuggestDossierResult } from "@/server/actions/brand-dossier-actions";

const FIELD_LABEL: Record<string, string> = {
  summary: "Summary",
  positioning: "Positioning",
  services: "Services",
  products: "Products",
  markets: "Markets",
  visualGuidelines: "Visual guidelines",
};

// Fills the empty Brand Dossier fields with AI suggestions. The suggestions are
// a starting point, not verified facts: the toast says so, and the card keeps a
// note until the dossier is edited.
export function BrandDossierSuggestButton({
  projectId,
  action,
}: {
  projectId: string;
  action: (projectId: string) => Promise<SuggestDossierResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onClick() {
    startTransition(async () => {
      const result = await action(projectId);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      switch (result.status) {
        case "FILLED":
          toast.success(
            `Filled: ${result.filled.map((field) => FIELD_LABEL[field] ?? field).join(", ")}. Review and edit them anytime.`,
          );
          router.refresh();
          break;
        case "NOTHING_TO_FILL":
          toast.info("Every field already has a value, nothing to suggest.");
          break;
        case "SKIPPED":
          toast.error("AI suggestions are unavailable right now.");
          break;
        default:
          toast.error("Couldn't get suggestions. Try again in a minute.");
      }
    });
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={pending}
      title="Fill the empty fields with AI suggestions"
    >
      {pending ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Sparkles className="size-3.5" aria-hidden="true" />
      )}
      {pending ? "Suggesting…" : "Suggest with AI"}
    </Button>
  );
}
