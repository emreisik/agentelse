import { describe, expect, it } from "vitest";

import {
  GA_ALERT_KINDS,
  GA_CHECK_REASONS,
  GA_CHECKS,
  GA_UNKNOWN_KEEP_OPEN_MS,
  gaAlertable,
  gaAlertDedupeKey,
  gaCheckDef,
  gaCheckKeyOfDedupeKey,
  gaIssueTitle,
  gaLinkIdOfDedupeKey,
  isGaCheckKey,
  unknownKeepsAlertOpen,
} from "./registry";
import { GA_SCORE_CATEGORY_WEIGHTS } from "./score";
import {
  GA_CHECK_KEYS,
  type GaCheckSeverity,
  type GaCheckStatus,
} from "./types";

// Kayıt sözleşmesi: sıra, kategori, tekil rehber/uyarı kimlikleri, neden
// kodları, rakamsız başlıklar, dedupe anahtarı ve UNKNOWN'ın uyarıyı en çok
// 48 saat açık tutması.

describe("GA check registry", () => {
  it("lists every key once, in GA_CHECK_KEYS order", () => {
    expect(GA_CHECKS.map((def) => def.key)).toEqual([...GA_CHECK_KEYS]);
  });

  it("uses only weighted categories and positive weights", () => {
    for (const def of GA_CHECKS) {
      expect(GA_SCORE_CATEGORY_WEIGHTS[def.category]).toBeGreaterThan(0);
      expect(def.weight).toBeGreaterThan(0);
    }
    expect(GA_SCORE_CATEGORY_WEIGHTS).toEqual({
      data_flow: 30,
      configuration: 20,
      attribution: 20,
      privacy: 15,
      site_tag: 10,
      other: 5,
    });
    expect(gaCheckDef("MH1_RT")).toMatchObject({
      code: "MH1",
      category: "data_flow",
      weight: 1,
      defaultSeverity: "CRITICAL",
    });
    expect(gaCheckDef("MH12")).toMatchObject({
      category: "privacy",
      weight: 3,
      defaultSeverity: "CRITICAL",
    });
  });

  it("has unique guide ids and alert kinds", () => {
    const guides = GA_CHECKS.map((def) => def.guideId);
    expect(new Set(guides).size).toBe(guides.length);
    expect(new Set(GA_ALERT_KINDS).size).toBe(GA_ALERT_KINDS.length);
    expect(gaCheckDef("MH1_RT").guideId).toBe("ga-mh1_rt");
    expect(gaCheckDef("MH1_RT").alertKind).toBe("GA_MH1_RT");
    for (const kind of GA_ALERT_KINDS)
      expect(kind.startsWith("GA_")).toBe(true);
  });

  it("recognises keys", () => {
    expect(isGaCheckKey("MH24")).toBe(true);
    expect(isGaCheckKey("MH25")).toBe(false);
    expect(isGaCheckKey(1)).toBe(false);
  });

  it("lists reasons for every key, including 'error' and 'ok'", () => {
    expect(Object.keys(GA_CHECK_REASONS).sort()).toEqual(
      [...GA_CHECK_KEYS].sort(),
    );
    for (const key of GA_CHECK_KEYS) {
      expect(GA_CHECK_REASONS[key]).toContain("error");
      expect(GA_CHECK_REASONS[key]).toContain("ok");
      expect(new Set(GA_CHECK_REASONS[key]).size).toBe(
        GA_CHECK_REASONS[key].length,
      );
    }
  });

  it("issue titles never contain a digit", () => {
    for (const key of GA_CHECK_KEYS) {
      for (const status of [
        "WARN",
        "FAIL",
        "PASS",
        "UNKNOWN",
      ] as GaCheckStatus[]) {
        for (const reason of [
          ...GA_CHECK_REASONS[key],
          null,
          "something_new",
        ]) {
          const title = gaIssueTitle(key, status, reason);
          expect(title.length).toBeGreaterThan(0);
          expect(title).not.toMatch(/\d/);
        }
      }
    }
  });

  it("picks issue titles by status and reason", () => {
    expect(gaIssueTitle("MH1", "FAIL", "stopped")).toBe(
      "Google Analytics stopped receiving data",
    );
    expect(gaIssueTitle("MH1", "WARN", "dropped")).toBe(
      "Website visits dropped sharply in Google Analytics",
    );
    expect(gaIssueTitle("MH3", "WARN", "missing")).toBe(
      "Google Analytics tag not found on the website",
    );
    expect(gaIssueTitle("MH3", "WARN", "unknown_reason")).toBe(
      "The website uses a different Google Analytics ID",
    );
    expect(gaIssueTitle("MH5", "WARN", "only_purchase")).toBe(
      "Only purchases are tracked as key events",
    );
    expect(gaIssueTitle("MH12", "WARN", "recent_history")).toBe(
      "Personal data was recently in page addresses",
    );
    expect(gaIssueTitle("MH12", "FAIL", "pii_in_url")).toBe(
      "Personal data may be in page addresses",
    );
    expect(gaIssueTitle("MH24", "FAIL", "auth")).toBe(
      "Google Analytics access was lost",
    );
    expect(gaIssueTitle("MH24", "WARN", "sync_late")).toBe(
      "Google Analytics updates are late",
    );
    expect(gaIssueTitle("MH24", "WARN", null)).toBe(
      "Google Analytics updates are failing",
    );
    expect(gaIssueTitle("MH7", "PASS", "ok")).toBe("Visits have a channel");
    expect(gaIssueTitle("MH7", "UNKNOWN", "low_volume")).toBe(
      "Visits have a channel",
    );
  });

  it("round-trips dedupe keys", () => {
    for (const key of GA_CHECK_KEYS) {
      const dedupeKey = gaAlertDedupeKey("link_1", key);
      expect(dedupeKey).toBe(`ga4:link_1:${key}`);
      expect(gaCheckKeyOfDedupeKey(dedupeKey)).toBe(key);
      expect(gaLinkIdOfDedupeKey(dedupeKey)).toBe("link_1");
    }
    for (const bad of [
      "gsc:link_1:MH1",
      "ga4:link_1:MH99",
      "ga4::MH1",
      "ga4:a:b:MH1",
      "MH1",
    ]) {
      expect(gaCheckKeyOfDedupeKey(bad)).toBeNull();
      expect(gaLinkIdOfDedupeKey(bad)).toBeNull();
    }
  });

  it("alerts only on WARN/FAIL with WARN or CRITICAL severity", () => {
    const statuses: GaCheckStatus[] = ["PASS", "WARN", "FAIL", "UNKNOWN"];
    const severities: GaCheckSeverity[] = ["INFO", "WARN", "CRITICAL"];
    for (const status of statuses) {
      for (const severity of severities) {
        expect(gaAlertable({ status, severity })).toBe(
          (status === "WARN" || status === "FAIL") && severity !== "INFO",
        );
      }
    }
  });

  it("keeps an alert open on UNKNOWN for at most 48 hours", () => {
    const now = new Date("2026-10-06T12:00:00Z");
    const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
    expect(GA_UNKNOWN_KEEP_OPEN_MS).toBe(48 * 3_600_000);
    expect(
      unknownKeepsAlertOpen(
        "MH1_RT",
        { status: "FAIL", lastChangedAt: ago(1) },
        now,
      ),
    ).toBe(false);
    expect(unknownKeepsAlertOpen("MH1_RT", null, now)).toBe(false);
    expect(unknownKeepsAlertOpen("MH1", null, now)).toBe(true);
    expect(
      unknownKeepsAlertOpen(
        "MH1",
        { status: "FAIL", lastChangedAt: ago(500) },
        now,
      ),
    ).toBe(true);
    expect(
      unknownKeepsAlertOpen(
        "MH1",
        { status: "WARN", lastChangedAt: ago(500) },
        now,
      ),
    ).toBe(true);
    expect(
      unknownKeepsAlertOpen(
        "MH1",
        { status: "UNKNOWN", lastChangedAt: ago(47) },
        now,
      ),
    ).toBe(true);
    expect(
      unknownKeepsAlertOpen(
        "MH1",
        { status: "UNKNOWN", lastChangedAt: ago(48) },
        now,
      ),
    ).toBe(false);
    expect(
      unknownKeepsAlertOpen(
        "MH1",
        { status: "PASS", lastChangedAt: ago(1) },
        now,
      ),
    ).toBe(false);
  });
});
