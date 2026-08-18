"use client";

import { useRouter } from "next/navigation";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

// Server-rendered detail sheet driven by a searchParam: the page renders
// this only when the param is present; closing navigates back to the list
// URL (RSC re-render drops the sheet).
export function EntitySheet({
  closeHref,
  title,
  description,
  children,
}: {
  closeHref: string;
  title: string;
  description?: string;
  children: React.ReactNode;
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
        side="right"
        className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl"
      >
        <SheetHeader className="border-b border-foreground/10 p-4">
          <SheetTitle className="pr-8 text-base">{title}</SheetTitle>
          {description ? (
            <SheetDescription className="text-xs">
              {description}
            </SheetDescription>
          ) : null}
        </SheetHeader>
        <div className="space-y-4 p-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
