"use client";

import type { ReactNode } from "react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// Shows the clicked image in an enlarged modal without leaving the page,
// instead of opening it in a new tab (the old `target="_blank"` behavior) —
// same visual language as AttachmentPreviewDialog in attachment.tsx (same
// Dialog + close-button style), moved here to be shared from a single
// place. `children` carries the thumbnail/trigger; inside the modal `src`
// is shown at full size.
export function ImageLightbox({
  src,
  alt,
  title,
  className,
  children,
}: {
  src: string;
  alt: string;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Dialog>
      <DialogTrigger className={cn("cursor-zoom-in", className)}>
        {children}
      </DialogTrigger>
      <DialogContent className="[&>button]:bg-foreground/60 [&>button]:hover:bg-foreground/80 [&_svg]:text-background p-2 sm:max-w-3xl [&>button]:rounded-full [&>button]:p-1 [&>button]:opacity-100 [&>button]:ring-0!">
        <DialogTitle className="sr-only">{title ?? alt}</DialogTitle>
        <div className="bg-background relative mx-auto flex max-h-[80dvh] w-full items-center justify-center overflow-hidden rounded-sm">
          {/* eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id> or blob:, next/image can't optimize it */}
          <img
            src={src}
            alt={alt}
            className="block h-auto max-h-[80vh] w-auto max-w-full rounded-sm object-contain"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
