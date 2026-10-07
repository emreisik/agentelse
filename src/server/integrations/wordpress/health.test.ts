import { describe, expect, it } from "vitest";

import type { WpCapabilities } from "@/lib/seo/apply/types";

import { WordPressApiError, type WpErrorClass } from "./errors";
import { classifyConnection } from "./health";

const FULL: WpCapabilities = {
  draftPosts: true,
  publishPosts: true,
  editPublishedPosts: true,
  editPages: true,
  editPublishedPages: true,
  editOthers: true,
  deletePosts: true,
};

const CONTRIBUTOR: WpCapabilities = {
  draftPosts: true,
  publishPosts: false,
  editPublishedPosts: false,
  editPages: false,
  editPublishedPages: false,
  editOthers: false,
  deletePosts: true,
};

const NOTHING: WpCapabilities = {
  draftPosts: false,
  publishPosts: false,
  editPublishedPosts: false,
  editPages: false,
  editPublishedPages: false,
  editOthers: false,
  deletePosts: false,
};

const ok = { domainOk: true, scopeOk: true };

describe("classifyConnection", () => {
  it("alan adı kapsam dışıysa DOMAIN_MISMATCH (en yüksek öncelik)", () => {
    expect(
      classifyConnection({
        capabilities: FULL,
        error: new WordPressApiError("AUTH"),
        domainOk: false,
        scopeOk: false,
      }),
    ).toEqual({ health: "DOMAIN_MISMATCH", reason: "domain_mismatch" });
  });

  it("kapsam anahtarı değiştiyse DOMAIN_MISMATCH ve scope_changed", () => {
    expect(
      classifyConnection({ capabilities: FULL, error: null, domainOk: true, scopeOk: false }),
    ).toEqual({ health: "DOMAIN_MISMATCH", reason: "scope_changed" });
  });

  it.each<[WpErrorClass, string, string | null]>([
    ["AUTH", "AUTH", "reconnect"],
    ["APP_PASSWORDS_DISABLED", "AUTH", "reconnect"],
    ["FORBIDDEN", "NO_PERMISSION", "no_edit_rights"],
    ["REST_DISABLED", "REST_BLOCKED", "rest_blocked"],
    ["REDIRECT", "REST_BLOCKED", "rest_blocked"],
    ["NOT_FOUND", "REST_BLOCKED", "rest_blocked"],
    ["NOT_WORDPRESS", "NOT_WORDPRESS", "not_wordpress"],
    ["TRANSIENT", "UNREACHABLE", "unreachable"],
    ["SERVER", "UNREACHABLE", "unreachable"],
    ["UNSAFE", "UNREACHABLE", "unreachable"],
    ["RATE_LIMIT", "UNREACHABLE", "unreachable"],
    ["VALIDATION", "UNKNOWN", null],
  ])("hata %s -> %s", (errorClass, health, reason) => {
    expect(
      classifyConnection({ capabilities: null, error: new WordPressApiError(errorClass), ...ok }),
    ).toEqual({ health, reason });
  });

  it("hata yetkilerden önce gelir", () => {
    expect(
      classifyConnection({ capabilities: FULL, error: new WordPressApiError("AUTH"), ...ok }).health,
    ).toBe("AUTH");
  });

  it("yetkilere göre OK, LIMITED, NO_PERMISSION", () => {
    expect(classifyConnection({ capabilities: FULL, error: null, ...ok })).toEqual({
      health: "OK",
      reason: null,
    });
    expect(classifyConnection({ capabilities: CONTRIBUTOR, error: null, ...ok })).toEqual({
      health: "LIMITED",
      reason: "limited",
    });
    expect(classifyConnection({ capabilities: NOTHING, error: null, ...ok })).toEqual({
      health: "NO_PERMISSION",
      reason: "no_edit_rights",
    });
  });

  it("hiçbir bilgi yoksa UNKNOWN", () => {
    expect(classifyConnection({ capabilities: null, error: null, ...ok })).toEqual({
      health: "UNKNOWN",
      reason: null,
    });
  });
});
