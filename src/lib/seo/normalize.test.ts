import { describe, expect, it } from "vitest";

import {
  mergeRows,
  normalizePageUrl,
  normalizeQueryText,
  pairKey,
  textHash,
} from "./normalize";

// Bu dosyanın kanıtladığı: sorgulardaki e-posta ve telefon maskelenir; sayfa
// adresi sorgu dizesini ve parçayı bırakır, kaynağı korur, anahtar benzeri
// yol parçalarını maskeler; geçersiz adres düşer; maskeden sonra aynı metne
// düşen satırlar toplanır; özetler kararlıdır.

describe("normalizeQueryText", () => {
  it("masks emails and phone numbers", () => {
    expect(normalizeQueryText("contact john.doe@example.com")).toBe(
      "contact [email]",
    );
    expect(normalizeQueryText("acme +90 555 123 45 67 support")).toBe(
      "acme [phone] support",
    );
  });

  it("collapses whitespace and drops empty text", () => {
    expect(normalizeQueryText("  çay   ışık  ")).toBe("çay ışık");
    expect(normalizeQueryText("   ")).toBeNull();
  });
});

describe("normalizePageUrl", () => {
  it("keeps the origin and drops the query string and fragment", () => {
    expect(
      normalizePageUrl("https://www.example.com/pricing?ref=abc#plans"),
    ).toEqual({
      url: "https://www.example.com/pricing",
      hash: textHash("https://www.example.com/pricing"),
      path: "/pricing",
      pageGroup: "/pricing",
      host: "www.example.com",
    });
  });

  it("masks token-like path segments and groups by the first segment", () => {
    const page = normalizePageUrl(
      "https://shop.example.com/reset/a1b2c3d4e5f6g7h8i9j0k1l2m3/done",
    )!;
    expect(page.path).toBe("/reset/[id]/done");
    expect(page.pageGroup).toBe("/reset");
    expect(page.url).toBe("https://shop.example.com/reset/[id]/done");
  });

  it("treats the home page as '/' and rejects invalid addresses", () => {
    expect(normalizePageUrl("https://example.com")).toMatchObject({
      path: "/",
      pageGroup: "/",
      url: "https://example.com/",
    });
    expect(normalizePageUrl("not a url")).toBeNull();
    expect(normalizePageUrl("mailto:someone@example.com")).toBeNull();
  });
});

describe("mergeRows", () => {
  it("sums rows that collapse to the same key after masking", () => {
    const rows = [
      "call +90 555 123 45 67",
      "call +90 555 765 43 21",
      "pricing",
    ].map((query, index) => {
      const text = normalizeQueryText(query)!;
      return {
        text,
        hash: textHash(text),
        clicks: index + 1,
        impressions: 10,
        positionWeighted: 20,
      };
    });
    const merged = mergeRows(rows, (row) => row.hash);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      text: "call [phone]",
      clicks: 3,
      impressions: 20,
      positionWeighted: 40,
    });
    expect(rows[0]!.clicks).toBe(1);
  });

  it("merges query×page pairs on both hashes", () => {
    const merged = mergeRows(
      [
        {
          key: pairKey("q", "p"),
          clicks: 1,
          impressions: 2,
          positionWeighted: 3,
        },
        {
          key: pairKey("q", "p"),
          clicks: 1,
          impressions: 2,
          positionWeighted: 3,
        },
        {
          key: pairKey("q", "x"),
          clicks: 1,
          impressions: 2,
          positionWeighted: 3,
        },
      ],
      (row) => row.key,
    );
    expect(merged.map((row) => row.clicks)).toEqual([2, 1]);
  });
});

describe("textHash", () => {
  it("is stable and 32 hex characters", () => {
    expect(textHash("acme shoes")).toBe(textHash("acme shoes"));
    expect(textHash("acme shoes")).not.toBe(textHash("acme shoe"));
    expect(textHash("acme shoes")).toMatch(/^[0-9a-f]{32}$/);
  });
});
