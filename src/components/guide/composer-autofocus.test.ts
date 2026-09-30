import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { composerAutoFocus } from "./composer-autofocus";

// G76: the truth table of (requested x coarsePointer x hasHost).
describe("composerAutoFocus (G76)", () => {
  const cases: Array<[boolean, boolean, boolean, boolean]> = [
    // requested, coarse, hasHost -> focus
    [false, false, false, true],
    [false, true, false, true],
    [true, false, false, true],
    [true, true, false, true],
    [false, false, true, true],
    [false, true, true, false],
    [true, false, true, false],
    [true, true, true, false],
  ];

  it.each(cases)(
    "requested=%s coarse=%s hasHost=%s -> %s",
    (requested, coarsePointer, hasHost, expected) => {
      expect(composerAutoFocus({ requested, coarsePointer, hasHost })).toBe(
        expected,
      );
    },
  );

  it("flag off (no host) keeps today's behaviour: always true", () => {
    for (const requested of [true, false]) {
      for (const coarsePointer of [true, false]) {
        expect(
          composerAutoFocus({ requested, coarsePointer, hasHost: false }),
        ).toBe(true);
      }
    }
  });

  it("is a plain function of its arguments (same input, same answer)", () => {
    const input = { requested: false, coarsePointer: true, hasHost: true };
    expect(composerAutoFocus(input)).toBe(composerAutoFocus({ ...input }));
  });

  it("stays import-free so the static chat bundle does not pull the sheet", () => {
    const source = readFileSync(
      path.join(__dirname, "composer-autofocus.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/^\s*import\s/mu);
    expect(source).not.toMatch(/\brequire\(/u);
  });
});
