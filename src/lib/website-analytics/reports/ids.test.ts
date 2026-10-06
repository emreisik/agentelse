import { describe, expect, it } from "vitest";

import {
  GA_RECONNECT_ALERT_KINDS,
  WEBSITE_REPORT_COMMAND_PREFIX,
  WEBSITE_WORK_MODULE,
  WEBSITE_WORK_PREFIX,
  WEBSITE_WORK_TITLE,
  alertHref,
  alertPeriodKey,
  reportCommandId,
  reportCommandPrefix,
  reportHrefs,
  variantOfCommandId,
  websiteWorkId,
} from "./ids";
import { WEBSITE_REPORT_VARIANTS } from "./types";

// Bu dosyanın kanıtladığı: komut ve Work kimlikleri belirlenimcidir, uyarı
// anahtarı şiddeti taşır, bağlantılar Website sayfası açık/kapalıya göre
// doğru yere gider ve sohbet bağlantısı kodlanır.

describe("ids", () => {
  it("builds the Work id", () => {
    expect(WEBSITE_WORK_PREFIX).toBe("wkga_");
    expect(WEBSITE_WORK_TITLE).toBe("Website analytics");
    expect(WEBSITE_WORK_MODULE).toBe("analytics");
    expect(websiteWorkId("p1")).toBe("wkga_p1");
  });

  it("builds deterministic command ids", () => {
    expect(WEBSITE_REPORT_COMMAND_PREFIX).toBe("garep_");
    expect(reportCommandPrefix("weekly")).toBe("garep_weekly_");
    expect(reportCommandId("weekly", "p1", "2026-09-28")).toBe(
      "garep_weekly_p1_2026-09-28",
    );
    expect(reportCommandId("monthly", "p1", "2026-09")).toBe(
      "garep_monthly_p1_2026-09",
    );
    expect(reportCommandId("pulse", "p1", "2026-10-05")).toBe(
      "garep_pulse_p1_2026-10-05",
    );
    expect(reportCommandId("plan", "p1", "2026-10")).toBe("garep_plan_p1_2026-10");
  });

  it("puts the severity into the alert key", () => {
    const at = new Date("2026-10-05T10:00:00.000Z");
    const key = alertPeriodKey("a1", at, "CRITICAL");
    expect(key).toBe(`a1_${at.getTime()}_CRITICAL`);
    expect(alertPeriodKey("a1", at, "WARN")).not.toBe(key);
    expect(reportCommandId("alert", "p1", key)).toBe(`garep_alert_p1_${key}`);
  });

  it("parses the variant back from a command id", () => {
    for (const variant of WEBSITE_REPORT_VARIANTS) {
      expect(variantOfCommandId(reportCommandId(variant, "p1", "x"))).toBe(
        variant,
      );
    }
    expect(variantOfCommandId("garep_other_p1_x")).toBeNull();
    expect(variantOfCommandId("cmd_weekly_p1")).toBeNull();
    expect(variantOfCommandId("")).toBeNull();
  });
});

describe("reportHrefs", () => {
  it("points at the Website page when it is on", () => {
    const h = reportHrefs("p1", true);
    expect(h.website).toBe("/projects/p1/site");
    expect(h.integrations).toBe(
      "/projects/p1/integrations?integration=google_analytics",
    );
    expect(h.measurement).toBe("/projects/p1/site#measurement-health");
    expect(h.insights).toBe("/projects/p1/site");
    expect(h.insights).not.toContain("#");
    expect(h.finding("f9")).toBe("/projects/p1/site#finding-f9");
    expect(h.goals).toBe("/projects/p1?panel=brand-brain&sub=goals");
    expect(h.settings).toBe(
      "/projects/p1?panel=settings&sub=autonomy#website-reports",
    );
  });

  it("falls back to the Integrations dialog when the page is off", () => {
    const h = reportHrefs("p1", false);
    expect(h.website).toBe(h.integrations);
    expect(h.measurement).toBe(h.integrations);
    expect(h.insights).toBe(h.integrations);
    expect(h.finding("f9")).toBe(h.integrations);
  });

  it("encodes the chat href", () => {
    expect(reportHrefs("p1", true).chat).toBe("/projects/p1?work=wkga_p1");
    expect(reportHrefs("a b/c", true).chat).toBe(
      "/projects/a b/c?work=wkga_a%20b%2Fc",
    );
  });
});

describe("alertHref", () => {
  it("sends reconnect kinds to Integrations and others to measurement", () => {
    const h = reportHrefs("p1", true);
    expect(GA_RECONNECT_ALERT_KINDS).toEqual(["GA_MH24"]);
    expect(alertHref("GA_MH24", h)).toBe(h.integrations);
    expect(alertHref("GA_MH1", h)).toBe(h.measurement);
  });
});
