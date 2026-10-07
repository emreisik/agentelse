"use client";

import { Printer } from "lucide-react";

import { Button } from "@/components/ui/button";

// Yönetici yazdırma sayfasında "Print / Save as PDF": tarayıcının yazdırma
// iletişim kutusunu açar. Yazdırılan çıktıda görünmez.
export function PrintButton() {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="print:hidden"
      onClick={() => window.print()}
    >
      <Printer className="size-4" />
      Print / Save as PDF
    </Button>
  );
}
