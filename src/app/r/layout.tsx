import type { Metadata } from "next";
import type { ReactNode } from "react";

// /r altındaki her yanıt (nötr "not available" sayfası ve beyaz etiketli rapor)
// kök düzenin Agentelse başlığını, açıklamasını ve simgesini devralmasın:
// aksi hâlde müşteriye ve bağlantıyı yoklayan herkese ürün adı sızar. Başlık
// ve simge her başarısızlık türünde aynıdır, yani ayırt edici bir ipucu yoktur.

const BLANK_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/%3E";

export const metadata: Metadata = {
  title: "Report",
  description: "Shared report",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
  icons: { icon: BLANK_ICON, apple: BLANK_ICON },
};

export default function ReportLinkLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
