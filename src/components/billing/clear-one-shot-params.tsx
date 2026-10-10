"use client";

import { useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { withoutOneShotParams } from "@/lib/billing/one-shot-params";

// Bildirim ekranda gösterildikten sonra tek seferlik parametreleri adres çubuğundan
// siler (bkz. one-shot-params.ts). Ekrandaki bildirim yerinde kalır; yer imi ve yeniden
// yükleme bildirimi tekrarlamaz.
//
// İki incelik (ikisi de Next'in yönlendiricisiyle ilgili):
//  - Silme bir sonraki turda yapılır. Next, `history.replaceState`'i kendi yamasıyla
//    yalnız KÖK yönlendiricinin etkisinde sarar ve React çocuk etkilerini ÖNCE çalıştırır;
//    sayfa ilk yüklendiğinde doğrudan çağrılan yerel replaceState `history.state`'i
//    (Next'in ağacı) siler: Geri düğmesi ölür, yönlendirici eski adresi bilmeye devam
//    eder ve sonraki bir yenileme eski parametrelerle Checkout dönüşünü yeniden işler.
//  - Etki arama parametrelerine bağlıdır: `router.push("…&notice=canceled")` sayfa
//    parçasını yeniden bağlamaz (arama parametreleri durum anahtarına girmez), bu yüzden
//    yalnız açılışta çalışan bir etki sonradan gelen bildirimleri hiç temizlemezdi.
export function ClearOneShotParams() {
  const search = useSearchParams()?.toString() ?? "";
  useEffect(() => {
    const id = window.setTimeout(() => {
      const clean = withoutOneShotParams(window.location.href);
      if (clean) window.history.replaceState(null, "", clean);
    }, 0);
    return () => window.clearTimeout(id);
  }, [search]);
  return null;
}
