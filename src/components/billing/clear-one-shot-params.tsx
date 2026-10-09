"use client";

import { useEffect } from "react";

import { withoutOneShotParams } from "@/lib/billing/one-shot-params";

// Bildirim ekranda gösterildikten sonra tek seferlik parametreleri adres çubuğundan
// siler (bkz. one-shot-params.ts). Ekrandaki bildirim yerinde kalır; yer imi ve yeniden
// yükleme bildirimi tekrarlamaz.
export function ClearOneShotParams() {
  useEffect(() => {
    const clean = withoutOneShotParams(window.location.href);
    if (clean) window.history.replaceState(null, "", clean);
  }, []);
  return null;
}
