import type {
  SeoChangeErrorCode,
  SeoChangeKind,
  SeoChangeSource,
  SeoChangeStatus,
  WpCapabilities,
  WpHealth,
} from "./types";

// SC-F8 arayüz tipleri (yalnız tip). Sunucu okuyucuları (read.ts, connect.ts,
// offers.ts) üretir; panel, diyalog ve düğmeler tüketir.

export type SeoChangeView = {
  id: string;
  kind: SeoChangeKind;
  title: string;
  status: SeoChangeStatus;
  // PROPOSED satırlarda Approval satırından türetilir: sohbette verilen ret
  // hemen 'Rejected' gösterir.
  statusLabel: string;
  source: SeoChangeSource;
  createdAt: string;
  resolvedAt: string | null;
  expiresAt: string | null;
  approvalId: string | null;
  // OWNER/ADMIN ve onay PENDING.
  canDecide: boolean;
  // isUndoable: VERIFIED ya da yazısı inmiş FAILED.
  canUndo: boolean;
  // PUBLISH_ARTICLE VERIFIED, noop değil, açık PUBLISH_LIVE yok.
  canMakeLive: boolean;
  undoWarning: string | null;
  noop: boolean;
  preview: { label: string; value: string }[];
  link: string | null;
  draft: boolean;
  indexNow: "PENDING" | "SENT" | "SKIPPED" | "FAILED" | null;
  error: { code: SeoChangeErrorCode; message: string } | null;
};

export type WordPressConnectionView = {
  connected: boolean;
  siteId: string | null;
  origin: string | null;
  host: string | null;
  accountLabel: string | null;
  health: WpHealth;
  healthLabel: string;
  healthReason: string | null;
  seoPlugin: "YOAST" | "RANK_MATH" | "NONE";
  descriptionWritable: boolean;
  capabilities: WpCapabilities | null;
  lastCheckedAt: string | null;
  canManage: boolean;
  adminWarning: boolean;
  // Sağlık DOMAIN_MISMATCH ya da kapsam anahtarı değişti.
  canRebind: boolean;
};

export type IndexNowView = {
  enabled: boolean;
  key: string | null;
  keyFileName: string | null;
  keyUrl: string | null;
  verified: boolean;
  lastPingAt: string | null;
};

export type SeoApplyView = {
  connection: WordPressConnectionView;
  canManage: boolean;
  dailyLimit: number;
  usedToday: number;
  // Yeniden eskiye, en çok 30.
  changes: SeoChangeView[];
  // seoIndexNowEnabled() değilse null.
  indexNow: IndexNowView | null;
};

export type ApplyOffer = {
  state: "ready" | "pending" | "applied" | "needs_text" | "blocked";
  changeId: string | null;
  actionId: string | null;
  findingId: string | null;
  kind: "TITLE_META" | "INTERNAL_LINKS";
  // Henüz VERIFIED değişikliklerle karşılanmamış bağlantılar; arayüz fromUrl'e
  // göre gruplar (sayfa başına bir düğme, 3'lük dilimler).
  links: { fromUrl: string; toUrl: string; anchor: string }[];
  hint: string | null;
};

export type PublishStatusView = {
  connected: boolean;
  healthy: boolean;
  canPropose: boolean;
  blockedReason: string | null;
  // Creative için son PUBLISH_ARTICLE.
  change: SeoChangeView | null;
  // Creative için son PUBLISH_LIVE (creativeId sütunuyla bulunur).
  liveChange: SeoChangeView | null;
  isManager: boolean;
  connectHref: string;
};
