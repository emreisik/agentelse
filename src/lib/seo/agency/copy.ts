import type { AddSiteCode, BqBadge } from "./types";
import type { PageGroupMatch } from "./page-groups";

// Sabit kullanıcı metinleri (İngilizce, istemci güvenli). Ham hata ya da
// Google metni buraya girmez.

export const ADD_SITE_MESSAGE: Record<AddSiteCode, string> = {
  NOT_ALLOWED: "Multi-site tracking isn't available yet.",
  NOT_CONNECTED: "Connect Search Console for this project first.",
  NOT_IN_ACCOUNT: "That site isn't in the connected Search Console account.",
  UNVERIFIED: "That site isn't verified in Search Console.",
  ALREADY_ADDED: "This site is already tracked.",
  IS_PRIMARY: "This is already the main site of the project.",
  LIMIT: "A project can track up to 5 Search Console sites.",
  OTHER_MODE: "This site already exists in another mode.",
};

export const SECONDARY_NOTE =
  "Secondary sites sync their Search Console numbers. Health checks, opportunities, reports and fixes run for the primary site.";

export const PAGE_GROUP_MATCH_LABEL: Record<PageGroupMatch, string> = {
  PREFIX: "Starts with",
  GLOB: "Pattern (* and **)",
  EXACT: "Exactly",
};

export const BQ_BADGE_LABEL: Record<BqBadge, string> = {
  OFF: "Off",
  DRAFT: "Not verified",
  VERIFIED: "Ready",
  ACTIVE: "On",
  PAUSED: "Paused",
  ERROR: "Needs attention",
  BUDGET: "Monthly budget used",
};
