"use client";

import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function ProjectError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="flex size-10 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
        <AlertTriangle className="size-5" />
      </span>
      <p className="text-sm font-medium">Bir şeyler ters gitti</p>
      <p className="max-w-sm text-xs text-muted-foreground">
        Sayfa yüklenirken beklenmeyen bir hata oluştu. Tekrar deneyin; sorun
        sürerse ajans motoru çalışırken kısa süreli bir tutarsızlık olabilir.
      </p>
      <Button variant="outline" size="sm" onClick={reset}>
        Tekrar dene
      </Button>
    </div>
  );
}
