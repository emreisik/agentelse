import { describe, expect, it } from "vitest";

import {
  ADMIN_ROLE_WARNING,
  APPLY_LABEL,
  CONNECT_ERROR_MESSAGES,
  EDITOR_RECOMMENDATION,
  MAKE_LIVE_LABEL,
  PUBLISH_DRAFT_LABEL,
  SEO_APPLY_REFUSAL_MESSAGES,
  SEO_CHANGE_ERROR_MESSAGES,
  SEO_CHANGE_SCRUB_TITLE,
  SEO_CHANGE_STATUS_LABEL,
  SEO_CHANGE_TASK_TITLE,
  WP_HEALTH_LABEL,
  changeUndoWarning,
} from "./copy";
import { SEO_CHANGE_ERROR_CODES, SEO_CHANGE_KINDS, SEO_CHANGE_STATUSES } from "./types";

// Hata ve ret metinleri veritabanına / göreve yazılır: rakam ve URL içermez.
// Bağlantı hataları yalnız diyalogda görünür; https:// örneği ve kullanıcı
// aracısı adı (AgentelseSEO/1.0) içerebilir.
function stored(text: string): void {
  expect(text.length).toBeGreaterThan(0);
  expect(text).not.toMatch(/\d/);
  expect(text.toLowerCase()).not.toContain("http");
}

describe("copy tables", () => {
  it("has a stored-safe message for every error code", () => {
    for (const code of SEO_CHANGE_ERROR_CODES) stored(SEO_CHANGE_ERROR_MESSAGES[code]);
  });

  it("has a stored-safe message for every refusal", () => {
    const refusals = Object.keys(SEO_APPLY_REFUSAL_MESSAGES) as (keyof typeof SEO_APPLY_REFUSAL_MESSAGES)[];
    expect(refusals.length).toBeGreaterThanOrEqual(17);
    for (const code of refusals) stored(SEO_APPLY_REFUSAL_MESSAGES[code]);
  });

  it("has a message for every connect code, including the new ones", () => {
    const codes = Object.keys(CONNECT_ERROR_MESSAGES);
    for (const code of ["subfolder", "wordpress_com", "busy", "domain_mismatch", "no_verified_site"]) {
      expect(codes).toContain(code);
    }
    for (const text of Object.values(CONNECT_ERROR_MESSAGES)) {
      expect(text.length).toBeGreaterThan(0);
    }
    expect(CONNECT_ERROR_MESSAGES.rest_blocked).toContain("AgentelseSEO");
  });

  it("keeps the domain, scope and reconnect texts distinct", () => {
    const texts = [
      SEO_CHANGE_ERROR_MESSAGES.domain_mismatch,
      SEO_CHANGE_ERROR_MESSAGES.scope_changed,
      SEO_CHANGE_ERROR_MESSAGES.reconnect,
    ];
    expect(new Set(texts).size).toBe(3);
  });

  it("uses the fixed texts from the contract", () => {
    expect(SEO_CHANGE_ERROR_MESSAGES.page_changed).toBe(
      "The page was edited after you reviewed this. Nothing was changed. Propose it again.",
    );
    expect(SEO_CHANGE_ERROR_MESSAGES.cannot_undo).toBe(
      "It was changed again in WordPress since. Undo it there if you still want it reverted.",
    );
    expect(SEO_CHANGE_ERROR_MESSAGES.limit_reached).toContain("Daily limit reached");
    expect(CONNECT_ERROR_MESSAGES.not_https).toBe("Use the https:// address of your site.");
    expect(CONNECT_ERROR_MESSAGES.busy).toBe("A change is being applied right now. Try again in a minute.");
  });

  it("task titles are short and carry no URL or article title", () => {
    for (const kind of SEO_CHANGE_KINDS) {
      const title = SEO_CHANGE_TASK_TITLE[kind];
      expect(title.length).toBeGreaterThan(0);
      expect(title.length).toBeLessThanOrEqual(80);
      expect(title.toLowerCase()).not.toContain("http");
      expect(title).not.toMatch(/\d/);
    }
    expect(SEO_CHANGE_SCRUB_TITLE).toBe("WordPress change");
  });

  it("labels every status and health", () => {
    for (const status of SEO_CHANGE_STATUSES) {
      expect(SEO_CHANGE_STATUS_LABEL[status].length).toBeGreaterThan(0);
    }
    expect(SEO_CHANGE_STATUS_LABEL.FAILED).toBe("Didn't work");
    for (const label of Object.values(WP_HEALTH_LABEL)) expect(label.length).toBeGreaterThan(0);
    expect(Object.keys(WP_HEALTH_LABEL)).toHaveLength(9);
  });

  it("exposes the button labels and role texts", () => {
    expect(PUBLISH_DRAFT_LABEL).toBe("Publish to WordPress (draft)");
    expect(APPLY_LABEL).toBe("Apply with approval");
    expect(MAKE_LIVE_LABEL).toBe("Make it live (needs approval)");
    expect(ADMIN_ROLE_WARNING).toContain("administrator");
    expect(EDITOR_RECOMMENDATION).toContain("Editor");
  });

  it("warns about undo only for kinds that create or publish", () => {
    expect(changeUndoWarning("PUBLISH_ARTICLE")).toBe("Undo moves the draft to the WordPress Trash.");
    expect(changeUndoWarning("PUBLISH_LIVE")).toBe("Undo makes the article a draft again.");
    expect(changeUndoWarning("TITLE_META")).toBeNull();
    expect(changeUndoWarning("INTERNAL_LINKS")).toBeNull();
  });
});
