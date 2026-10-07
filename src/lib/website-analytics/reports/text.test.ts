import { describe, expect, it } from "vitest";

import { WEBSITE_REPORT_COPY } from "./copy";
import {
  sampleAlertCard,
  sampleMonthlyCard,
  samplePlanCard,
  samplePulseCard,
  sampleWeeklyCard,
  SAMPLE_SENSITIVE,
} from "./test-fixtures";
import {
  safeOperatorTitle,
  websiteReportChatDigest,
  websiteReportPlainText,
} from "./text";
import type {
  ReportAgentelseSection,
  WebsiteReportCardData,
} from "./types";

// Bu dosyanın kanıtladığı: sohbet özeti hassas metin taşımaz ve 1200
// karakteri geçmez; operatör başlığı bilinmeyen anahtarda "Finding"; düz
// metin anlatıyı ve anlık görüntü notunu içerir.

const CARDS: [string, () => WebsiteReportCardData][] = [
  ["weekly", sampleWeeklyCard],
  ["monthly", sampleMonthlyCard],
  ["plan", samplePlanCard],
  ["pulse", samplePulseCard],
  ["alert", sampleAlertCard],
];


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

describe("From Agentelse plain text", () => {
  it("is absent without a section", () => {
    expect(websiteReportPlainText(sampleWeeklyCard())).not.toContain(
      "From Agentelse",
    );
  });

  it("is written after the key events with tables and notes", () => {
    const text = websiteReportPlainText(weeklyWithSection());
    expect(text).toContain("From Agentelse");
    expect(text).toContain(
      "Tracked links (Sessions (GA4) · Engagement rate · Key events (GA4))",
    );
    expect(text).toContain("- Meta ads: <b>Spring</b> sale: 1,200 · 61.2% · 30");
    expect(text).toContain("- Other: 40 · – · 1");
    expect(text).toContain("Your ads on your website (Link clicks (Meta) · Sessions (GA4))");
    expect(text).toContain("  Only visits through links Agentelse tagged are counted.");
    expect(text.indexOf("Key events (")).toBeLessThan(
      text.indexOf("From Agentelse"),
    );
  });

  it("never reaches the chat digest", () => {
    const digest = websiteReportChatDigest(weeklyWithSection());
    expect(digest).toBe(websiteReportChatDigest(sampleWeeklyCard()));
    expect(digest).not.toContain("From Agentelse");
    expect(digest).not.toContain("Spring");
  });
});

describe("safeOperatorTitle", () => {
  it("falls back to Finding for unknown keys and kinds", () => {
    expect(safeOperatorTitle("UNKNOWN", "x")).toBe("Finding");
    expect(safeOperatorTitle("AN1", "x")).toBe("Finding");
    expect(safeOperatorTitle("", "")).toBe("Finding");
  });

  it("uses the registry title for known keys, without digits", () => {
    const title = safeOperatorTitle("AN3", "WIN");
    expect(title).not.toBe("Finding");
    expect(title).not.toMatch(/\d/);
    expect(safeOperatorTitle("AN3", "RISK")).not.toBe(title);
  });
});

describe("websiteReportChatDigest", () => {
  it.each(CARDS)("keeps sensitive text out of the %s digest", (_name, make) => {
    const digest = websiteReportChatDigest(make());
    expect(digest.length).toBeLessThanOrEqual(1200);
    expect(digest).not.toContain("/pricing");
    expect(digest).not.toContain(SAMPLE_SENSITIVE.searchTerm);
    expect(digest).not.toContain(SAMPLE_SENSITIVE.campaign);
    expect(digest).not.toContain(SAMPLE_SENSITIVE.eventName);
    expect(digest).not.toContain(SAMPLE_SENSITIVE.narrativeHeadline);
    expect(digest).not.toContain(SAMPLE_SENSITIVE.scriptLabel);
  });

  it("starts with the title and writes KPI lines with the comparison", () => {
    const card = sampleWeeklyCard();
    const digest = websiteReportChatDigest(card);
    const lines = digest.split("\n");
    expect(lines[0]).toBe(card.title);
    expect(lines).toContain("Sessions 4,760 (+10.7% vs the week before)");
    expect(digest).toContain("Engagement rate 56.4% (+");
  });

  it("names only default channels with their sessions", () => {
    const digest = websiteReportChatDigest(sampleWeeklyCard());
    expect(digest).toContain(
      "Top channels: Organic Search 2,100, Direct 1,200, Paid Search 900",
    );
  });

  it("writes goal lines with the pace in words", () => {
    expect(websiteReportChatDigest(sampleWeeklyCard())).toContain(
      "Goal Sessions: at risk",
    );
  });

  it("uses generic finding titles with counts", () => {
    const digest = websiteReportChatDigest(sampleWeeklyCard());
    expect(digest).toContain("What changed (2): ");
    expect(digest).toContain("Opportunities (2): ");
    expect(digest).not.toContain("Organic Search grew");
    expect(digest).not.toContain("Improve the checkout step");
  });

  it("writes plan target suggestions with their range", () => {
    const digest = websiteReportChatDigest(samplePlanCard());
    expect(digest).toContain(
      "Sessions target suggestion 21,000 (range 20,600–21,500)",
    );
    expect(digest).not.toContain("Best converting");
  });

  it("writes pulse numbers and only the alert count", () => {
    const card = samplePulseCard();
    const digest = websiteReportChatDigest(card);
    expect(digest).toMatch(/Sessions [\d,]+ \(usual [\d,]+\)/);
    if (card.body.variant !== "pulse") throw new Error("variant");
    const count = card.body.alerts.length;
    expect(digest).toContain(
      `${count} open tracking ${count === 1 ? "alert" : "alerts"}`,
    );
    for (const alert of card.body.alerts) {
      expect(digest).not.toContain(alert.title);
    }
  });

  it("writes the alert as a title and a generic body", () => {
    const card = sampleAlertCard();
    const digest = websiteReportChatDigest(card);
    expect(digest.split("\n")[0]).toBe(card.title);
    expect(digest).toContain(WEBSITE_REPORT_COPY.alertBody);
  });

  it("cuts a very long digest at 1200 characters", () => {
    const card = sampleWeeklyCard();
    if (card.body.variant !== "weekly") throw new Error("variant");
    const goal = card.body.goals[0];
    if (!goal) throw new Error("fixture");
    card.body.goals = Array.from({ length: 200 }, () => goal);
    expect(websiteReportChatDigest(card).length).toBe(1200);
  });
});

describe("websiteReportPlainText", () => {
  it("includes the narrative headline and the snapshot note", () => {
    const text = websiteReportPlainText(sampleWeeklyCard());
    expect(text).toContain(SAMPLE_SENSITIVE.narrativeHeadline);
    expect(text).toContain(WEBSITE_REPORT_COPY.narrativeLabel);
    expect(text).toContain(WEBSITE_REPORT_COPY.snapshotNote);
    expect(text.trimEnd().endsWith(WEBSITE_REPORT_COPY.snapshotNote)).toBe(
      true,
    );
  });

  it("writes tables as label: values and signs the change column", () => {
    const text = websiteReportPlainText(sampleWeeklyCard());
    expect(text).toContain("Channels (Sessions · Change · Share");
    expect(text).toContain("- Organic Search: 2,100 · +12.4% · 44.1%");
    expect(text).toContain("- Direct: 1,200 · -3.1%");
    // Önceki dönemi olmayan kanalın değişimi tire.
    expect(text).toContain(`- ${SAMPLE_SENSITIVE.scriptLabel}: 560 · –`);
  });

  it("lists findings with their detail and the source line", () => {
    const text = websiteReportPlainText(sampleWeeklyCard());
    expect(text).toContain("What changed");
    expect(text).toContain(
      "- Organic Search grew (Significant, Sep 28 – Oct 4)",
    );
    expect(text).toContain("Sessions rose from 1,200 to 1,480 on this page.");
    expect(text).toContain("Google Analytics, property time (Europe/Skopje).");
  });

  it("falls back to the narrative note when there is no narrative", () => {
    const text = websiteReportPlainText(
      sampleWeeklyCard({
        narrative: null,
        narrativeNote: WEBSITE_REPORT_COPY.narrativeDemo,
      }),
    );
    expect(text).toContain(WEBSITE_REPORT_COPY.narrativeDemo);
  });

  it.each(CARDS)("renders the %s card as readable text", (_name, make) => {
    const card = make();
    const text = websiteReportPlainText(card);
    expect(text.startsWith(card.title)).toBe(true);
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("[object");
  });

  it("writes plan targets, best pages and the quality table", () => {
    const text = websiteReportPlainText(samplePlanCard());
    expect(text).toContain("Suggested targets");
    expect(text).toContain("Sessions: suggested 21,000 (range 20,600–21,500");
    expect(text).toContain("Best converting pages");
    expect(text).toContain(`${SAMPLE_SENSITIVE.page}: 2,600 sessions`);
    expect(text).toContain("Channel quality");
  });

  it("writes the pulse unusual marker and open alerts", () => {
    const card = samplePulseCard();
    const text = websiteReportPlainText(card);
    if (card.body.variant !== "pulse") throw new Error("variant");
    expect(text).toContain("Yesterday");
    expect(text).toContain("Open tracking alerts");
    for (const alert of card.body.alerts) expect(text).toContain(alert.title);
  });
});
