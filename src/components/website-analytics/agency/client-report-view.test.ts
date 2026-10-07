import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { websiteCardToDocument } from "@/lib/website-analytics/agency/client-report/convert";
import type { ClientDoc } from "@/lib/website-analytics/agency/client-report/document";
import {
  sampleMonthlyCard,
  sampleWeeklyCard,
} from "@/lib/website-analytics/reports/test-fixtures";

import { ClientReportView } from "./client-report-view";

// Bu dosyanın kanıtladığı (GA-F8 ClientReportView): her blok türü çizilir;
// düşman dizgeler kaçırılır; "Demo data" notu; hiçbir bağlantı (anchor) yok.

const render = (doc: ClientDoc) =>
  renderToStaticMarkup(createElement(ClientReportView, { doc }));

function doc(patch: Partial<ClientDoc> = {}): ClientDoc {
  return {
    title: "Weekly",
    subtitle: "Example Shop",
    periodLabel: "Sep 28 – Oct 4",
    clientName: "Shop",
    builtAt: "2026-10-05T07:30:00.000Z",
    isDemo: false,
    blocks: [
      { type: "heading", text: "Key numbers", level: 2 },
      {
        type: "kpis",
        items: [
          { label: "Sessions", value: "4,760", delta: "+10.7% vs previous period", tone: "up" },
          { label: "Bounce", value: "40%", delta: "-5% vs previous period", tone: "down" },
          { label: "Users", value: "3,100", delta: "+0.2% vs previous period", tone: "flat" },
          { label: "Revenue", value: "—", delta: null, tone: null },
        ],
      },
      { type: "heading", text: "Watch-outs", level: 3 },
      { type: "paragraph", text: "A plain paragraph" },
      { type: "paragraph", text: "A muted one", muted: true },
      { type: "bullets", items: ["first", "second"] },
      {
        type: "table",
        title: "Channels",
        columns: ["Channel", "Sessions"],
        rows: [
          ["Organic", "2,100"],
          ["Direct", "1,200"],
        ],
        note: "Capped at eight rows.",
      },
    ],
    footnotes: ["Snapshot note.", "Preliminary note."],
    ...patch,
  };
}

describe("ClientReportView", () => {
  it("renders every block type", () => {
    const html = render(doc());
    expect(html).toContain("<h2");
    expect(html).toContain(">Key numbers<");
    expect(html).toContain("<h3");
    expect(html).toContain(">Watch-outs<");
    expect(html).toContain("A plain paragraph");
    expect(html).toMatch(/<p class="[^"]*italic[^"]*">A muted one<\/p>/);
    expect(html).toContain("<li>first</li>");
    expect(html).toContain("<table");
    expect(html).toContain('scope="col"');
    expect(html).toContain(">Channels<");
    expect(html).toContain("Capped at eight rows.");
    expect(html).toContain(">4,760<");
    expect(html).toContain("+10.7% vs previous period");
    expect(html).toContain("<footer");
    expect(html).toContain("Snapshot note.");
    expect(html).toContain("Preliminary note.");
    expect(html).toContain("Example Shop");
  });

  it("tells screen readers the direction of a change", () => {
    const html = render(doc());
    expect(html).toContain("Up: ");
    expect(html).toContain("Down: ");
    expect(html).toContain("Unchanged: ");
  });

  it("escapes hostile strings everywhere", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const html = render(
      doc({
        subtitle: evil,
        blocks: [
          { type: "heading", text: evil, level: 2 },
          { type: "paragraph", text: evil },
          { type: "bullets", items: [evil] },
          { type: "kpis", items: [{ label: evil, value: evil, delta: evil, tone: "up" }] },
          { type: "table", title: evil, columns: [evil, evil], rows: [[evil, evil]], note: evil },
        ],
        footnotes: [evil],
      }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes the script label of a converted card", () => {
    const converted = websiteCardToDocument(sampleWeeklyCard(), {
      clientName: "Shop",
      agencyName: "Acme",
      forShare: true,
    });
    expect(converted).not.toBeNull();
    const html = render(converted as ClientDoc);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("shows a Demo data note only for demo documents", () => {
    expect(render(doc({ isDemo: true }))).toContain("Demo data");
    expect(render(doc({ isDemo: true, subtitle: null }))).toContain("Demo data");
    expect(render(doc())).not.toContain("Demo data");
  });

  it("renders no anchor, form or script, also for a whole converted report", () => {
    for (const card of [sampleWeeklyCard(), sampleMonthlyCard()]) {
      const converted = websiteCardToDocument(card, {
        clientName: "Shop",
        agencyName: "Acme",
        forShare: false,
      }) as ClientDoc;
      const html = render(converted);
      expect(html).not.toMatch(/<a[\s>]/);
      expect(html).not.toContain("href=");
      expect(html).not.toMatch(/<(form|script|button)/);
    }
  });

  it("renders an empty document without a footer", () => {
    const html = render(doc({ blocks: [], footnotes: [], subtitle: null }));
    expect(html).not.toContain("<footer");
  });

  it("accepts a labels override", () => {
    const html = renderToStaticMarkup(
      createElement(ClientReportView, {
        doc: doc({ isDemo: true }),
        labels: { "view.demoData": "Demodaten" },
      }),
    );
    expect(html).toContain("Demodaten");
  });
});
