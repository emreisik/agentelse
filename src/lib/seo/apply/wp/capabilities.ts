// SC-F8: WordPress kullanıcısının yetkileri (users/me?context=edit -> capabilities)
// ve değişiklik türlerinin gerektirdiği yetkiler. Saf modül.

import type { SeoChangeKind, WpCapabilities, WpType } from "../types";
import type { WpMe } from "./wp-types";

export function deriveWpCapabilities(me: WpMe): WpCapabilities {
  const has = (name: string) => me.capabilities[name] === true;
  return {
    draftPosts: has("edit_posts"),
    publishPosts: has("publish_posts"),
    editPublishedPosts: has("edit_published_posts"),
    editPages: has("edit_pages"),
    editPublishedPages: has("edit_published_pages"),
    editOthers: has("edit_others_posts"),
    deletePosts: has("delete_posts"),
  };
}

// Mevcut yayımlanmış sayfayı düzenlemek başkasının içeriğine dokunur: ikisi de gerekir.
export function capabilityAllows(
  caps: WpCapabilities,
  kind: SeoChangeKind,
  wpType: WpType | null,
): boolean {
  switch (kind) {
    case "PUBLISH_ARTICLE":
      return caps.draftPosts;
    case "PUBLISH_LIVE":
      return caps.publishPosts;
    case "TITLE_META":
    case "INTERNAL_LINKS": {
      if (!caps.editOthers) return false;
      if (wpType === "page") return caps.editPublishedPages;
      if (wpType === "post") return caps.editPublishedPosts;
      return caps.editPublishedPosts && caps.editPublishedPages;
    }
  }
}

export function healthFromCapabilities(
  caps: WpCapabilities,
): "OK" | "LIMITED" | "NO_PERMISSION" {
  if (!caps.draftPosts && !caps.editPublishedPosts && !caps.editPublishedPages) {
    return "NO_PERMISSION";
  }
  const full =
    caps.draftPosts &&
    caps.publishPosts &&
    caps.editPublishedPosts &&
    caps.editPublishedPages &&
    caps.editOthers;
  return full ? "OK" : "LIMITED";
}

export function isAdministrator(me: WpMe): boolean {
  return me.roles.includes("administrator");
}
