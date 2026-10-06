import { describe, expect, it } from "vitest";

import {
  parseGaPiiProbeResult,
  parseGaRealtimeState,
  parseGaSiteTagResult,
} from "./stored";

// Saklanan Json değerleri hoşgörüyle okunur: bozuk değer null, eksik
// boolean'lar false, parametre adları izin listesiyle süzülür.

const siteTag = {
  v: 1,
  at: "2026-10-06T10:00:00.000Z",
  host: "example.com",
  outcome: "ok",
  pagesChecked: 3,
  pagesFailed: 0,
  pagesWithExpected: 3,
  expectedId: "G-ABC",
  otherIds: [],
  gtm: false,
  googleTag: true,
  gtagJs: true,
  doubleLoad: false,
  consentDefault: true,
  cmp: "cookiebot",
  hints: {
    tel: true,
    whatsapp: false,
    mailto: false,
    form: true,
    maps: false,
    checkout: false,
  },
};

const pii = {
  v: 1,
  at: "2026-10-06T10:00:00.000Z",
  from: "2026-09-29",
  to: "2026-10-05",
  forced: true,
  outcome: "ok",
  pages: 2,
  views: 14,
  params: ["email"],
  email: true,
  phone: false,
};

describe("parseGaSiteTagResult", () => {
  it("round-trips a valid value", () => {
    expect(parseGaSiteTagResult(siteTag)).toEqual(siteTag);
  });

  it.each([
    null,
    undefined,
    3,
    "x",
    [],
    { ...siteTag, v: 2 },
    { ...siteTag, outcome: "nope" },
    { ...siteTag, pagesChecked: Number.NaN },
    { ...siteTag, at: 5 },
  ])("invalid input %# → null", (value) => {
    expect(parseGaSiteTagResult(value)).toBeNull();
  });

  it("defaults googleTag and hints to false and caps otherIds at five", () => {
    const rest: Record<string, unknown> = { ...siteTag };
    delete rest.googleTag;
    delete rest.hints;
    const parsed = parseGaSiteTagResult({
      ...rest,
      otherIds: ["G-6", "G-2", 7, "G-1", "G-5", "G-3", "G-4", "G-2"],
    });
    expect(parsed?.googleTag).toBe(false);
    expect(parsed?.hints).toEqual({
      tel: false,
      whatsapp: false,
      mailto: false,
      form: false,
      maps: false,
      checkout: false,
    });
    expect(parsed?.otherIds).toEqual(["G-1", "G-2", "G-3", "G-4", "G-5"]);
  });
});

describe("parseGaPiiProbeResult", () => {
  it("round-trips a valid value", () => {
    expect(parseGaPiiProbeResult(pii)).toEqual(pii);
  });

  it("keeps only allow-listed parameter names", () => {
    expect(
      parseGaPiiProbeResult({
        ...pii,
        params: [
          "email",
          "utm_source",
          "first_name",
          5,
          "pwd",
          "john@x.com",
          "email",
        ],
      })?.params,
    ).toEqual(["email", "first_name", "pwd"]);
  });

  it("requires valid from/to days and defaults forced to false", () => {
    expect(parseGaPiiProbeResult({ ...pii, from: "2026-9-1" })).toBeNull();
    expect(parseGaPiiProbeResult({ ...pii, to: undefined })).toBeNull();
    expect(parseGaPiiProbeResult({ ...pii, outcome: "maybe" })).toBeNull();
    expect(parseGaPiiProbeResult({ ...pii, views: Infinity })).toBeNull();
    const rest: Record<string, unknown> = { ...pii };
    delete rest.forced;
    expect(parseGaPiiProbeResult(rest)?.forced).toBe(false);
  });
});

describe("parseGaRealtimeState", () => {
  const state = {
    v: 1,
    day: "2026-10-06",
    zeros: 1,
    checks: 3,
    lastAt: "2026-10-06T10:00:00.000Z",
    lastActive: 0,
    expected: 300,
  };

  it("round-trips and rejects invalid values", () => {
    expect(parseGaRealtimeState(state)).toEqual(state);
    expect(parseGaRealtimeState({ ...state, day: "today" })).toBeNull();
    expect(parseGaRealtimeState({ ...state, zeros: "1" })).toBeNull();
    expect(parseGaRealtimeState(null)).toBeNull();
    expect(
      parseGaRealtimeState({
        ...state,
        lastAt: 1,
        lastActive: Number.NaN,
        expected: undefined,
      }),
    ).toEqual({ ...state, lastAt: null, lastActive: null, expected: null });
  });
});
