"use client";

import type { ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";

// Takvim detayı: sağdan açılan modal. Üst (kimlik) ve alt (ana eylem) sabit,
// ortası kaydırılır; uzun metinli bir parçada bile eylemler görünür kalır.
//
// ui/sheet'in SheetContent'i yerine kendi popup'ı: onun arka planı
// `backdrop-blur` kullanır ve altında yüzlerce kartlı bir ızgara varken tarayıcı
// her yeniden boyamada bulanıklığı baştan hesaplar (kaydırma, tarih seçici,
// toast... hepsi takılır). Burada düz yarı saydam zemin ve yalnız `transform`
// geçişi var: ikisi de GPU'da, ızgarayı yeniden boyatmaz.
export function CalendarDetailSheet({
  onClose,
  eyebrow,
  title,
  subline,
  footer,
  children,
}: {
  onClose: () => void;
  // Başlığın üstündeki küçük satır: platform simgesi ve biçim.
  eyebrow: ReactNode;
  title: string;
  // Başlığın altı: durum rozeti ve zaman.
  subline: ReactNode;
  // Sabit alt çubuk (yalnız bir ana eylem varsa).
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/25 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          data-slot="calendar-detail"
          className="fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col border-l border-border bg-popover text-sm text-popover-foreground shadow-xl outline-none transition-transform duration-200 ease-out will-change-transform data-ending-style:translate-x-full data-starting-style:translate-x-full sm:max-w-md"
        >
          <header className="shrink-0 space-y-2 border-b border-border px-4 pt-3.5 pb-3">
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 text-xs font-medium text-muted-foreground">
                {eyebrow}
              </div>
              <SheetClose
                render={
                  <Button variant="ghost" size="icon-sm" className="-mr-1.5" />
                }
              >
                <X aria-hidden />
                <span className="sr-only">Close</span>
              </SheetClose>
            </div>
            <SheetTitle className="line-clamp-2 text-base leading-snug font-semibold">
              {title}
            </SheetTitle>
            <SheetDescription className="sr-only">
              Details and schedule for this piece
            </SheetDescription>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              {subline}
            </div>
          </header>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4">
            {children}
          </div>

          {footer ? (
            <div className="shrink-0 border-t border-border bg-popover p-3">
              {footer}
            </div>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Sheet>
  );
}
