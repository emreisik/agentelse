import { describe, expect, it } from "vitest";

import { containsGooglePii, maskGooglePath, maskGoogleText } from "./pii";

// Bu dosyanın kanıtladığı: sayfa yollarında ve başlıklarda e-posta, telefon
// ve anahtar benzeri parçalar saklanmadan önce maskelenir; okunur adres
// parçaları (slug) ve ürün numaraları olduğu gibi kalır.

describe("maskGooglePath", () => {
  it("drops the query string and masks emails, phones and tokens", () => {
    expect(maskGooglePath("/thanks?email=jane@example.com")).toBe("/thanks");
    expect(maskGooglePath("/unsubscribe/jane%40example.com")).toBe(
      "/unsubscribe/[email]",
    );
    expect(maskGooglePath("/call/+90 555 123 45 67")).toBe("/call/[phone]");
    expect(maskGooglePath("/reset/a8F3kq9ZpL2mN7xR4tV6yB1c")).toBe(
      "/reset/[id]",
    );
    expect(maskGooglePath("/order/3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c")).toBe(
      "/order/[id]",
    );
  });

  it("keeps readable slugs and product numbers", () => {
    expect(maskGooglePath("/blog/how-to-choose-running-shoes-2026-guide")).toBe(
      "/blog/how-to-choose-running-shoes-2026-guide",
    );
    expect(maskGooglePath("/product/12345678901234")).toBe(
      "/product/12345678901234",
    );
    expect(maskGooglePath("/")).toBe("/");
  });
});

describe("maskGoogleText and containsGooglePii", () => {
  it("masks personal details in titles", () => {
    expect(maskGoogleText("Order  for  jane@example.com ")).toBe(
      "Order for [email]",
    );
  });

  it("finds personal data anywhere in an address", () => {
    expect(containsGooglePii("/thanks?email=jane@example.com")).toBe(true);
    expect(containsGooglePii("/reset/a8F3kq9ZpL2mN7xR4tV6yB1c")).toBe(true);
    expect(containsGooglePii("/pricing")).toBe(false);
  });
});
