import { describe, expect, it } from "vitest";

import {
  MAX_SITE_ALERT_BRIEF_ROWS,
  siteAlertBriefRows,
} from "./site-alert-brief";

// Today özeti yalnız CRITICAL site uyarılarını, en çok ikisini, gelen sırayla
// ve doğru ekran bağlantısıyla gösterir.

describe("siteAlertBriefRows", () => {
  const alerts = [
    {
      id: "a1",
      source: "GA4" as const,
      severity: "WARN" as const,
      title: "Warn",
    },
    {
      id: "a2",
      source: "GA4" as const,
      severity: "CRITICAL" as const,
      title: "First",
    },
    {
      id: "a3",
      source: "SEO" as const,
      severity: "INFO" as const,
      title: "Info",
    },
    {
      id: "a4",
      source: "GSC" as const,
      severity: "CRITICAL" as const,
      title: "Second",
    },
    {
      id: "a5",
      source: "GA4" as const,
      severity: "CRITICAL" as const,
      title: "Third",
    },
  ];

  it("keeps only CRITICAL rows, at most two, in input order", () => {
    const rows = siteAlertBriefRows(alerts, {
      projectId: "p1",
      websitePage: true,
    });
    expect(MAX_SITE_ALERT_BRIEF_ROWS).toBe(2);
    expect(rows).toEqual([
      {
        id: "site-a2",
        source: "GA4",
        title: "First",
        severity: "CRITICAL",
        href: "/projects/p1/site#measurement-health",
      },
      {
        id: "site-a4",
        source: "GSC",
        title: "Second",
        severity: "CRITICAL",
        href: "/projects/p1/arama#health",
      },
    ]);
  });

  it("links GA4 to the Integrations dialog without the Website page", () => {
    const rows = siteAlertBriefRows(alerts, {
      projectId: "p1",
      websitePage: false,
    });
    expect(rows[0]!.href).toBe(
      "/projects/p1/integrations?integration=google_analytics",
    );
  });

  it("returns nothing without critical alerts", () => {
    expect(
      siteAlertBriefRows(
        alerts.filter((a) => a.severity !== "CRITICAL"),
        {
          projectId: "p1",
          websitePage: true,
        },
      ),
    ).toEqual([]);
  });
});
