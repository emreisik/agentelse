// SC-F8: WordPress uygulama katmanının ortak tipleri ve sabit listeleri.
// Saf dosya (istemciden de içe aktarılabilir).

export const SEO_CHANGE_KINDS = [
  "PUBLISH_ARTICLE",
  "PUBLISH_LIVE",
  "TITLE_META",
  "INTERNAL_LINKS",
] as const;
export type SeoChangeKind = (typeof SEO_CHANGE_KINDS)[number];

export const SEO_CHANGE_STATUSES = [
  "PROPOSED",
  "APPROVED",
  "APPLYING",
  "APPLIED",
  "VERIFIED",
  "FAILED",
  "UNDOING",
  "UNDONE",
  "REJECTED",
  "EXPIRED",
] as const;
export type SeoChangeStatus = (typeof SEO_CHANGE_STATUSES)[number];

export type SeoChangeSource = "ARTICLE" | "ACTION" | "DRAFT";

export type WpType = "post" | "page";

// Uygulamadan hemen önce canlı okunan ve geri okunan durum. modified ISO UTC;
// contentRaw yalnız INTERNAL_LINKS before'unda (en çok 200_000 karakter).
export type WpSnapshot = {
  exists: boolean;
  type: WpType | null;
  id: number | null;
  status: string | null;
  link: string | null;
  modified: string | null;
  title: string | null;
  excerpt: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  contentHash: string | null;
  contentWords: number | null;
  contentRaw: string | null;
};

export type SeoChangeParams =
  | {
      kind: "PUBLISH_ARTICLE";
      creativeId: string;
      versionId: string;
      title: string;
      metaDescription: string;
      // Terminal durumdan 30 gün sonra boşaltılır (makale Creative'de zaten durur).
      markdown: string;
      language: string | null;
    }
  | {
      kind: "PUBLISH_LIVE";
      draftChangeId: string;
      wpType: "post";
      wpId: number;
      link: string | null;
      expectModified: string;
      creativeId: string | null;
    }
  | {
      kind: "TITLE_META";
      url: string;
      wpType: WpType;
      wpId: number;
      expectModified: string;
      title: string | null;
      metaDescription: string | null;
    }
  | {
      kind: "INTERNAL_LINKS";
      url: string;
      wpType: WpType;
      wpId: number;
      expectModified: string;
      links: { toUrl: string; anchor: string }[];
    };

export const SEO_CHANGE_ERROR_CODES = [
  "not_enabled",
  "not_connected",
  "site_unhealthy",
  "reconnect",
  "no_permission",
  "domain_mismatch",
  "scope_changed",
  "page_not_found",
  "page_ambiguous",
  "page_changed",
  "builder_page",
  "anchor_not_found",
  "seo_plugin_unsupported",
  "limit_reached",
  "readback_mismatch",
  "site_unavailable",
  "rejected_by_site",
  "rate_limited",
  "cannot_undo",
  "approval_missing",
  "article_gone",
  "unknown",
] as const;
export type SeoChangeErrorCode = (typeof SEO_CHANGE_ERROR_CODES)[number];

export type SeoChangeError = {
  code: SeoChangeErrorCode;
  message: string;
  retryable?: boolean;
  undo?: boolean;
};

// Öneri aşamasında (propose) verilen ret nedenleri.
export type SeoApplyRefusal =
  | "not_enabled"
  | "not_connected"
  | "site_unhealthy"
  | "no_permission"
  | "domain_mismatch"
  | "invalid"
  | "already_done"
  | "already_open"
  | "article_missing"
  | "draft_missing"
  | "page_not_found"
  | "page_ambiguous"
  | "builder_page"
  | "anchor_not_found"
  | "seo_plugin_unsupported"
  | "site_unavailable"
  | "not_allowed_here";

export type SeoFieldsCapability = {
  plugin: "YOAST" | "RANK_MATH" | "NONE";
  titleVia: "META" | "RANKMATH_ENDPOINT" | "POST_TITLE";
  descriptionVia: "META" | "RANKMATH_ENDPOINT" | "NONE";
  // Yalnız META tam okunabilir.
  verifiable: boolean;
};

export type WpCapabilities = {
  draftPosts: boolean;
  publishPosts: boolean;
  editPublishedPosts: boolean;
  editPages: boolean;
  editPublishedPages: boolean;
  editOthers: boolean;
  deletePosts: boolean;
};

export type WpHealth =
  | "OK"
  | "LIMITED"
  | "AUTH"
  | "NO_PERMISSION"
  | "UNREACHABLE"
  | "NOT_WORDPRESS"
  | "REST_BLOCKED"
  | "DOMAIN_MISMATCH"
  | "UNKNOWN";

export type ConnectErrorCode =
  | "invalid_url"
  | "not_https"
  | "subfolder"
  | "wordpress_com"
  | "no_verified_site"
  | "domain_mismatch"
  | "unreachable"
  | "not_wordpress"
  | "rest_blocked"
  | "app_passwords_disabled"
  | "bad_credentials"
  | "no_edit_rights"
  | "invalid_input"
  | "not_allowed"
  | "busy"
  | "unknown";
