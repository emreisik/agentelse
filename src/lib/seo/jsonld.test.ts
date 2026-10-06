import { describe, expect, it } from "vitest";

import { REQUIRED_PROPS, inspectJsonLd } from "./jsonld";

// Bu dosyanın kanıtladığı: bozuk JSON blok numarasıyla raporlanır; türler
// kökten, dizilerden ve @graph'tan toplanır; schema.org önekleri atılır;
// eksik temel alanlar ve @context yakalanır.

describe("inspectJsonLd", () => {
  it("reports invalid JSON by block number", () => {
    const result = inspectJsonLd([
      '{"@context":"https://schema.org","@type":"WebSite","name":"X"}',
      "{not json",
    ]);
    expect(result.errors).toEqual([
      "Structured data block 2 is not valid JSON",
    ]);
    expect(result.types).toEqual(["WebSite"]);
  });

  it("collects @graph types and checks required props", () => {
    const result = inspectJsonLd([
      JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Organization", name: "Acme" },
          { "@type": "Product" },
          { "@type": ["Article", "Thing"], headline: "" },
        ],
      }),
    ]);
    expect(result.types).toEqual([
      "Organization",
      "Product",
      "Article",
      "Thing",
    ]);
    expect(result.items).toEqual([
      { type: "Organization", missing: [] },
      { type: "Product", missing: ["name"] },
      { type: "Article", missing: ["headline"] },
    ]);
    expect(result.errors).toEqual([
      "Product is missing name",
      "Article is missing headline",
    ]);
  });

  it("strips schema.org prefixes", () => {
    const result = inspectJsonLd([
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "https://schema.org/Event",
        name: "Launch",
      }),
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "schema:WebSite",
        name: "X",
      }),
    ]);
    expect(result.types).toEqual(["Event", "WebSite"]);
    expect(result.errors).toEqual([
      "Event is missing startDate",
      "Event is missing location",
    ]);
  });

  it("flags a missing @context on root nodes, including root arrays", () => {
    const result = inspectJsonLd([
      JSON.stringify([
        { "@type": "WebSite", name: "X" },
        {
          "@context": "https://schema.org",
          "@type": "Organization",
          name: "Y",
        },
      ]),
    ]);
    expect(result.errors).toEqual(["Missing @context"]);
    expect(result.types).toEqual(["WebSite", "Organization"]);
  });

  it("ignores prototype keys as types and caps errors at 20", () => {
    expect(
      inspectJsonLd([
        JSON.stringify({ "@context": "x", "@type": "constructor" }),
      ]).items,
    ).toEqual([]);
    const blocks = Array.from({ length: 30 }, () => "nope");
    const errors = inspectJsonLd(blocks).errors;
    expect(errors).toHaveLength(20);
    expect(REQUIRED_PROPS.LocalBusiness).toEqual(["name", "address"]);
  });
});
