import { describe, expect, it } from "vitest";

import type { GaParsedReport } from "@/lib/website-analytics/response";

import {
  evaluatePiiProbe,
  piiProbeRange,
  piiProbeRequest,
  PII_EMAIL_FILTER_REGEX,
  PII_PARAM_FILTER_REGEX,
} from "./pii-probe";
import type { GaPiiProbeResult } from "./types";

// Bu dosyanın kanıtladığı: istek gövdesi sözleşmedeki JSON'un birebiri
// (caseSensitive stringFilter'ın içinde); aralık zorlamada bugün, zamanlıda
// [bugün-7, dün], temiz zorlamalı yoklamadan sonra onun başlangıcından;
// değerlendirme %40 dahil e-postayı bulur, yalnız izinli parametre adlarını
// tutar, temiz yanıtta sıfırlar döner ve sonuçta değer asla bulunmaz.

const TODAY = "2026-10-06";

function probe(overrides: Partial<GaPiiProbeResult> = {}): GaPiiProbeResult {
  return {
    v: 1,
    at: "2026-10-04T10:00:00.000Z",
    from: "2026-10-04",
    to: "2026-10-04",
    forced: true,
    outcome: "ok",
    pages: 0,
    views: 0,
    params: [],
    email: false,
    phone: false,
    ...overrides,
  };
}

function report(rows: [string, number][]): GaParsedReport {
  return {
    dimensionHeaders: ["pagePathPlusQueryString"],
    metricHeaders: ["screenPageViews"],
    rows: rows.map(([path, views]) => ({
      dimensions: [path],
      metrics: [views],
    })),
    rowCount: rows.length,
    quality: {},
    propertyQuota: null,
  };
}

const INPUT = {
  at: "2026-10-06T09:00:00.000Z",
  from: "2026-09-29",
  to: "2026-10-05",
  forced: false,
};

describe("piiProbeRequest", () => {
  it("is exactly the contract JSON", () => {
    expect(PII_EMAIL_FILTER_REGEX).toBe(
      "[A-Za-z0-9._%+-]+(@|%40)[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
    );
    expect(PII_PARAM_FILTER_REGEX).toBe(
      "[?&](e-?mail|mail|phone|tel|mobile|(first_?|last_?)?name|token|password|pass|pwd)=",
    );
    expect(piiProbeRequest("2026-09-29", "2026-10-05")).toStrictEqual({
      dimensions: [{ name: "pagePathPlusQueryString" }],
      metrics: [{ name: "screenPageViews" }],
      dateRanges: [{ startDate: "2026-09-29", endDate: "2026-10-05" }],
      dimensionFilter: {
        orGroup: {
          expressions: [
            {
              filter: {
                fieldName: "pagePathPlusQueryString",
                stringFilter: {
                  matchType: "PARTIAL_REGEXP",
                  value: PII_EMAIL_FILTER_REGEX,
                  caseSensitive: false,
                },
              },
            },
            {
              filter: {
                fieldName: "pagePathPlusQueryString",
                stringFilter: {
                  matchType: "PARTIAL_REGEXP",
                  value: PII_PARAM_FILTER_REGEX,
                  caseSensitive: false,
                },
              },
            },
          ],
        },
      },
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: 100,
      returnPropertyQuota: true,
    });
  });
});

describe("piiProbeRange", () => {
  it("covers today when forced", () => {
    expect(
      piiProbeRange({ today: TODAY, force: true, previous: probe() }),
    ).toEqual({
      from: TODAY,
      to: TODAY,
    });
  });

  it("covers the last seven days up to yesterday when scheduled", () => {
    expect(
      piiProbeRange({ today: TODAY, force: false, previous: null }),
    ).toEqual({
      from: "2026-09-29",
      to: "2026-10-05",
    });
  });

  it("starts after a clean forced probe", () => {
    expect(
      piiProbeRange({ today: TODAY, force: false, previous: probe() }),
    ).toEqual({
      from: "2026-10-04",
      to: "2026-10-05",
    });
    // Bugünkü temiz zorlamalı yoklamadan sonra aralık tersine dönmez.
    expect(
      piiProbeRange({
        today: TODAY,
        force: false,
        previous: probe({ from: TODAY, to: TODAY }),
      }),
    ).toEqual({ from: "2026-10-05", to: "2026-10-05" });
  });

  it("rescans the whole week after a dirty or failed probe", () => {
    const week = { from: "2026-09-29", to: "2026-10-05" };
    for (const previous of [
      probe({ email: true }),
      probe({ phone: true }),
      probe({ params: ["email"] }),
      probe({ outcome: "error" }),
    ]) {
      expect(piiProbeRange({ today: TODAY, force: false, previous })).toEqual(
        week,
      );
    }
  });
});

describe("evaluatePiiProbe", () => {
  it("finds e-mails, including an encoded @", () => {
    const result = evaluatePiiProbe(
      report([
        ["/thanks?ref=jane.doe%40example.com", 4],
        ["/clean", 9],
      ]),
      INPUT,
    );
    expect(result).toEqual({
      v: 1,
      at: INPUT.at,
      from: INPUT.from,
      to: INPUT.to,
      forced: false,
      outcome: "ok",
      pages: 1,
      views: 4,
      params: [],
      email: true,
      phone: false,
    });
  });

  it("keeps only allow-listed parameter names, lower-cased", () => {
    const result = evaluatePiiProbe(
      report([
        ["/signup?First_Name=Jane&utm_source=x&Token=abc", 3],
        ["/form?username=jane&secret=1&phone=%2B905551112233", 2],
      ]),
      INPUT,
    );
    expect(result.params).toEqual(["first_name", "phone", "token"]);
    expect(result.phone).toBe(true);
    expect(result.pages).toBe(2);
    expect(result.views).toBe(5);
  });

  it("returns zeros for a clean report", () => {
    const result = evaluatePiiProbe(report([]), { ...INPUT, forced: true });
    expect(result).toMatchObject({
      outcome: "ok",
      forced: true,
      pages: 0,
      views: 0,
      params: [],
      email: false,
      phone: false,
    });
  });

  it("never carries the input values", () => {
    const result = evaluatePiiProbe(
      report([
        ["/a?email=jane.doe@example.com&name=Jane+Doe", 1],
        ["/b?tel=+90 555 111 22 33", 1],
      ]),
      INPUT,
    );
    const json = JSON.stringify(result);
    for (const fragment of ["jane", "Jane", "example", "555", "/a", "/b"]) {
      expect(json).not.toContain(fragment);
    }
    expect(result.params).toEqual(["email", "name", "tel"]);
  });
});
