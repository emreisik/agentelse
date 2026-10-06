import { describe, expect, it } from "vitest";

import {
  ENHANCED_MEASUREMENT_EVENTS,
  EU_EEA_COUNTRIES,
  checkResult,
  cleanLabel,
  isGatewaySource,
  isStandardMedium,
  round3,
} from "./known-values";

// Bu dosyanın kanıtladığı (GA-F3 bilinen değerler): standart medium'lar
// küçük harfli ve GA kanal kurallarına uyanlardır; ödeme/giriş ağ geçitleri
// tanınır; etiketler maskelenir ve kısalır; sonuç kurucu PASS/UNKNOWN'da
// varsayılan önemi kullanır ve günleri tekil sıralar.

describe("isStandardMedium", () => {
  it("accepts GA's default channel mediums in lower case", () => {
    for (const medium of [
      "(none)",
      "(not set)",
      "organic",
      "referral",
      "email",
      "e-mail",
      "e_mail",
      "cpc",
      "ppc",
      "paidsocial",
      "paid_social",
      "social",
      "social-network",
      "social_media",
      "sm",
      "display",
      "affiliate",
      "organic_social",
      "sms",
    ]) {
      expect(isStandardMedium(medium)).toBe(true);
    }
  });

  it("rejects upper case and unknown mediums", () => {
    for (const medium of ["Email", "CPC", "newsletter", "story", "bio", ""]) {
      expect(isStandardMedium(medium)).toBe(false);
    }
  });
});

describe("isGatewaySource", () => {
  it("recognises payment and login hosts", () => {
    for (const source of [
      "paypal.com",
      "www.sandbox.paypal.com",
      "checkout.stripe.com",
      "sandbox-api.iyzipay.com",
      "iyzico.com",
      "secure.payu.com",
      "klarna.com",
      "accounts.google.com",
      "appleid.apple.com",
      "login.microsoftonline.com",
      "checkout.shop.example",
      "Mollie.com",
    ]) {
      expect(isGatewaySource(source)).toBe(true);
    }
    for (const source of ["google", "example.com", "instagram.com"]) {
      expect(isGatewaySource(source)).toBe(false);
    }
  });
});

describe("known lists", () => {
  it("holds the EU/EEA countries and enhanced measurement events", () => {
    expect(EU_EEA_COUNTRIES.size).toBe(31);
    expect(EU_EEA_COUNTRIES.has("Czechia")).toBe(true);
    expect(EU_EEA_COUNTRIES.has("Czech Republic")).toBe(true);
    expect(EU_EEA_COUNTRIES.has("Norway")).toBe(true);
    expect(EU_EEA_COUNTRIES.has("Turkey")).toBe(false);
    expect(EU_EEA_COUNTRIES.has("Switzerland")).toBe(false);
    expect(ENHANCED_MEASUREMENT_EVENTS).toContain("scroll");
    expect(ENHANCED_MEASUREMENT_EVENTS).not.toContain("page_view");
  });
});

describe("cleanLabel", () => {
  it("masks an email and caps the length", () => {
    const label = cleanLabel("newsletter jane.doe@example.com / email");
    expect(label).not.toContain("jane.doe@example.com");
    expect(label).toContain("newsletter");
    expect(cleanLabel("x".repeat(200))).toHaveLength(80);
  });
});

describe("checkResult", () => {
  it("uses the registry severity for PASS and UNKNOWN and sorts days", () => {
    expect(
      checkResult("MH7", "PASS", { reason: "ok" }, { severity: "CRITICAL" }),
    ).toEqual({
      key: "MH7",
      status: "PASS",
      severity: "WARN",
      evidence: { reason: "ok" },
    });
    expect(
      checkResult(
        "MH1",
        "FAIL",
        { reason: "stopped" },
        {
          severity: "CRITICAL",
          days: ["2026-10-05", "2026-10-04", "2026-10-05"],
        },
      ).days,
    ).toEqual(["2026-10-04", "2026-10-05"]);
    expect(round3(0.12345)).toBe(0.123);
  });
});
