import { describe, expect, it } from "vitest";

import { encodeForm } from "./form";

describe("encodeForm", () => {
  it("encodes flat values", () => {
    expect(
      encodeForm({ mode: "subscription", quantity: 1, flag: true, off: false }),
    ).toBe("mode=subscription&quantity=1&flag=true&off=false");
  });

  it("skips null and undefined", () => {
    expect(encodeForm({ a: "x", b: null, c: undefined })).toBe("a=x");
  });

  it("nests objects with brackets and arrays with indexes", () => {
    expect(
      encodeForm({
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              recurring: { interval: "month" },
            },
          },
        ],
        metadata: { workspaceId: "w1" },
      }),
    ).toBe(
      "line_items[0][quantity]=1" +
        "&line_items[0][price_data][currency]=usd" +
        "&line_items[0][price_data][recurring][interval]=month" +
        "&metadata[workspaceId]=w1",
    );
  });

  it("percent-encodes values (including Stripe's session placeholder) but keeps brackets readable", () => {
    expect(
      encodeForm({
        success_url:
          "https://app.example.com/billing?tab=x&session_id={CHECKOUT_SESSION_ID}",
        name: "A & B = C",
      }),
    ).toBe(
      "success_url=https%3A%2F%2Fapp.example.com%2Fbilling%3Ftab%3Dx%26session_id%3D%7BCHECKOUT_SESSION_ID%7D" +
        "&name=A%20%26%20B%20%3D%20C",
    );
  });

  it("encodes odd characters inside keys", () => {
    expect(encodeForm({ metadata: { "a b": "1" } })).toBe("metadata[a%20b]=1");
  });

  it("drops null/undefined deep inside, keeps zero and the empty string", () => {
    expect(
      encodeForm({ a: { b: null, c: 0, d: "" }, e: [undefined, "x"] }),
    ).toBe("a[c]=0&a[d]=&e[1]=x");
  });

  it("refuses non-finite numbers", () => {
    expect(() => encodeForm({ amount: Number.NaN })).toThrow(RangeError);
    expect(() => encodeForm({ amount: Infinity })).toThrow(RangeError);
  });
});
