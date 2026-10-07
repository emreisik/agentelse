import { describe, expect, it } from "vitest";

import { PLAN_EMPTY_REASONS } from "./types";
import {
  EMPTY_COPY,
  monthLabel,
  PLAN_COPY,
  SEO_CAP_MESSAGE,
  seoWriteHref,
  slotStateOf,
  STATE_LABEL,
  usageLine,
  whyLines,
} from "./view";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const HOUR = 3_600_000;
const FUTURE = new Date(NOW.getTime() + 48 * HOUR);
const SOON_PAST = new Date(NOW.getTime() - 2 * HOUR);
const PAST = new Date(NOW.getTime() - 48 * HOUR);

function state(
  creativeStatus: string | null,
  scheduledFor: Date | null,
  hasActiveCard = false,
  slotStatus: "PLANNED" | "SKIPPED" | "REMOVED" = "PLANNED",
) {
  return slotStateOf({ creativeStatus, scheduledFor, hasActiveCard, slotStatus, now: NOW });
}

describe("slotStateOf", () => {
  it("is SKIPPED for removed slots and missing, archived or rejected creatives", () => {
    expect(state("DRAFT", FUTURE, false, "SKIPPED")).toBe("SKIPPED");
    expect(state("APPROVED", FUTURE, false, "REMOVED")).toBe("SKIPPED");
    expect(state(null, FUTURE)).toBe("SKIPPED");
    expect(state("ARCHIVED", FUTURE)).toBe("SKIPPED");
    expect(state("REJECTED", FUTURE)).toBe("SKIPPED");
  });

  it("is PUBLISHED whenever published", () => {
    expect(state("PUBLISHED", FUTURE)).toBe("PUBLISHED");
    expect(state("PUBLISHED", PAST)).toBe("PUBLISHED");
    expect(state("PUBLISHED", null, true)).toBe("PUBLISHED");
  });

  it("splits APPROVED into SCHEDULED and OVERDUE by the date", () => {
    expect(state("APPROVED", FUTURE)).toBe("SCHEDULED");
    expect(state("APPROVED", null)).toBe("SCHEDULED");
    expect(state("APPROVED", SOON_PAST)).toBe("OVERDUE");
    expect(state("APPROVED", PAST, true)).toBe("OVERDUE");
  });

  it.each(["DRAFT", "IN_REVIEW"])("handles %s", (status) => {
    expect(state(status, FUTURE)).toBe("PLANNED");
    expect(state(status, FUTURE, true)).toBe("IN_PROGRESS");
    expect(state(status, PAST)).toBe("OVERDUE");
    expect(state(status, PAST, true)).toBe("IN_PROGRESS");
    // 24 saatten kısa gecikme hâlâ planlı
    expect(state(status, SOON_PAST)).toBe("PLANNED");
    expect(state(status, null)).toBe("PLANNED");
  });
});

describe("STATE_LABEL", () => {
  it("labels every state", () => {
    expect(STATE_LABEL).toEqual({
      PLANNED: "Planned",
      IN_PROGRESS: "Writing",
      SCHEDULED: "Scheduled",
      PUBLISHED: "Published",
      OVERDUE: "Overdue",
      SKIPPED: "Skipped",
    });
  });
});

describe("whyLines", () => {
  it("states the share, the gap and the rise", () => {
    expect(whyLines({ share: 0.08, gap: "NO_PAGE", rising: true })).toEqual([
      "About 8% of your non-brand search impressions",
      "No page on your site ranks in the top 20 for it yet",
      "Searches for it are rising",
    ]);
    expect(whyLines({ share: 0.004, gap: "NO_PILLAR", rising: false })).toEqual([
      "Under 1% of your non-brand search impressions",
      "Your site has no strong main page for this topic yet",
    ]);
  });

  it("never reveals more than three lines or a query", () => {
    const lines = whyLines({ share: 1, gap: "NO_PAGE", rising: true });
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[0]).toBe("About 100% of your non-brand search impressions");
  });
});

describe("EMPTY_COPY", () => {
  it("has a sentence for every empty reason", () => {
    for (const reason of PLAN_EMPTY_REASONS) {
      expect(EMPTY_COPY[reason].length).toBeGreaterThan(10);
    }
    expect(Object.keys(EMPTY_COPY).sort()).toEqual([...PLAN_EMPTY_REASONS].sort());
    expect(EMPTY_COPY.AI_LIMIT).toBe("The daily AI limit was reached. The plan comes tomorrow.");
    expect(EMPTY_COPY.NO_DATA).toBe(
      "Not enough search data yet. The plan starts once Search Console has a few weeks of data.",
    );
  });
});

describe("copy helpers", () => {
  it("builds the write link with an encoded idea id", () => {
    expect(seoWriteHref("p1", "idea-1")).toBe("/projects/p1?module=seo&idea=idea-1");
    expect(seoWriteHref("p1", "a b&c")).toBe("/projects/p1?module=seo&idea=a%20b%26c");
  });

  it("formats the month and the usage", () => {
    expect(monthLabel("2026-10")).toBe("October 2026");
    expect(monthLabel("2027-02")).toBe("February 2027");
    expect(monthLabel("junk")).toBe("junk");
    expect(monthLabel("2026-13")).toBe("2026-13");
    expect(usageLine(3, 4)).toBe("3 of 4 articles this month");
    expect(usageLine(0, 1)).toBe("0 of 1 article this month");
  });

  it("states the cap message exactly", () => {
    expect(SEO_CAP_MESSAGE(4)).toBe(
      "The limit of 4 articles for that month is reached. Change the limit on the Search page, or pick another month.",
    );
  });

  it("keeps the fixed button and note copy", () => {
    expect(PLAN_COPY.sectionTitle).toBe("This month's articles");
    expect(PLAN_COPY.noStrongMain).toBe("No strong main page yet");
    expect(PLAN_COPY.skipNote).toContain("three months");
    expect(PLAN_COPY.writeButton).toBe("Write this article");
  });
});
