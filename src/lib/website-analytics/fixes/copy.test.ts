import { describe, expect, it } from "vitest";
import type { GoogleErrorClass } from "@/server/integrations/google/error-catalog";
import {
  GA_FIX_ERROR_MESSAGES,
  GA_FIX_REFUSAL_MESSAGES,
  GA_FIX_STATUS_LABEL,
  GA_FIX_STATUS_LABEL_SWITCHED_OFF,
  fixErrorFor,
} from "./copy";
import { GA_FIX_ERROR_CODES, GA_FIX_STATUSES } from "./types";

const CLASSES: GoogleErrorClass[] = [
  "TRANSIENT",
  "SERVER_ERROR",
  "RATE_LIMIT",
  "QUOTA_DAILY",
  "AUTH",
  "SCOPE_MISSING",
  "PERMISSION",
  "NOT_FOUND",
  "VALIDATION",
  "API_DISABLED",
  "UNKNOWN",
];

describe("fixErrorFor", () => {
  const expected: Record<GoogleErrorClass, [string, string]> = {
    TRANSIENT: ["google_unavailable", "google_unavailable"],
    SERVER_ERROR: ["google_unavailable", "google_unavailable"],
    RATE_LIMIT: ["rate_limited", "rate_limited"],
    QUOTA_DAILY: ["rate_limited", "rate_limited"],
    AUTH: ["reconnect", "reconnect"],
    SCOPE_MISSING: ["scope_missing", "scope_missing"],
    PERMISSION: ["no_property_access", "no_property_access"],
    NOT_FOUND: ["property_changed", "google_changed"],
    VALIDATION: ["rejected_by_google", "google_changed"],
    API_DISABLED: ["google_unavailable", "google_unavailable"],
    UNKNOWN: ["unknown", "google_changed"],
  };

  it.each(CLASSES)("%s", (errorClass) => {
    const [beta, alpha] = expected[errorClass];
    expect(fixErrorFor({ errorClass, alpha: false }).code).toBe(beta);
    expect(fixErrorFor({ errorClass, alpha: true }).code).toBe(alpha);
  });

  it("sınır mesajı limit_reached olur", () => {
    for (const message of [
      "Limit reached",
      "maximum number of key events",
      "quota exceeded for this property",
    ]) {
      for (const alpha of [false, true]) {
        expect(
          fixErrorFor({ errorClass: "VALIDATION", message, alpha }).code,
        ).toBe("limit_reached");
      }
    }
    expect(
      fixErrorFor({ errorClass: "VALIDATION", message: "bad value", alpha: false })
        .code,
    ).toBe("rejected_by_google");
  });

  it("yeniden denenebilir olanlar işaretlenir", () => {
    expect(fixErrorFor({ errorClass: "TRANSIENT", alpha: false }).retryable).toBe(
      true,
    );
    expect(fixErrorFor({ errorClass: "QUOTA_DAILY", alpha: false }).retryable).toBe(
      true,
    );
    expect(fixErrorFor({ errorClass: "AUTH", alpha: false }).retryable).toBe(
      undefined,
    );
  });

  it("mesaj koddan gelir", () => {
    const error = fixErrorFor({ errorClass: "PERMISSION", alpha: false });
    expect(error.message).toBe(GA_FIX_ERROR_MESSAGES.no_property_access);
  });
});

describe("metin tabloları", () => {
  it("her hata kodunun mesajı var ve 3+ basamaklı sayı yok", () => {
    for (const code of GA_FIX_ERROR_CODES) {
      const message = GA_FIX_ERROR_MESSAGES[code];
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/\d{3,}/);
    }
    expect(GA_FIX_ERROR_MESSAGES.cannot_undo).toBe(
      "It was changed again since. Change it back in Google Analytics if you still want it reverted.",
    );
  });

  it("ret mesajları", () => {
    expect(GA_FIX_REFUSAL_MESSAGES.alpha_off).toBe(
      "This kind of change is switched off right now.",
    );
    for (const message of Object.values(GA_FIX_REFUSAL_MESSAGES)) {
      expect(message).not.toMatch(/\d{3,}/);
    }
  });

  it("durum etiketleri", () => {
    for (const status of GA_FIX_STATUSES) {
      expect(GA_FIX_STATUS_LABEL[status].length).toBeGreaterThan(0);
    }
    expect(GA_FIX_STATUS_LABEL.PROPOSED).toBe("Waiting for approval");
    expect(GA_FIX_STATUS_LABEL.FAILED).toBe("Didn't work");
    expect(GA_FIX_STATUS_LABEL_SWITCHED_OFF).toBe(
      "Approved, switched off right now",
    );
  });
});
