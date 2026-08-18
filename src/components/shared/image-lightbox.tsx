"use client";

import type { ReactNode } from "react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// Tıklanan görseli yeni sekmede açmak yerine (eski `target="_blank"`
// davranışı) sayfadan hiç ayrılmadan büyütülmüş bir modalda gösterir —
// attachment.tsx'teki AttachmentPreviewDialog ile aynı görsel dil (aynı
// Dialog + close-button stili), tek yerden paylaşılsın diye buraya taşındı.
// `children` küçük resmi/tetikleyiciyi taşır; modal içinde `src` tam
// boyutuyla gösterilir.
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
          {/* eslint-disable-next-line @next/next/no-img-element -- kaynak /api/assets/<id> ya da blob:, next/image optimize edemez */}
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
