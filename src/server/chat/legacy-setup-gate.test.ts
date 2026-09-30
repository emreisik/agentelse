import { describe, expect, it } from "vitest";

import {
  type GateInput,
  needsGuidedAppliedLookup,
  rawLegacyPhase,
  resolveLegacySetupPhase,
} from "./legacy-setup-gate";

// The legacy chat interviews a project that has no setup row. Guided setup
// never creates one, so with the flag on this resolver is what stops the
// interview after the sheet; with the flag off it must return exactly today's
// value for every possible row.

const done = new Date();

const rows: [string, GateInput["row"]][] = [
  ["none", null],
  ["FULL running", { activatedAt: null }],
  ["FULL running (mode FULL)", { activatedAt: null, mode: "FULL" }],
  ["ENRICHMENT running", { activatedAt: null, mode: "ENRICHMENT" }],
  ["activated", { activatedAt: done, mode: "FULL" }],
];

const on = (
  row: GateInput["row"],
  profileReady: boolean,
  guidedApplied: boolean,
) =>
  resolveLegacySetupPhase({ enabled: true, row, profileReady, guidedApplied });

describe("flag off", () => {
  for (const [name, row] of rows) {
    for (const profileReady of [false, true]) {
      for (const guidedApplied of [false, true]) {
        it(`is exactly today's value: ${name}, profile=${profileReady}, applied=${guidedApplied}`, () => {
          expect(
            resolveLegacySetupPhase({
              enabled: false,
              row,
              profileReady,
              guidedApplied,
            }),
          ).toBe(rawLegacyPhase(row));
        });
      }
    }
  }
});

describe("today's derivation", () => {
  it("reads no row as NOT_STARTED, an unfinished row as IN_PROGRESS, a finished one as ACTIVE", () => {
    expect(rawLegacyPhase(null)).toBe("NOT_STARTED");
    expect(rawLegacyPhase({ activatedAt: null })).toBe("IN_PROGRESS");
    expect(rawLegacyPhase({ activatedAt: done })).toBe("ACTIVE");
  });
});

describe("flag on", () => {
  it("keeps the interview for a project that has no profile and was not set up", () => {
    expect(on(null, false, false)).toBe("NOT_STARTED");
  });

  it("stops interviewing a project that already has a profile", () => {
    expect(on(null, true, false)).toBe("ACTIVE");
  });

  it("stops interviewing after the sheet was applied, even without a constitution", () => {
    expect(on(null, false, true)).toBe("ACTIVE");
  });

  it("still holds a running FULL pipeline as IN_PROGRESS, whatever else is true", () => {
    expect(on({ activatedAt: null }, true, true)).toBe("IN_PROGRESS");
  });

  it("never blocks on deep research (an ENRICHMENT run)", () => {
    expect(on({ activatedAt: null, mode: "ENRICHMENT" }, false, false)).toBe(
      "ACTIVE",
    );
  });

  it("keeps an activated project ACTIVE", () => {
    expect(on({ activatedAt: done }, false, false)).toBe("ACTIVE");
  });
});

describe("the extra lookup", () => {
  it("is asked for only when it can change the answer", () => {
    expect(
      needsGuidedAppliedLookup({
        enabled: true,
        row: null,
        profileReady: false,
      }),
    ).toBe(true);
  });

  it("is skipped when a profile already answers the question", () => {
    expect(
      needsGuidedAppliedLookup({
        enabled: true,
        row: null,
        profileReady: true,
      }),
    ).toBe(false);
  });

  it("is skipped when a setup row exists", () => {
    expect(
      needsGuidedAppliedLookup({
        enabled: true,
        row: { activatedAt: null },
        profileReady: false,
      }),
    ).toBe(false);
  });

  it("is skipped when the flag is off, so nothing extra runs on the old path", () => {
    expect(
      needsGuidedAppliedLookup({
        enabled: false,
        row: null,
        profileReady: false,
      }),
    ).toBe(false);
  });
});
