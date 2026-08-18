"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

// Clicking a kanban card no longer REPLACES the board with a detail
// page — the board stays alive underneath, and the detail overlays it in
// a 50%-wide panel that opens from the right. Closing (X / click outside /
// Esc) happens by navigating to `closeHref` (entity=null); since this
// component is only mounted while `entity` is present in the URL, `open`
// is always true.
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
