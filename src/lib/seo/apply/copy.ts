import type {
  ConnectErrorCode,
  SeoApplyRefusal,
  SeoChangeErrorCode,
  SeoChangeKind,
  SeoChangeStatus,
  WpHealth,
} from "./types";

// SC-F8: sabit İngilizce metinler (arayüz, görev başlığı, hata kodları).
// Saf ve istemci güvenli. Görev ve onay metinleri sabittir: sayfa yolu, URL ve
// makale başlığı burada yer almaz; WordPress'ten gelen hiçbir ham metin
// kullanıcıya ya da Task.failureReason'a taşınmaz.

export const PUBLISH_DRAFT_LABEL = "Publish to WordPress (draft)";
export const APPLY_LABEL = "Apply with approval";
export const MAKE_LIVE_LABEL = "Make it live (needs approval)";

export const SEO_CHANGE_TASK_TITLE: Record<SeoChangeKind, string> = {
  PUBLISH_ARTICLE: "Create a WordPress draft",
  PUBLISH_LIVE: "Publish a WordPress draft",
  TITLE_META: "Change a page title and description on WordPress",
  INTERNAL_LINKS: "Add internal links on WordPress",
};

// Disconnect görev ve sohbet kartı metnini bununla siler.
export const SEO_CHANGE_SCRUB_TITLE = "WordPress change";

export const SEO_CHANGE_STATUS_LABEL: Record<SeoChangeStatus, string> = {
  PROPOSED: "Waiting for approval",
  APPROVED: "Approved, applying",
  APPLYING: "Applying",
  APPLIED: "Applied, checking",
  VERIFIED: "Done and checked",
  FAILED: "Didn't work",
  UNDOING: "Undoing",
  UNDONE: "Undone",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
};

export const SEO_CHANGE_ERROR_MESSAGES: Record<SeoChangeErrorCode, string> = {
  not_enabled: "Website changes are not switched on for this project.",
  not_connected: "WordPress is not connected. Connect it first.",
  site_unhealthy:
    "The WordPress connection is not healthy. Check it in the WordPress settings.",
  reconnect: "WordPress did not accept the saved password. Connect it again.",
  no_permission:
    "The WordPress user is not allowed to make this change. Use an Editor user.",
  domain_mismatch:
    "This WordPress address is no longer inside the site you verified on the Search page.",
  scope_changed:
    "The site you verified on the Search page changed. Re-check the connection in the WordPress settings.",
  page_not_found: "The page does not exist on WordPress any more. Nothing was changed.",
  page_ambiguous:
    "More than one page matched. Nothing was changed. Pick the page in WordPress instead.",
  page_changed:
    "The page was edited after you reviewed this. Nothing was changed. Propose it again.",
  builder_page:
    "This page is built with a page builder. Agentelse cannot safely edit its content.",
  anchor_not_found:
    "The words for a link were not found in the page text. Nothing was changed.",
  seo_plugin_unsupported:
    "Your SEO plugin does not let Agentelse change the meta description.",
  limit_reached:
    "Daily limit reached. It will go ahead automatically when there is room.",
  readback_mismatch:
    "WordPress accepted the change but showed something different afterwards. Check the page in WordPress, or undo the change here.",
  site_unavailable:
    "The WordPress site did not answer. Agentelse will try again shortly.",
  rejected_by_site:
    "WordPress refused the change. Check the user's rights and any security plugin.",
  rate_limited:
    "WordPress asked Agentelse to slow down. It will try again later.",
  cannot_undo:
    "It was changed again in WordPress since. Undo it there if you still want it reverted.",
  approval_missing: "The approval is no longer valid. Nothing was changed.",
  article_gone: "The article is no longer available. Nothing was changed.",
  unknown: "Something went wrong. Nothing more was changed.",
};

export const SEO_APPLY_REFUSAL_MESSAGES: Record<SeoApplyRefusal, string> = {
  not_enabled: "Website changes are not switched on for this project.",
  not_connected: "Connect WordPress first.",
  site_unhealthy:
    "The WordPress connection is not healthy. Check it in the WordPress settings.",
  no_permission: "Only a workspace owner or admin can do this.",
  domain_mismatch:
    "This WordPress address is not inside the site you verified on the Search page.",
  invalid: "Check the text and try again.",
  already_done: "This is already in place on the page.",
  already_open: "A change for this is already waiting or in progress.",
  article_missing: "The article is not ready to send. Approve or schedule it first.",
  draft_missing: "There is no WordPress draft to make live.",
  page_not_found: "That page was not found on your WordPress site.",
  page_ambiguous: "More than one page matched. Pick the page in WordPress instead.",
  builder_page:
    "This page is built with a page builder. Agentelse cannot safely edit its content.",
  anchor_not_found: "The words for a link were not found in the page text.",
  seo_plugin_unsupported:
    "Your SEO plugin does not let Agentelse change the meta description.",
  site_unavailable: "The WordPress site did not answer. Try again in a minute.",
  not_allowed_here: "Website changes are not allowed from this environment.",
};

export const CONNECT_ERROR_MESSAGES: Record<ConnectErrorCode, string> = {
  invalid_url: "Enter the address of your WordPress site.",
  not_https: "Use the https:// address of your site.",
  subfolder:
    "Use the address of your site without a folder, for example https://example.com.",
  wordpress_com: "Sites hosted on WordPress.com are not supported yet.",
  no_verified_site: "Verify your site on the Search page first.",
  domain_mismatch:
    "This address is not inside the site you verified on the Search page.",
  unreachable: "Agentelse could not reach that address. Check it and try again.",
  not_wordpress: "That address does not look like a WordPress site.",
  rest_blocked:
    "The site blocked Agentelse. In your security plugin or firewall, allow the user agent AgentelseSEO/1.0.",
  app_passwords_disabled:
    "Application Passwords are switched off on this WordPress site.",
  bad_credentials:
    "WordPress did not accept that username and Application Password.",
  no_edit_rights:
    "This WordPress user cannot edit posts. Use a user with the Editor role.",
  invalid_input: "Enter the site address, the username and the Application Password.",
  not_allowed: "Only a workspace owner or admin can do this.",
  busy: "A change is being applied right now. Try again in a minute.",
  unknown: "Something went wrong. Try again.",
};

export const WP_HEALTH_LABEL: Record<WpHealth, string> = {
  OK: "Connected",
  LIMITED: "Connected, with limits",
  AUTH: "Password not accepted",
  NO_PERMISSION: "User cannot edit",
  UNREACHABLE: "Site not reachable",
  NOT_WORDPRESS: "Not a WordPress site",
  REST_BLOCKED: "Blocked by the site",
  DOMAIN_MISMATCH: "Outside the verified site",
  UNKNOWN: "Not checked yet",
};

export const ADMIN_ROLE_WARNING =
  "This account is an administrator. An Application Password can do everything its user can. Create an Editor user for Agentelse instead.";

export const EDITOR_RECOMMENDATION =
  "Use a dedicated WordPress user with the Editor role.";

// Geri almanın kullanıcıya açık uyarısı (yalnız yazı oluşturan değişikliklerde).
export function changeUndoWarning(kind: SeoChangeKind): string | null {
  if (kind === "PUBLISH_ARTICLE") {
    return "Undo moves the draft to the WordPress Trash.";
  }
  if (kind === "PUBLISH_LIVE") return "Undo makes the article a draft again.";
  return null;
}
