import { describe, expect, it } from "vitest";

import {
  GaSubjects,
  gaFindingFingerprint,
  gaSignalExternalRef,
  isoWeekKey,
  periodOf,
  shadowRetiredFingerprint,
  subjectKeyOf,
  subjectLabelOf,
} from "./keys";

// Bu dosyanın kanıtladığı: konu özeti kararlı FNV-1a 64 (16 hex) ve yol
// taşımaz; ISO hafta anahtarı yıl sınırında doğru; dönem ve parmak izi
// biçimleri sözleşmeyle aynı; konu adları kullanıcıya uygun.

describe("subjectKeyOf", () => {
  it("is FNV-1a 64 (known vectors)", () => {
    expect(subjectKeyOf("")).toBe("cbf29ce484222325");
    expect(subjectKeyOf("a")).toBe("af63dc4c8601ec8c");
    expect(subjectKeyOf("foobar")).toBe("85944171f73967e8");
  });

  it("is stable, 16 hex chars and differs per subject", () => {
    const page = GaSubjects.page("/pricing");
    expect(subjectKeyOf(page)).toBe(subjectKeyOf("page:/pricing"));
    expect(subjectKeyOf(page)).toMatch(/^[0-9a-f]{16}$/);
    expect(subjectKeyOf(page)).not.toBe(
      subjectKeyOf(GaSubjects.page("/about")),
    );
    expect(subjectKeyOf(GaSubjects.site())).not.toBe(
      subjectKeyOf(GaSubjects.siteWeek()),
    );
    expect(subjectKeyOf("page:/ürün")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("isoWeekKey and periodOf", () => {
  it("handles year boundaries", () => {
    expect(isoWeekKey("2026-10-05")).toBe("2026-W41");
    expect(isoWeekKey("2026-12-31")).toBe("2026-W53");
    expect(isoWeekKey("2027-01-03")).toBe("2026-W53");
    expect(isoWeekKey("2027-01-04")).toBe("2027-W01");
  });

  it("builds period keys per grain", () => {
    expect(periodOf("DAY", { from: "2026-10-05", to: "2026-10-05" })).toEqual({
      grain: "DAY",
      from: "2026-10-05",
      to: "2026-10-05",
      key: "2026-10-05",
    });
    expect(periodOf("WEEK", { from: "2026-09-28", to: "2026-10-04" }).key).toBe(
      "2026-W40",
    );
    expect(
      periodOf("MONTH", { from: "2026-09-01", to: "2026-09-30" }).key,
    ).toBe("2026-09");
    expect(
      periodOf("WINDOW28", { from: "2026-09-07", to: "2026-10-04" }).key,
    ).toBe("2026-W40:28d");
    expect(
      periodOf("WEEK", { from: "2026-09-28", to: "2026-10-04" }, "wow").key,
    ).toBe("2026-W40:wow");
  });
});

describe("fingerprints and refs", () => {
  it("formats", () => {
    const fingerprint = gaFindingFingerprint({
      linkId: "l1",
      ruleKey: "AN3",
      subjectKey: "0123456789abcdef",
      periodKey: "2026-W40:28d",
    });
    expect(fingerprint).toBe("l1:AN3:0123456789abcdef:2026-W40:28d");
    expect(shadowRetiredFingerprint(fingerprint, "f1")).toBe(
      "l1:AN3:0123456789abcdef:2026-W40:28d#shadow:f1",
    );
    expect(
      gaSignalExternalRef({
        linkId: "l1",
        ruleKey: "AN2",
        subjectKey: "0123456789abcdef",
        periodEnd: "2026-10-04",
      }),
    ).toBe("ga:l1:AN2:0123456789abcdef:2026-W40");
  });
});

describe("GaSubjects and subjectLabelOf", () => {
  it("builds subjects and caps free text at 200 characters", () => {
    expect(GaSubjects.change("keyEvents", "wow")).toBe("site:keyEvents:wow");
    expect(GaSubjects.channel("Organic Search", "engagement")).toBe(
      "channel:Organic Search:engagement",
    );
    expect(GaSubjects.campaign("autumn", "news", "email")).toBe(
      "campaign:autumn|news|email",
    );
    expect(GaSubjects.funnel("add_to_cart", "begin_checkout")).toBe(
      "funnel:add_to_cart>begin_checkout",
    );
    expect(GaSubjects.goal("g1")).toBe("goal:g1");
    expect(GaSubjects.page(`/${"x".repeat(300)}`)).toHaveLength(
      "page:".length + 200,
    );
  });

  it("labels every subject kind", () => {
    expect(subjectLabelOf("site")).toBe("Your site");
    expect(subjectLabelOf("site:week")).toBe("Your site");
    expect(subjectLabelOf(GaSubjects.change("keyEvents", "wow"))).toBe(
      "Key events",
    );
    expect(subjectLabelOf(GaSubjects.change("sessions", "yoy"))).toBe("Visits");
    expect(subjectLabelOf(GaSubjects.change("revenue", "mom"))).toBe("Revenue");
    expect(subjectLabelOf(GaSubjects.page("/pricing"))).toBe("/pricing");
    expect(
      subjectLabelOf(GaSubjects.channel("Paid Search", "keyEventRate")),
    ).toBe("Paid Search");
    expect(subjectLabelOf(GaSubjects.campaign("autumn", "s", "m"))).toBe(
      "autumn",
    );
    expect(subjectLabelOf(GaSubjects.funnel("a", "b"))).toBe("a → b");
    expect(subjectLabelOf(GaSubjects.mobile())).toBe("Mobile");
    expect(subjectLabelOf(GaSubjects.returning())).toBe("Returning visitors");
    expect(subjectLabelOf(GaSubjects.ai())).toBe("AI assistants");
    expect(subjectLabelOf(GaSubjects.siteSearch())).toBe("Site search");
    expect(subjectLabelOf(GaSubjects.notFound())).toBe("Missing pages");
    expect(subjectLabelOf(GaSubjects.content())).toBe("Content");
    expect(subjectLabelOf(GaSubjects.goal("g1"))).toBe("Goal");
  });
});
