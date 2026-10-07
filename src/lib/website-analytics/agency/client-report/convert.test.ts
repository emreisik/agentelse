import { describe, expect, it } from "vitest";

import {
  sampleAlertCard,
  sampleMonthlyCard,
  samplePlanCard,
  samplePulseCard,
  sampleWeeklyCard,
} from "@/lib/website-analytics/reports/test-fixtures";
import type {
  ReportAgentelseSection,
  ReportTable,
  WebsiteReportCardData,
  WeeklyBody,
} from "@/lib/website-analytics/reports/types";

import type { ClientDoc } from "./document";
import { websiteCardToDocument } from "./convert";

// Bu dosyanın kanıtladığı: weekly/monthly/plan örnek kartları dönüşür; pulse,
// alert ve bozuk kart null; forShare site içi aramayı, Agentelse bölümünü,
// planı ve bulgudan türeyen sonraki adımları atar; hiçbir çıktı dizgesinde
// "Agentelse" kalmaz; para birimi biçimi; eksik tablolu ve ek mülk kartı da
// dönüşür; hiçbir blokta bağlantı yoktur.

const OPTIONS = { clientName: "Shop Ltd", agencyName: "Acme Digital" };
const share = { ...OPTIONS, forShare: true };
const exportOpts = { ...OPTIONS, forShare: false };

function agentelseSection(): ReportAgentelseSection {
  const table: ReportTable = {
    columns: [{ label: "Sessions", format: "count" }],
    rows: [{ label: "Agentelse post link", values: [42] }],
    other: null,
    notes: [],
  };
  return { tracked: table, ads: null, googleAds: null, notes: ["Made by Agentelse."] };
}

function weeklyWith(
  patch: Partial<WeeklyBody>,
  card: Partial<WebsiteReportCardData> = {},
): WebsiteReportCardData {
  const base = sampleWeeklyCard(card);
  return { ...base, body: { ...(base.body as WeeklyBody), ...patch } };
}

function strings(doc: ClientDoc): string[] {
  const out: string[] = [
    doc.title,
    doc.subtitle ?? "",
    doc.periodLabel,
    doc.clientName,
    ...doc.footnotes,
  ];
  for (const block of doc.blocks) {
    switch (block.type) {
      case "heading":
      case "paragraph":
        out.push(block.text);
        break;
      case "bullets":
        out.push(...block.items);
        break;
      case "kpis":
        for (const item of block.items) {
          out.push(item.label, item.value, item.delta ?? "");
        }
        break;
      case "table":
        out.push(block.title ?? "", ...block.columns, block.note ?? "");
        for (const row of block.rows) out.push(...row);
        break;
    }
  }
  return out;
}

const headings = (doc: ClientDoc) =>
  doc.blocks.flatMap((block) => (block.type === "heading" ? [block.text] : []));
const tableTitles = (doc: ClientDoc) =>
  doc.blocks.flatMap((block) => (block.type === "table" ? [block.title] : []));

describe("websiteCardToDocument", () => {
  it("converts a weekly card in the documented block order", () => {
    const doc = websiteCardToDocument(sampleWeeklyCard(), exportOpts);
    expect(doc).not.toBeNull();
    if (!doc) return;
    expect(doc.title).toBe("Weekly website report · Sep 28 – Oct 4");
    expect(doc.periodLabel).toBe("Sep 28 – Oct 4");
    expect(doc.subtitle).toBe("Example Shop · Shop Ltd");
    expect(doc.isDemo).toBe(false);
    expect(doc.blocks[0]).toEqual({
      type: "heading",
      text: "Key numbers",
      level: 2,
    });
    expect(doc.blocks[1]?.type).toBe("kpis");
    expect(headings(doc).slice(0, 2)).toEqual(["Key numbers", "Summary"]);
    expect(tableTitles(doc)).toEqual(
      expect.arrayContaining([
        "Channels",
        "Landing pages up",
        "Landing pages down",
        "Key events",
        "AI assistants",
      ]),
    );
    expect(headings(doc)).toEqual(
      expect.arrayContaining([
        "Measurement health",
        "What changed",
        "Opportunities",
        "Goals",
        "Month-end forecast",
        "Next steps",
      ]),
    );
    expect(doc.footnotes).toEqual([
      "This report keeps the numbers as they were when it was sent.",
      "Numbers from the last 7 days may still change slightly as Google finalizes them.",
    ]);
  });

  it("formats KPIs with the card currency and tones the change at +-1%", () => {
    const base = sampleWeeklyCard();
    const body = base.body as WeeklyBody;
    const card: WebsiteReportCardData = {
      ...base,
      currency: "EUR",
      body: {
        ...body,
        kpis: [
          {
            key: "revenue",
            label: "Revenue",
            format: "money",
            value: 1234.5,
            previous: 1000,
            changePct: 23.5,
            lastYear: null,
            lastYearChangePct: null,
          },
          {
            key: "sessions",
            label: "Sessions",
            format: "count",
            value: 100,
            previous: 101,
            changePct: -0.9,
            lastYear: 90,
            lastYearChangePct: 11.1,
          },
          {
            key: "keyEvents",
            label: "Key events",
            format: "count",
            value: 5,
            previous: 10,
            changePct: -50,
            lastYear: null,
            lastYearChangePct: null,
          },
          {
            key: "newUsers",
            label: "New users",
            format: "count",
            value: 5,
            previous: null,
            changePct: null,
            lastYear: null,
            lastYearChangePct: null,
          },
        ],
      },
    };
    const doc = websiteCardToDocument(card, exportOpts);
    const kpis = doc?.blocks.find((b) => b.type === "kpis");
    expect(kpis?.type === "kpis" && kpis.items).toEqual([
      {
        label: "Revenue",
        value: "1,234.50 EUR",
        delta: "+23.5% vs previous period",
        tone: "up",
      },
      {
        label: "Sessions",
        value: "100",
        delta: "-0.9% vs previous period · +11.1% vs last year",
        tone: "flat",
      },
      {
        label: "Key events",
        value: "5",
        delta: "-50% vs previous period",
        tone: "down",
      },
      { label: "New users", value: "5", delta: null, tone: null },
    ]);
  });

  it("converts a monthly card with top pages, paid traffic and outcomes", () => {
    const doc = websiteCardToDocument(sampleMonthlyCard(), exportOpts);
    expect(doc).not.toBeNull();
    if (!doc) return;
    expect(tableTitles(doc)).toEqual(
      expect.arrayContaining(["Top pages", "Paid traffic"]),
    );
    expect(headings(doc)).toContain("Results of earlier findings");
    expect(
      doc.blocks.some(
        (b) =>
          b.type === "paragraph" &&
          b.text === "1 worked, 0 didn't, 1 inconclusive.",
      ),
    ).toBe(true);
    // Aylıkta tahmin bölümü yoktur.
    expect(headings(doc)).not.toContain("Month-end forecast");
  });

  it("converts a plan card for the manager export only", () => {
    const doc = websiteCardToDocument(samplePlanCard(), exportOpts);
    expect(doc).not.toBeNull();
    expect(headings(doc ?? ({ blocks: [] } as unknown as ClientDoc))).toEqual(
      expect.arrayContaining(["Suggested targets", "Top opportunities"]),
    );
    expect(websiteCardToDocument(samplePlanCard(), share)).toBeNull();
  });

  it("returns null for pulse, alert and malformed cards", () => {
    expect(websiteCardToDocument(samplePulseCard(), exportOpts)).toBeNull();
    expect(websiteCardToDocument(sampleAlertCard(), exportOpts)).toBeNull();
    expect(
      websiteCardToDocument(null as unknown as WebsiteReportCardData, exportOpts),
    ).toBeNull();
    expect(
      websiteCardToDocument({} as unknown as WebsiteReportCardData, exportOpts),
    ).toBeNull();
    expect(
      websiteCardToDocument(
        { ...sampleWeeklyCard(), body: null } as unknown as WebsiteReportCardData,
        exportOpts,
      ),
    ).toBeNull();
    // Çeşit ile gövde uyuşmuyor.
    expect(
      websiteCardToDocument({ ...sampleWeeklyCard(), variant: "monthly" }, exportOpts),
    ).toBeNull();
  });

  it("keeps site search, the agency section and findings next steps in the manager export", () => {
    const card = weeklyWith({
      agentelse: agentelseSection(),
      nextStepsSource: "findings",
      nextSteps: ["Open the Website page."],
    });
    const doc = websiteCardToDocument(card, exportOpts);
    expect(tableTitles(doc ?? ({ blocks: [] } as unknown as ClientDoc))).toContain(
      "Site search",
    );
    // "From Agentelse" ajans adıyla yazılır.
    expect(headings(doc ?? ({ blocks: [] } as unknown as ClientDoc))).toContain(
      "From Acme Digital",
    );
    expect(headings(doc ?? ({ blocks: [] } as unknown as ClientDoc))).toContain(
      "Next steps",
    );
  });

  it("drops site search, the agency section, the plan and findings next steps when sharing", () => {
    const card = weeklyWith({
      agentelse: agentelseSection(),
      nextStepsSource: "findings",
      nextSteps: ["Open the Website page."],
    });
    const doc = websiteCardToDocument(card, share);
    expect(doc).not.toBeNull();
    if (!doc) return;
    expect(tableTitles(doc)).not.toContain("Site search");
    expect(headings(doc)).not.toContain("From Acme Digital");
    expect(headings(doc)).not.toContain("Next steps");
    const text = strings(doc).join("\n");
    expect(text).not.toContain("red running shoes");
    expect(text).not.toContain("Tracked links");
    expect(text).not.toContain("Open the Website page.");
  });

  it("keeps AI-written next steps when sharing", () => {
    const doc = websiteCardToDocument(sampleWeeklyCard(), share);
    expect(headings(doc ?? ({ blocks: [] } as unknown as ClientDoc))).toContain(
      "Next steps",
    );
  });

  it("never emits the word Agentelse, even from the title, narrative and notes", () => {
    const card = weeklyWith(
      { agentelse: agentelseSection(), notes: ["AGENTELSE note", "agentelse again"] },
      {
        title: "Agentelse weekly report",
        propertyName: "Agentelse Demo Shop",
        narrative: {
          headline: "Agentelse says sessions grew",
          highlights: ["Thanks to AGENTELSE posts"],
          watchouts: ["agentelse links broke"],
          nextSteps: [],
        },
      },
    );
    for (const opts of [exportOpts, share]) {
      const doc = websiteCardToDocument(card, {
        ...opts,
        clientName: "Agentelse Client",
      });
      expect(doc).not.toBeNull();
      if (!doc) continue;
      for (const text of strings(doc)) {
        expect(text.toLowerCase()).not.toContain("agentelse");
      }
      expect(doc.title).toBe("Acme Digital weekly report");
      expect(doc.blocks.some((b) => b.type === "paragraph" && b.text === "Acme Digital says sessions grew")).toBe(true);
    }
  });

  it("treats a $ in the agency name literally", () => {
    const doc = websiteCardToDocument(
      sampleWeeklyCard({ title: "Agentelse report" }),
      { ...share, agencyName: "A$& Co" },
    );
    expect(doc?.title).toBe("A$& Co report");
  });

  it("has no link or href anywhere", () => {
    for (const card of [sampleWeeklyCard(), sampleMonthlyCard()]) {
      const doc = websiteCardToDocument(card, exportOpts);
      expect(JSON.stringify(doc)).not.toMatch(/href|\/projects\/proj_1/);
    }
  });

  it("converts a card without any addon tables", () => {
    const empty: ReportTable = { columns: [], rows: [], other: null, notes: [] };
    const card = weeklyWith({
      channels: empty,
      keyEvents: empty,
      aiAssistants: null,
      siteSearch: null,
      measurement: null,
      winners: [],
      losers: [],
      whatChanged: [],
      opportunities: [],
      goals: [],
      forecasts: [],
      nextSteps: [],
      notes: [],
      kpis: undefined as unknown as WeeklyBody["kpis"],
    });
    const doc = websiteCardToDocument(card, exportOpts);
    expect(doc).not.toBeNull();
    expect(doc?.blocks.some((b) => b.type === "table")).toBe(false);
  });

  it("converts the card of an extra property", () => {
    const card = {
      ...sampleWeeklyCard({ linkId: "link_2", propertyName: "Second site" }),
      propertyId: "98765",
    } as WebsiteReportCardData;
    const doc = websiteCardToDocument(card, exportOpts);
    expect(doc?.subtitle).toBe("Second site · Shop Ltd");
  });

  it("flags demo data and omits the preliminary note when not preliminary", () => {
    const doc = websiteCardToDocument(
      sampleWeeklyCard({ isMock: true, preliminary: false }),
      exportOpts,
    );
    expect(doc?.isDemo).toBe(true);
    expect(doc?.footnotes).toHaveLength(1);
  });

  it("does not repeat the preliminary sentence from the card notes", () => {
    const card = weeklyWith({
      notes: [
        "Numbers from the last 7 days may still change slightly as Google finalizes them.",
        "Custom note",
      ],
    });
    const doc = websiteCardToDocument(card, exportOpts);
    const all = strings(doc ?? ({ blocks: [], footnotes: [] } as unknown as ClientDoc));
    expect(
      all.filter((text) => text.includes("may still change slightly as Google")),
    ).toHaveLength(1);
    expect(all).toContain("Custom note");
  });

  it("falls back to a neutral agency name when none is given", () => {
    const doc = websiteCardToDocument(
      sampleWeeklyCard({ title: "Agentelse report" }),
      { ...share, agencyName: "  " },
    );
    expect(doc?.title).toBe("Your agency report");
  });
});
