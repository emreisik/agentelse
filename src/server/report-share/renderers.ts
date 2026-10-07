import type { ReactNode } from "react";

import type { BrandingSnapshot, ShareKind } from "@/lib/report-share/types";

// Paylaşım çizici kaydı (SC-F9 ve GA-F8 ortak). Genel /r/[token] sayfası
// türü bilmez; saklı raporu çizmeyi kayıtlı çiziciye bırakır. Çizici null
// dönerse ya da hata verirse sayfa tek tip "bulunamadı" gösterir.

export type ShareRenderResult = {
  title: string;
  periodLabel: string | null;
  node: ReactNode;
};

export type ShareRenderer = (share: {
  projectId: string;
  reportId: string;
  branding: BrandingSnapshot;
}) => Promise<ShareRenderResult | null>;

const renderers = new Map<ShareKind, ShareRenderer>();

// Aynı tür yeniden kaydedilirse öncekinin yerine geçer.
export function registerShareRenderer(
  kind: ShareKind,
  renderer: ShareRenderer,
): void {
  renderers.set(kind, renderer);
}

export function shareRendererFor(kind: ShareKind): ShareRenderer | null {
  return renderers.get(kind) ?? null;
}
