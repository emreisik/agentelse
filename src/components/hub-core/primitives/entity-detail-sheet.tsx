"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

// Kanban kartlarına tıklanınca artık pano bir detay sayfasıyla YER
// DEĞİŞTİRMİYOR — pano arkada canlı kalıyor, detay sağdan açılan %50
// genişlikte bir panelde üstüne biniyor. Kapatma (X / dışına tıkla / Esc)
// `closeHref`e (entity=null) navigate ederek olur; bu component sadece
// `entity` URL'de doluyken mount edildiği için `open` hep true.
export function EntityDetailSheet({
  title,
  closeHref,
  children,
}: {
  title: string;
  closeHref: string;
  children: ReactNode;
}) {
  const router = useRouter();

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) router.push(closeHref, { scroll: false });
      }}
    >
      <SheetContent
        showCloseButton
        className="w-1/2 gap-0 overflow-y-auto p-6 data-[side=right]:w-1/2 data-[side=right]:sm:max-w-none"
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  );
}
