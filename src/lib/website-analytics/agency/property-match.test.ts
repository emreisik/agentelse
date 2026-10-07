import { describe, expect, it } from "vitest";

import { suggestGaProperty } from "./property-match";

// Bu dosyanın kanıtladığı (GA-F8, toplu bağlama): otomatik mülk seçimi yalnız
// tek ve net kazananı döndürür; belirsizlikte null.

const props = [
  { propertyId: "1", propertyName: "Acme Shop", accountName: "Agency account" },
  { propertyId: "2", propertyName: "Birch Dental", accountName: "Agency account" },
  { propertyId: "3", propertyName: "Çiçek Evi", accountName: "Agency account" },
];

describe("suggestGaProperty", () => {
  it("returns null for an empty list", () => {
    expect(suggestGaProperty({ name: "Acme", domain: null }, [])).toBeNull();
  });

  it("matches the project name", () => {
    expect(suggestGaProperty({ name: "Birch Dental", domain: null }, props)).toBe("2");
  });

  it("matches the domain label", () => {
    expect(
      suggestGaProperty(
        { name: "Client 17", domain: "https://www.birch-dental.co.uk/contact" },
        props,
      ),
    ).toBe("2");
    expect(
      suggestGaProperty({ name: "Client 17", domain: "acmeshop.com" }, props),
    ).toBe("1");
  });

  it("folds accents and case", () => {
    expect(suggestGaProperty({ name: "CICEK EVI", domain: null }, props)).toBe("3");
    expect(suggestGaProperty({ name: "Çiçek evi", domain: null }, props)).toBe("3");
  });

  it("returns null when two properties are equally good", () => {
    const ambiguous = [
      { propertyId: "1", propertyName: "Acme Shop", accountName: "A" },
      { propertyId: "2", propertyName: "Acme Blog", accountName: "A" },
    ];
    expect(suggestGaProperty({ name: "Acme", domain: null }, ambiguous)).toBeNull();
  });

  it("returns null when nothing is close", () => {
    expect(suggestGaProperty({ name: "Zebra Studio", domain: "zebra.io" }, props)).toBeNull();
  });

  it("does not match on a very short fragment", () => {
    const short = [{ propertyId: "9", propertyName: "Abcdef Co", accountName: "A" }];
    expect(suggestGaProperty({ name: "ab", domain: null }, short)).toBeNull();
  });

  it("uses the account name only as weaker evidence", () => {
    const list = [
      { propertyId: "1", propertyName: "Main site", accountName: "Acme" },
      { propertyId: "2", propertyName: "Acme", accountName: "Other" },
    ];
    expect(suggestGaProperty({ name: "Acme", domain: null }, list)).toBe("2");
  });
});
