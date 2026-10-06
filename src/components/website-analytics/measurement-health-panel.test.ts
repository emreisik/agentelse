import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { gaCheckDef } from "@/lib/website-analytics/health/registry";
import type {
  GaCheckEvidence,
  GaCheckKey,
  GaCheckSeverity,
  GaCheckStatus,
} from "@/lib/website-analytics/health/types";
import type {
  MeasurementCheckView,
  MeasurementHealthView,
} from "@/lib/website-analytics/health/view-types";

// Bu dosyanın kanıtladığı (GA-F3 "Measurement health" paneli): CRITICAL
// satırlar önce; rehber adımları çizilir; Mute yalnız uyarı kimliği varsa;
// geçen ve kontrol edilemeyen sayıları; #measurement-health çapası; puan
// yokken "Checking…". Sunucu eylemleri ve ActionForm taklit edilir.

vi.mock("@/server/actions/measurement-health-actions", () => ({
  recheckMeasurementHealthAction: vi.fn(),
  muteMeasurementAlertAction: vi.fn(),
}));

// ActionForm geçirgen: başarı mesajını ve eylem adını işaretler.
vi.mock("@/components/shared/action-form", () => ({
  ActionForm: ({
    action,
    successMessage,
    children,
  }: {
    action: { getMockName?: () => string };
    successMessage?: string;
    children: ReactNode;
  }) =>
    createElement(
      "form",
      {
        "data-success": successMessage,
        "data-action": action?.getMockName?.() ?? "",
      },
      children,
    ),
}));

const { MeasurementHealthPanel } = await import("./measurement-health-panel");
const actions = await import("@/server/actions/measurement-health-actions");
vi.mocked(actions.recheckMeasurementHealthAction).mockName("recheck");
vi.mocked(actions.muteMeasurementAlertAction).mockName("mute");

function check(
  key: GaCheckKey,
  status: GaCheckStatus,
  patch: {
    severity?: GaCheckSeverity;
    evidence?: GaCheckEvidence;
    alertId?: string | null;
    title?: string;
  } = {},
): MeasurementCheckView {
  const def = gaCheckDef(key);
  return {
    key,
    code: def.code,
    title: patch.title ?? def.title,
    category: def.category,
    status,
    severity: patch.severity ?? def.defaultSeverity,
    evidence: patch.evidence ?? {
      reason: status === "UNKNOWN" ? "not_checked" : "ok",
    },
    guideId: def.guideId,
    alertId: patch.alertId ?? null,
    firstFailedAt: null,
    lastCheckedAt: "2026-10-06T10:00:00.000Z",
  };
}

function health(
  patch: Partial<MeasurementHealthView> = {},
): MeasurementHealthView {
  return {
    propertyId: "987654321",
    summary: {
      score: 38,
      tone: "error",
      label: "38/100",
      issues: 3,
      critical: 1,
      evaluatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    },
    checks: [
      check("MH5", "WARN", {
        severity: "WARN",
        evidence: { reason: "no_key_events", suggestions: ["generate_lead"] },
        title: "No key events are set up",
      }),
      check("MH14", "WARN", {
        severity: "INFO",
        evidence: { reason: "two_months" },
        title: "Google Analytics keeps event data for only two months",
      }),
      check("MH1", "FAIL", {
        severity: "CRITICAL",
        evidence: {
          reason: "stopped",
          mode: "day",
          day: "2026-10-05",
          sessions: 0,
          expected: 240,
          synthetic: true,
        },
        alertId: "alert-1",
        title: "Google Analytics stopped receiving data",
      }),
      check("MH2", "PASS"),
      check("MH3", "PASS"),
      check("MH13", "UNKNOWN", { evidence: { reason: "no_project_tz" } }),
    ],
    suspectDays: ["2026-10-05"],
    recheckAvailableAt: null,
    timeZone: "Europe/Istanbul",
    siteCheckedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    ...patch,
  };
}

const render = (view: MeasurementHealthView) =>
  renderToStaticMarkup(
    createElement(MeasurementHealthPanel, { projectId: "p1", health: view }),
  );

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&rsquo;|’/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("MeasurementHealthPanel", () => {
  it("anchors the section and labels it", () => {
    const html = render(health());
    expect(html).toContain('id="measurement-health"');
    expect(html).toContain('aria-labelledby="measurement-health-title"');
    expect(text(html)).toContain("Measurement health");
    expect(text(html)).toContain("38/100");
    expect(text(html)).toMatch(/Checked \d+ minutes ago/);
  });

  it("lists CRITICAL first, then WARN, then INFO", () => {
    const flat = text(render(health()));
    const critical = flat.indexOf("Google Analytics stopped receiving data");
    const warn = flat.indexOf("No key events are set up");
    const info = flat.indexOf("keeps event data for only two months");
    expect(critical).toBeGreaterThan(-1);
    expect(critical).toBeLessThan(warn);
    expect(warn).toBeLessThan(info);
    expect(flat).toContain(
      "Code MH1 No visits arrived on Oct 5 (usually about 240).",
    );
    expect(flat).toContain("Code MH5");
  });

  it("renders the fix guide with its steps and safe links", () => {
    const html = render(health());
    const flat = text(html);
    expect(flat).toContain("How to fix");
    expect(flat).toContain("Where: Admin → Data display → Events");
    expect(flat).toContain("Mark as key event");
    expect(html).toContain('href="https://tagassistant.google.com/"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });

  it("offers I fixed it on every issue and Mute only with an alert", () => {
    const html = render(health());
    const fixed = html.match(/>I fixed it</g) ?? [];
    expect(fixed).toHaveLength(3);
    const mutes = html.match(/>Mute 7 days</g) ?? [];
    expect(mutes).toHaveLength(1);
    expect(html).toContain('name="alertId" value="alert-1"');
    expect(html).toContain('name="checkKey" value="MH1"');
    expect(html).toContain('data-action="mute"');
    expect(html).toContain('data-success="Muted for 7 days"');
    expect(html.replace(/&#x27;/g, "'")).toContain(
      'data-success="Thanks — we checked again. We\'ll confirm with the next day\'s data."',
    );
  });

  it("shows the passed and couldn't-check counts and the footer", () => {
    const flat = text(render(health()));
    expect(flat).toContain("Couldn't check (1)");
    expect(flat).toContain("2 checks passed");
    expect(flat).toContain(
      "Left out of trends because of tracking problems: Oct 5.",
    );
    expect(flat).toMatch(
      /Site checked about 3 hours ago as AgentelseSiteCheck\./,
    );
    expect(flat).toContain(
      "Alerts also go to your project's Telegram when it is connected.",
    );
  });

  it("says no problems when nothing needs attention", () => {
    const flat = text(
      render(
        health({
          checks: [check("MH2", "PASS"), check("MH3", "PASS")],
          suspectDays: [],
          siteCheckedAt: null,
        }),
      ),
    );
    expect(flat).toContain("No tracking problems found.");
    expect(flat).not.toContain("I fixed it");
    expect(flat).not.toContain("Telegram");
    expect(flat).not.toContain("Left out of trends");
  });

  it("shows Checking… and Not checked yet before the first score", () => {
    const flat = text(
      render(
        health({
          summary: {
            score: null,
            tone: "unknown",
            label: "Checking…",
            issues: 0,
            critical: 0,
            evaluatedAt: null,
          },
          checks: [],
        }),
      ),
    );
    expect(flat).toContain("Checking…");
    expect(flat).toContain("Not checked yet");
  });

  it("disables Check again while a recheck is throttled", () => {
    const later = new Date(Date.now() + 5 * 60_000).toISOString();
    const html = render(health({ recheckAvailableAt: later }));
    expect(html).toContain('title="Available in a few minutes"');
    expect(html).toContain(
      'data-success="Checked again. Data checks update when new Google Analytics data arrives."',
    );
    const open = render(health({ recheckAvailableAt: null }));
    expect(open).not.toContain("Available in a few minutes");
  });

  it("never shows the property id", () => {
    expect(render(health())).not.toContain("987654321");
  });
});
