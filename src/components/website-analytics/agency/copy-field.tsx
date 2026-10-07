"use client";

import { useState } from "react";
import { toast } from "sonner";

import { copyToClipboard } from "@/components/module-flows/analytics/share";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Salt okunur alan + "Copy" düğmesi (müşteri bağlantısı adresi için). Kopyalama
// başarısızsa alan seçilebilir kalır.

export function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      toast.success("Copied");
    } else {
      toast.error("Could not copy");
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Input
        readOnly
        value={value}
        aria-label="Client link"
        onFocus={(event) => event.currentTarget.select()}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void copy()}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
