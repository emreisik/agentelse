"use client";

import { useState, useTransition } from "react";
import { Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";

import type { ActionResult } from "@/components/shared/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";

export type BrandDossierEditable = {
  summary: string | null;
  positioning: string | null;
  toneOfVoice: string | null;
  language: string | null;
  country: string | null;
  targetAudiences: unknown;
  markets: unknown;
  products: unknown;
  services: unknown;
  visualGuidelines: unknown;
};

function toJsonText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

// Edit form for the "Brand Dossier" card — the same interaction pattern
// as goal-edit-dialog.tsx (controlled open/closed state, server action
// call via onSubmit+useTransition, toast + close on success), but a Sheet
// instead of a Dialog because of the number of fields: the title/subtitle
// stay fixed while the fields scroll within their own area.
export function BrandDossierEditSheet({
  projectId,
  dossier,
  action,
}: {
  projectId: string;
  dossier: BrandDossierEditable;
  action: (formData: FormData) => Promise<ActionResult>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await action(formData);
      if (result.ok) {
        toast.success("Brand dossier updated");
        setOpen(false);
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setOpen(true)}
        aria-label="Edit brand dossier"
      >
        <Pencil className="size-3.5" />
      </Button>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="shrink-0 border-b border-foreground/10">
          <SheetTitle>Edit Brand Dossier</SheetTitle>
          <SheetDescription>
            This information flows as context into all of the brand&apos;s
            output.
          </SheetDescription>
        </SheetHeader>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <input type="hidden" name="projectId" value={projectId} />
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
            <div className="space-y-1.5">
              <Label htmlFor="dossier-summary">Summary</Label>
              <Textarea
                id="dossier-summary"
                name="summary"
                defaultValue={dossier.summary ?? ""}
                rows={3}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dossier-positioning">Positioning</Label>
              <Textarea
                id="dossier-positioning"
                name="positioning"
                defaultValue={dossier.positioning ?? ""}
                rows={3}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dossier-tone">Tone of Voice</Label>
              <Textarea
                id="dossier-tone"
                name="toneOfVoice"
                defaultValue={dossier.toneOfVoice ?? ""}
                rows={2}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="dossier-language">Language</Label>
                <Input
                  id="dossier-language"
                  name="language"
                  defaultValue={dossier.language ?? ""}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dossier-country">Country</Label>
                <Input
                  id="dossier-country"
                  name="country"
                  defaultValue={dossier.country ?? ""}
                />
              </div>
            </div>

            <div className="space-y-1 border-t border-border/60 pt-4">
              <p className="text-xs font-medium text-foreground">
                Structured data (JSON)
              </p>
              <p className="text-[11px] text-muted-foreground">
                Each field must be valid JSON. Leave empty to clear it.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dossier-audiences">Target Audiences</Label>
              <Textarea
                id="dossier-audiences"
                name="targetAudiences"
                defaultValue={toJsonText(dossier.targetAudiences)}
                rows={4}
                className="font-mono text-xs"
                placeholder='[{"label": "Primary", "description": "18-34 urban professionals"}]'
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dossier-markets">Markets</Label>
              <Textarea
                id="dossier-markets"
                name="markets"
                defaultValue={toJsonText(dossier.markets)}
                rows={3}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dossier-products">Products</Label>
              <Textarea
                id="dossier-products"
                name="products"
                defaultValue={toJsonText(dossier.products)}
                rows={4}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dossier-services">Services</Label>
              <Textarea
                id="dossier-services"
                name="services"
                defaultValue={toJsonText(dossier.services)}
                rows={4}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dossier-visual">Visual Guidelines</Label>
              <Textarea
                id="dossier-visual"
                name="visualGuidelines"
                defaultValue={toJsonText(dossier.visualGuidelines)}
                rows={4}
                className="font-mono text-xs"
              />
            </div>
          </div>
          <SheetFooter className="shrink-0 flex-row justify-end gap-2 border-t border-foreground/10">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Save
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
