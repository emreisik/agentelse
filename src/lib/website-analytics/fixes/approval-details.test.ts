import { describe, expect, it } from "vitest";
import { gaFixApprovalDetails } from "./approval-details";

describe("gaFixApprovalDetails", () => {
  it("geçerli yükü okur", () => {
    expect(
      gaFixApprovalDetails({
        details: [
          { label: "What happens", value: "x" },
          { label: "Where", value: "Your Google Analytics property" },
        ],
      }),
    ).toEqual([
      { label: "What happens", value: "x" },
      { label: "Where", value: "Your Google Analytics property" },
    ]);
  });

  it("en çok 6 satır ve 200 karakter", () => {
    const rows = gaFixApprovalDetails({
      details: Array.from({ length: 9 }, (_, i) => ({
        label: `L${i}`,
        value: "v".repeat(500),
      })),
    });
    expect(rows).toHaveLength(6);
    expect(rows?.[0]?.value.length).toBe(200);
  });

  it("bozuk girdi undefined ya da atlanır", () => {
    expect(gaFixApprovalDetails(undefined)).toBeUndefined();
    expect(gaFixApprovalDetails(null)).toBeUndefined();
    expect(gaFixApprovalDetails("x")).toBeUndefined();
    expect(gaFixApprovalDetails({})).toBeUndefined();
    expect(gaFixApprovalDetails({ details: "x" })).toBeUndefined();
    expect(gaFixApprovalDetails({ details: [] })).toBeUndefined();
    expect(
      gaFixApprovalDetails({
        details: [null, 5, { label: 1, value: "x" }, { label: "a" }, { label: " ", value: "x" }],
      }),
    ).toBeUndefined();
    expect(
      gaFixApprovalDetails({
        details: [null, { label: "ok", value: "yes" }],
      }),
    ).toEqual([{ label: "ok", value: "yes" }]);
  });
});
