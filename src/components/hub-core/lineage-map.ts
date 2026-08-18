// Şemadaki gerçek foreign-key zincirinden türetilmiş statik ilişki
// tablosu — panel açıldığında üstte gösterilen "besliyor / beslenir"
// breadcrumb rozetleri buradan okunur. Kod değil, veri: yeni bir modül
// eklendiğinde tek satır eklemek yeterli.

import type { PanelKey } from "./hub-core-params";

export type LineageRelation = "feeds" | "fedBy" | "relatesTo" | "governs";

export type LineageEdge = { panel: PanelKey; relation: LineageRelation };

export const PANEL_LABEL: Record<PanelKey, string> = {
  kurulum: "Kurulum",
  "marka-beyni": "Marka Beyni",
  sinyaller: "Sinyaller",
  "icgoru-firsat": "İçgörü & Fırsat",
  hedefler: "Hedefler",
  fikirler: "Fikirler",
  isler: "İşler",
  departmanlar: "Departmanlar",
  onaylar: "Onay Merkezi",
  "insan-eylem": "İnsan Eylem Merkezi",
  ayarlar: "Ayarlar",
  kutuphane: "Kütüphane",
};

export const RELATION_LABEL: Record<LineageRelation, string> = {
  feeds: "Besler",
  fedBy: "Beslenir",
  relatesTo: "İlişkili",
  governs: "Yapılandırır",
};

// Her panel için giden/gelen ilişkiler. Simetrik ilişkiler (feeds/fedBy)
// bilinçli olarak her iki uçta da tekrar tanımlanıyor ki her panel kendi
// perspektifinden okunabilsin.
export const LINEAGE: Record<PanelKey, LineageEdge[]> = {
  kurulum: [],
  "marka-beyni": [{ panel: "sinyaller", relation: "feeds" }],
  sinyaller: [
    { panel: "marka-beyni", relation: "fedBy" },
    { panel: "icgoru-firsat", relation: "feeds" },
  ],
  "icgoru-firsat": [
    { panel: "sinyaller", relation: "fedBy" },
    { panel: "hedefler", relation: "feeds" },
    { panel: "fikirler", relation: "feeds" },
  ],
  hedefler: [{ panel: "icgoru-firsat", relation: "fedBy" }],
  fikirler: [
    { panel: "icgoru-firsat", relation: "fedBy" },
    { panel: "isler", relation: "feeds" },
  ],
  isler: [
    { panel: "fikirler", relation: "fedBy" },
    { panel: "departmanlar", relation: "relatesTo" },
    { panel: "onaylar", relation: "feeds" },
  ],
  departmanlar: [{ panel: "isler", relation: "relatesTo" }],
  onaylar: [{ panel: "isler", relation: "fedBy" }],
  "insan-eylem": [{ panel: "isler", relation: "relatesTo" }],
  ayarlar: [],
  kutuphane: [],
};
