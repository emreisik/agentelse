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

// "Marka Dosyası" kartının düzenle formu — goal-edit-dialog.tsx ile aynı
// etkileşim deseni (kontrollü açık/kapalı state, onSubmit+useTransition ile
// server action çağrısı, başarıda toast + kapan) ama alan sayısı fazla
// olduğu için Dialog yerine Sheet: başlık/alt bilgi sabit kalıyor, alanlar
// kendi içinde kaydırılıyor.
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
        toast.success("Marka dosyası güncellendi");
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
        aria-label="Marka dosyasını düzenle"
      >
        <Pencil className="size-3.5" />
      </Button>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="shrink-0 border-b border-foreground/10">
          <SheetTitle>Marka Dosyasını Düzenle</SheetTitle>
          <SheetDescription>
            Bu bilgiler markanın tüm üretimlerine bağlam olarak akar.
          </SheetDescription>
        </SheetHeader>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <input type="hidden" name="projectId" value={projectId} />
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
            <div className="space-y-1.5">
              <Label htmlFor="dossier-summary">Özet</Label>
              <Textarea
                id="dossier-summary"
                name="summary"
                defaultValue={dossier.summary ?? ""}
                rows={3}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dossier-positioning">Konumlandırma</Label>
              <Textarea
                id="dossier-positioning"
                name="positioning"
                defaultValue={dossier.positioning ?? ""}
                rows={3}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dossier-tone">Ses Tonu</Label>
              <Textarea
                id="dossier-tone"
                name="toneOfVoice"
                defaultValue={dossier.toneOfVoice ?? ""}
                rows={2}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="dossier-language">Dil</Label>
                <Input
                  id="dossier-language"
                  name="language"
                  defaultValue={dossier.language ?? ""}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dossier-country">Ülke</Label>
                <Input
                  id="dossier-country"
                  name="country"
                  defaultValue={dossier.country ?? ""}
                />
              </div>
            </div>

            <div className="space-y-1 border-t border-border/60 pt-4">
              <p className="text-xs font-medium text-foreground">
                Yapılandırılmış veri (JSON)
              </p>
              <p className="text-[11px] text-muted-foreground">
                Her alan geçerli JSON olmalı. Boş bırakılırsa temizlenir.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dossier-audiences">Hedef Kitleler</Label>
              <Textarea
                id="dossier-audiences"
                name="targetAudiences"
                defaultValue={toJsonText(dossier.targetAudiences)}
                rows={4}
                className="font-mono text-xs"
                placeholder='[{"label": "Birincil", "description": "18-34 şehirli profesyoneller"}]'
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dossier-markets">Pazarlar</Label>
              <Textarea
                id="dossier-markets"
                name="markets"
                defaultValue={toJsonText(dossier.markets)}
                rows={3}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dossier-products">Ürünler</Label>
              <Textarea
                id="dossier-products"
                name="products"
                defaultValue={toJsonText(dossier.products)}
                rows={4}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dossier-services">Hizmetler</Label>
              <Textarea
                id="dossier-services"
                name="services"
                defaultValue={toJsonText(dossier.services)}
                rows={4}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dossier-visual">Görsel Kurallar</Label>
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
              Vazgeç
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Kaydet
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
