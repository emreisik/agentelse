import { describe, expect, it } from "vitest";

import { GA_MAX_EXTRA_PROPERTIES, gaEngineLinkWhere, isGaEngineLink } from "./scope";

// Bu dosyanın kanıtladığı: GA_AGENCY kapalıyken motor kapsamı birebir bugünkü
// `{ isPrimary: true }`; açıkken ana ya da ek mülk. Ek mülk ancak bayrak
// açıkken motor bağıdır; emekli bağ (ikisi de false) hiçbir zaman değildir.

const OFF = { GA_SYNC: "true" };
const ON = { GA_SYNC: "true", GA_AGENCY: "true" };

describe("gaEngineLinkWhere", () => {
  it("is exactly { isPrimary: true } with the flag off", () => {
    expect(gaEngineLinkWhere(OFF)).toStrictEqual({ isPrimary: true });
    expect(gaEngineLinkWhere({})).toStrictEqual({ isPrimary: true });
    // GA_AGENCY tek başına yetmez; GA_SYNC de gerekir.
    expect(gaEngineLinkWhere({ GA_AGENCY: "true" })).toStrictEqual({
      isPrimary: true,
    });
  });

  it("widens to primary-or-secondary with the flag on", () => {
    expect(gaEngineLinkWhere(ON)).toStrictEqual({
      OR: [{ isPrimary: true }, { isSecondary: true }],
    });
  });

  it("reads process.env at call time when no env is passed", () => {
    expect(gaEngineLinkWhere()).toStrictEqual({ isPrimary: true });
  });
});

describe("isGaEngineLink", () => {
  const matrix: [boolean, boolean, boolean, boolean][] = [
    // isPrimary, isSecondary, flag on, beklenen
    [true, false, false, true],
    [true, false, true, true],
    [false, true, false, false],
    [false, true, true, true],
    [false, false, false, false],
    [false, false, true, false],
  ];
  it.each(matrix)(
    "primary=%s secondary=%s agency=%s -> %s",
    (isPrimary, isSecondary, agency, expected) => {
      expect(isGaEngineLink({ isPrimary, isSecondary }, agency ? ON : OFF)).toBe(
        expected,
      );
    },
  );
});

describe("GA_MAX_EXTRA_PROPERTIES", () => {
  it("allows four extra properties", () => {
    expect(GA_MAX_EXTRA_PROPERTIES).toBe(4);
  });
});
