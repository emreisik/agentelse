import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { APPROVE_ABOVE_MIN_USD } from "./approval-threshold";
import { APPROVE_ABOVE_ABSOLUTE_MAX_USD } from "./user-limits";

// The clamp in user-limits.ts must stay inside the database CHECK; otherwise a value the
// settings form accepts is rejected on write (a 500 instead of a saved setting).
describe("approval size bounds and the database constraint", () => {
  it("the code's absolute bounds are the constraint's bounds", () => {
    const sql = readFileSync(
      path.join(
        process.cwd(),
        "prisma/migrations/20261009140000_add_approve_above/migration.sql",
      ),
      "utf8",
    );
    const match =
      /"approveAboveUsd" >= ([0-9.]+) AND "approveAboveUsd" <= ([0-9.]+)/.exec(
        sql,
      );
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(APPROVE_ABOVE_MIN_USD);
    expect(Number(match![2])).toBe(APPROVE_ABOVE_ABSOLUTE_MAX_USD);
  });
});
