import { describe, expect, it } from "vitest";

import { WEBSITE_REPORT_COPY } from "./copy";
import {
  isExportableReport,
  websiteReportFileName,
  websiteReportMarkdown,
  websiteReportPrintHtml,
} from "./export";
import {
  SAMPLE_SENSITIVE,
  sampleAlertCard,
  sampleMonthlyCard,
  samplePlanCard,
  samplePulseCard,
  sampleWeeklyCard,
} from "./test-fixtures";
import type {
  ReportAgentelseSection,
  WebsiteReportCardData,
} from "./types";

// Kartın bir etiketini '|' içerecek şekilde değiştirir.
function withPipeInChannel(card: WebsiteReportCardData): WebsiteReportCardData {
  if (card.body.variant !== "monthly") throw new Error("aylık bekleniyordu");
  const [first, ...rest] = card.body.channels.rows;
  if (!first) throw new Error("kanal satırı bekleniyordu");
  return {
    ...card,
    body: {
      ...card.body,
      channels: {
        ...card.body.channels,
        rows: [{ ...first, label: "Email | Newsletter\nweekly" }, ...rest],
      },
    },
  };
}


// GA-F6 bölümü örneği: etiketlerden biri HTML karakteri taşır.
const AGENTELSE: ReportAgentelseSection = {
  tracked: {
    columns: [
      { label: "Sessions (GA4)", format: "count" },
      { label: "Engagement rate", format: "percent" },
      { label: "Key events (GA4)", format: "count" },
    ],
    rows: [{ label: "Meta ads: <b>Spring</b> sale", values: [1200, 61.2, 30] }],
    other: [40, null, 1],
    notes: [],
  },
  ads: {
    columns: [
      { label: "Link clicks (Meta)", format: "count" },
      { label: "Sessions (GA4)", format: "count" },
    ],
    rows: [{ label: "Spring sale", values: [900, 700] }],
    other: null,
    notes: [],
  },
  googleAds: null,
  notes: ["Only visits through links Agentelse tagged are counted."],
};

function weeklyWithSection(): WebsiteReportCardData {
  const card = sampleWeeklyCard();
  if (card.body.variant !== "weekly") throw new Error("variant");
  return { ...card, body: { ...card.body, agentelse: AGENTELSE } };
}

describe("From Agentelse export", () => {
  it("is absent when the card has no section", () => {
    const card = sampleWeeklyCard();
    expect(websiteReportMarkdown(card)).not.toContain("From Agentelse");
    expect(websiteReportPrintHtml(card)).not.toContain("From Agentelse");
  });

  it("adds a block after the key events table in Markdown", () => {
    const markdown = websiteReportMarkdown(weeklyWithSection());
    expect(markdown).toContain("## From Agentelse");
    expect(markdown).toContain("### Tracked links");
    expect(markdown).toContain("### Your ads on your website");
    expect(markdown).not.toContain("### Google Ads");
    expect(markdown).toContain("| Source | Sessions (GA4) | Engagement rate | Key events (GA4) |");
    expect(markdown).toContain("- Only visits through links Agentelse tagged are counted.");
    expect(markdown.indexOf("### Key events")).toBeLessThan(
      markdown.indexOf("## From Agentelse"),
    );
  });

  it("escapes labels in the print HTML", () => {
    const html = websiteReportPrintHtml(weeklyWithSection());
    expect(html).toContain("<h2>From Agentelse</h2>");
    expect(html).toContain("&lt;b&gt;Spring&lt;/b&gt;");
    expect(html).not.toContain("<b>Spring</b>");
  });
});

describe("websiteReportMarkdown", () => {
  const card = sampleMonthlyCard();
  const markdown = websiteReportMarkdown(card);

  it("başlık, meta satırı ve bölüm başlıklarını içerir", () => {
    expect(markdown.startsWith(`# ${card.title}\n`)).toBe(true);
    expect(markdown).toContain(
      `${card.propertyName} · ${card.periodLabel} · Google Analytics, property time (${card.timeZone})`,
    );
    expect(markdown).toContain("## Key numbers");
    expect(markdown).toContain("### Channels");
    expect(markdown).toContain("## Goals");
  });

  it("KPI tablosu sütunları ve ayırıcısı doğru", () => {
    expect(markdown).toContain(
      "| Metric | This period | Previous | Change | Last year |",
    );
    expect(markdown).toContain("| --- | ---: | ---: | ---: | ---: |");
    const sessions = card.body.variant === "monthly" ? card.body.kpis[0] : null;
    expect(sessions).toBeTruthy();
    expect(markdown).toMatch(/\| Sessions \| [\d,]+ \|/);
  });

  it("anlık görüntü notunu dipnot olarak taşır", () => {
    expect(markdown).toContain(WEBSITE_REPORT_COPY.snapshotNote);
    expect(markdown.endsWith("\n")).toBe(true);
  });

  it("'|' ve satır sonlarını hücrede kaçırır", () => {
    const text = websiteReportMarkdown(withPipeInChannel(card));
    expect(text).toContain("Email \\| Newsletter weekly");
    expect(text).not.toContain("Newsletter\nweekly");
  });

  it("ham HTML'i kaçırır", () => {
    const text = websiteReportMarkdown(sampleWeeklyCard());
    expect(text).toContain("\\<script>");
    // Kaçırılmamış '<' kalmaz.
    expect(text).not.toMatch(/(^|[^\\])</);
  });

  it("yapay zeka özeti işaretli ve metni içerir", () => {
    const text = websiteReportMarkdown(sampleWeeklyCard());
    expect(text).toContain("## Summary");
    expect(text).toContain("AI, checked against the numbers");
    expect(text).toContain(SAMPLE_SENSITIVE.narrativeHeadline);
  });

  it("marka satırı isteğe bağlıdır", () => {
    expect(websiteReportMarkdown(card)).not.toContain("Prepared for");
    expect(websiteReportMarkdown(card, { brand: "  Acme   Co " })).toContain(
      "Prepared for Acme Co",
    );
  });
});

describe("plan Markdown", () => {
  it("öneri tablosunu taşır", () => {
    const card = samplePlanCard();
    const markdown = websiteReportMarkdown(card);
    expect(markdown).toContain(
      "| Metric | Last 3 months | Seasonal | Suggested | Range | Current target |",
    );
    if (card.body.variant !== "plan") throw new Error("plan bekleniyordu");
    const first = card.body.proposals[0];
    expect(first).toBeTruthy();
    expect(markdown).toContain(`| ${first?.label} |`);
    expect(markdown).toContain("–");
  });
});

describe("pulse ve alert Markdown", () => {
  it("pulse kısa bir metin üretir", () => {
    const card = samplePulseCard();
    const markdown = websiteReportMarkdown(card);
    expect(markdown.startsWith(`# ${card.title}`)).toBe(true);
    expect(markdown).toContain("| Metric | Value | Usual | Change |");
  });

  it("alert kimlik kartı metnini taşır", () => {
    const card = sampleAlertCard();
    const markdown = websiteReportMarkdown(card);
    expect(markdown).toContain(card.title);
    expect(markdown).toContain(
      card.body.variant === "alert" && card.body.reconnect
        ? WEBSITE_REPORT_COPY.reconnectBody
        : WEBSITE_REPORT_COPY.alertBody,
    );
  });
});

describe("websiteReportPrintHtml", () => {
  const html = websiteReportPrintHtml(sampleWeeklyCard(), { brand: "Acme" });

  it("bağımsız belge, <header> ve başlık içerir", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<header>");
    expect(html).toContain("<h1>");
    expect(html).toContain("Prepared for Acme");
  });

  it("ham <script> içermez, Google'dan gelen metin kaçırılır", () => {
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("bölümler ve dipnot yazdırma görünümünde de var", () => {
    expect(html).toContain("<table>");
    expect(html).toContain("<footer>");
    expect(html).toContain(WEBSITE_REPORT_COPY.snapshotNote);
  });

  it("her varyant için üretilir", () => {
    for (const card of [
      samplePulseCard(),
      sampleAlertCard(),
      samplePlanCard(),
      sampleMonthlyCard(),
    ]) {
      const text = websiteReportPrintHtml(card);
      expect(text).toContain("<header>");
      expect(text).not.toContain("<script");
    }
  });
});

describe("websiteReportFileName", () => {
  it("her varyant için ASCII dosya adı üretir", () => {
    expect(websiteReportFileName(sampleWeeklyCard())).toBe(
      "website-report-weekly-2026-09-28.md",
    );
    expect(websiteReportFileName(sampleMonthlyCard())).toBe(
      "website-report-2026-09.md",
    );
    expect(websiteReportFileName(samplePlanCard())).toBe(
      "website-plan-2026-10.md",
    );
    expect(websiteReportFileName(samplePulseCard())).toBe(
      "website-pulse-2026-10-05.md",
    );
    expect(websiteReportFileName(sampleAlertCard())).toMatch(
      /^website-alert-\d{4}-\d{2}-\d{2}\.md$/,
    );
  });

  it("uzantı verilebilir ve temizlenir", () => {
    expect(websiteReportFileName(sampleWeeklyCard(), "html")).toBe(
      "website-report-weekly-2026-09-28.html",
    );
    expect(websiteReportFileName(sampleWeeklyCard(), "../x")).toBe(
      "website-report-weekly-2026-09-28.x",
    );
  });
});

describe("isExportableReport", () => {
  it("weekly, monthly ve plan dışa aktarılır; pulse ve alert aktarılmaz", () => {
    expect(isExportableReport(sampleWeeklyCard())).toBe(true);
    expect(isExportableReport(sampleMonthlyCard())).toBe(true);
    expect(isExportableReport(samplePlanCard())).toBe(true);
    expect(isExportableReport(samplePulseCard())).toBe(false);
    expect(isExportableReport(sampleAlertCard())).toBe(false);
  });
});
