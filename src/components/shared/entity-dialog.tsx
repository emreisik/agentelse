"use client";

import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const SIZE_CLASSES = {
  md: "max-h-[85vh] w-full max-w-2xl rounded-xl sm:max-w-2xl",
  // Large centered modal (not edge-to-edge) — for views dense enough to
  // work like a dedicated page rather than a small floating dialog (e.g.
  // the pipeline board's detail workspace), but still reading as a modal:
  // rounded corners, blurred backdrop visible on all four sides. Keeps the
  // base DialogContent's default centering (top-1/2/left-1/2/-translate),
  // just widens/heightens it.
  // `sm:max-w-[50vw]` is required alongside the bare `max-w-[50vw]`: the
  // base DialogContent's default `sm:max-w-sm` is a different
  // tailwind-merge variant group, so an unprefixed override alone doesn't
  // cancel it — the dialog otherwise gets capped at 24rem.
  full: "h-[90dvh] max-h-[90dvh] w-[50vw] max-w-[50vw] sm:max-w-[50vw] rounded-2xl",
};

// Centered detail modal driven by a searchParam — same close-by-navigation
// contract as EntitySheet, but for views with enough nested detail (e.g.
// the pipeline board) that a side sheet reads too cramped.
//
// `header` lets a caller swap the default boxed title/description block for
// a custom toolbar (e.g. a breadcrumb) — the visible title moves into the
// caller's own content in that case, but `title` is still rendered as an
// sr-only DialogTitle so the dialog stays accessible.
export function EntityDialog({
  closeHref,
  title,
  description,
  header,
  size = "md",
  bodyClassName = "space-y-4 overflow-y-auto p-4",
  children,
}: {
  closeHref: string;
  title: string;
  description?: string;
  header?: React.ReactNode;
  size?: "md" | "full";
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) router.push(closeHref, { scroll: false });
      }}
    >
      <DialogContent
        className={cn(
          "flex flex-col gap-0 overflow-hidden p-0",
          SIZE_CLASSES[size],
        )}
      >
        {header ? (
          <>
            <DialogTitle className="sr-only">{title}</DialogTitle>
            <div className="flex shrink-0 items-center gap-2 border-b border-foreground/10 px-4 py-3 pr-14 md:px-6">
              {header}
            </div>
          </>
        ) : (
          <DialogHeader className="shrink-0 border-b border-foreground/10 p-4 md:p-6">
            <DialogTitle className="pr-8 text-base md:text-lg">
              {title}
            </DialogTitle>
            {description ? (
              <DialogDescription className="text-xs">
                {description}
              </DialogDescription>
            ) : null}
          </DialogHeader>
        )}
        <div className={bodyClassName}>{children}</div>
      </DialogContent>
    </Dialog>
  );
}
