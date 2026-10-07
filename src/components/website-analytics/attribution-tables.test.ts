import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DisplayTable } from "@/lib/website-analytics/attribution/view-format";

import { AttributionTableCard } from "./attribution-tables";

// Bu dosyanın kanıtladığı: başlıklar, hücreler, bayrak çipleri, "diğer" satırı
// ve boş metin çizilir; Google kaynaklı etiketler HTML olarak yorumlanmaz.

function table(overrides: Partial<DisplayTable> = {}): DisplayTable {
  return {
    title: "Your ads on your website",
    hint: "Meta counts results differently.",
    firstColumn: "Campaign",
    columns: [{ label: "Spend (Meta)" }, { label: "Sessions (GA4)" }],
    rows: [
      {
        key: "meta:1",
        label: "Spring sale",
        sublabel: "Purchases",
        cells: ["120.50 EUR", "700"],
        flags: [
          { label: "Many clicks never arrive", tone: "warn" },
          { label: "Meta and GA4 counts differ", tone: "info" },
        ],
      },
    ],
    other: { label: "Other tagged links", cells: ["—", "10"] },
    notes: ["A note."],
    empty: "Nothing here yet.",
    ...overrides,
  };
}

const render = (value: DisplayTable) =>
  renderToStaticMarkup(createElement(AttributionTableCard, { table: value }));

describe("AttributionTableCard", () => {
  it("prints the title, hint, headers and cells", () => {
    const html = render(table());
    expect(html).toContain("Your ads on your website");
    expect(html).toContain("Meta counts results differently.");
    expect(html).toContain(">Campaign<");
    expect(html).toContain(">Spend (Meta)<");
    expect(html).toContain(">Sessions (GA4)<");
    expect(html).toContain(">120.50 EUR<");
    expect(html).toContain(">Purchases<");
    expect(html).toContain("A note.");
  });

  it("prints the flags as chips and the other row", () => {
    const html = render(table());
    expect(html).toContain("Many clicks never arrive");
    expect(html).toContain("Meta and GA4 counts differ");
    expect(html).toContain("text-amber-700");
    expect(html).toContain("Other tagged links");
  });

  it("prints the empty text and no table without rows", () => {
    const html = render(table({ rows: [], other: null, notes: [] }));
    expect(html).toContain("Nothing here yet.");
    expect(html).not.toContain("<table");
  });

  it("escapes campaign names", () => {
    const html = render(
      table({
        rows: [
          {
            key: "x",
            label: "<script>alert(1)</script>",
            sublabel: null,
            cells: ["1", "2"],
            flags: [],
          },
        ],
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
