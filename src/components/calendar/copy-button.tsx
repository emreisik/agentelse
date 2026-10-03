"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

// Metni panoya kopyalar (yayın yapacak kişi başka yere yapıştırır).
export function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => toast.success(`${label} copied`),
          () => toast.error("Couldn't copy. Select the text instead."),
        );
      }}
    >
      <Copy aria-hidden />
      Copy
    </Button>
  );
}
