import { describe, expect, it } from "vitest";

import {
  classifyWpResponse,
  WordPressApiError,
  wpErrorToChangeCode,
  type WpErrorClass,
} from "./errors";

describe("classifyWpResponse", () => {
  it("2xx başarıdır", () => {
    expect(classifyWpResponse(200, {})).toBeNull();
    expect(classifyWpResponse(201, [])).toBeNull();
  });

  it("durum kodlarını sınıflar", () => {
    const json = { code: "x", data: { status: 0 } };
    const cases: [number, unknown, WpErrorClass][] = [
      [301, "", "REDIRECT"],
      [401, { code: "rest_not_logged_in" }, "AUTH"],
      [403, { code: "rest_forbidden" }, "FORBIDDEN"],
      [404, { code: "rest_post_invalid_id" }, "NOT_FOUND"],
      [400, json, "VALIDATION"],
      [429, json, "RATE_LIMIT"],
      [500, json, "SERVER"],
      [502, json, "TRANSIENT"],
      [503, json, "TRANSIENT"],
      [504, json, "TRANSIENT"],
      [408, json, "TRANSIENT"],
    ];
    for (const [status, body, expected] of cases) {
      expect(classifyWpResponse(status, body)).toBe(expected);
    }
  });

  it("JSON olmayan 403 güvenlik duvarıdır, JSON olmayan 404 WordPress değildir", () => {
    expect(classifyWpResponse(403, "<html>blocked</html>")).toBe("REST_DISABLED");
    expect(classifyWpResponse(404, "<html>nope</html>")).toBe("NOT_WORDPRESS");
  });

  it("application_passwords_disabled durum kodundan bağımsızdır", () => {
    expect(
      classifyWpResponse(501, { code: "application_passwords_disabled" }),
    ).toBe("APP_PASSWORDS_DISABLED");
    expect(
      classifyWpResponse(401, { code: "application_passwords_disabled" }),
    ).toBe("APP_PASSWORDS_DISABLED");
  });

  it("REST'i kapatan eklenti kodları REST_DISABLED, çöp kutusu kapalıysa VALIDATION", () => {
    expect(classifyWpResponse(401, { code: "rest_login_required" })).toBe(
      "REST_DISABLED",
    );
    expect(classifyWpResponse(501, { code: "rest_trash_not_supported" })).toBe(
      "VALIDATION",
    );
  });
});

describe("WordPressApiError", () => {
  it("mesaj sabittir ve yanıt gövdesini taşımaz", () => {
    const error = new WordPressApiError("AUTH", {
      httpStatus: 401,
      wpCode: "incorrect_password",
    });
    expect(error.message).toBe(
      "WordPress did not accept the username and Application Password.",
    );
    expect(error.wpCode).toBe("incorrect_password");
    expect(error.retryable).toBe(false);
  });

  it("güvensiz karakterli kod saklanmaz", () => {
    const error = new WordPressApiError("VALIDATION", {
      wpCode: "<script>alert(1)</script>",
    });
    expect(error.wpCode).toBeNull();
  });

  it("geçici sınıflar varsayılan olarak yeniden denenebilir", () => {
    expect(new WordPressApiError("TRANSIENT").retryable).toBe(true);
    expect(new WordPressApiError("SERVER").retryable).toBe(true);
    expect(new WordPressApiError("RATE_LIMIT").retryable).toBe(true);
    expect(new WordPressApiError("FORBIDDEN").retryable).toBe(false);
    expect(new WordPressApiError("SERVER", { retryable: false }).retryable).toBe(
      false,
    );
  });
});

describe("wpErrorToChangeCode", () => {
  it("sınıfları motor koduna çevirir", () => {
    expect(wpErrorToChangeCode(new WordPressApiError("AUTH"))).toEqual({
      code: "reconnect",
      retryable: false,
      errorClass: "OTHER",
    });
    expect(wpErrorToChangeCode(new WordPressApiError("FORBIDDEN")).code).toBe(
      "no_permission",
    );
    expect(wpErrorToChangeCode(new WordPressApiError("NOT_FOUND")).code).toBe(
      "page_not_found",
    );
    expect(wpErrorToChangeCode(new WordPressApiError("VALIDATION")).code).toBe(
      "rejected_by_site",
    );
    expect(wpErrorToChangeCode(new WordPressApiError("RATE_LIMIT"))).toEqual({
      code: "rate_limited",
      retryable: true,
      errorClass: "RATE_LIMIT",
    });
    expect(wpErrorToChangeCode(new WordPressApiError("TRANSIENT"))).toEqual({
      code: "site_unavailable",
      retryable: true,
      errorClass: "TRANSIENT",
    });
    expect(wpErrorToChangeCode(new WordPressApiError("SERVER"))).toEqual({
      code: "site_unavailable",
      retryable: true,
      errorClass: "SERVER",
    });
    expect(wpErrorToChangeCode(new WordPressApiError("REST_DISABLED")).code).toBe(
      "site_unhealthy",
    );
  });

  it("WordPress hatası olmayan hata unknown olur", () => {
    expect(wpErrorToChangeCode(new Error("boom"))).toEqual({
      code: "unknown",
      retryable: false,
      errorClass: "OTHER",
    });
  });
});
