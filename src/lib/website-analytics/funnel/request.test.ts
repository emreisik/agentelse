import { describe, expect, it } from "vitest";

import { buildFunnelRequest } from "./request";

// v1alpha runFunnelReport istek gövdesi. DOĞRULANAN (Google v1alpha discovery
// belgesi, 7 Eki 2026): yöntem POST properties/{property}:runFunnelReport;
// gövde alanları funnel { steps[], isOpenFunnel }, dateRanges[],
// returnPropertyQuota; FunnelStep { name, filterExpression, ... };
// FunnelFilterExpression { funnelEventFilter | funnelFieldFilter | andGroup |
// orGroup | notExpression }; FunnelEventFilter { eventName };
// FunnelFieldFilter { fieldName, stringFilter { value, matchType } };
// matchType EXACT geçerli; 'pagePath' funnel alanı olarak izinli.

const range = { startDate: "2026-09-09", endDate: "2026-10-06" };

describe("buildFunnelRequest", () => {
  it("builds an event step with name and funnelEventFilter", () => {
    const body = buildFunnelRequest(
      {
        isOpen: false,
        steps: [{ name: "Cart", kind: "event", value: "add_to_cart" }],
      },
      range,
    );
    expect(body.funnel.steps[0]).toEqual({
      name: "Cart",
      filterExpression: { funnelEventFilter: { eventName: "add_to_cart" } },
    });
  });

  it("builds a page step with funnelFieldFilter directly under filterExpression", () => {
    const body = buildFunnelRequest(
      {
        isOpen: false,
        steps: [{ name: "Thanks", kind: "page", value: "/thank-you" }],
      },
      range,
    );
    const step = body.funnel.steps[0];
    expect(step).toEqual({
      name: "Thanks",
      filterExpression: {
        funnelFieldFilter: {
          fieldName: "pagePath",
          stringFilter: { matchType: "EXACT", value: "/thank-you" },
        },
      },
    });
    // Ek bir fieldFilter sarmalayıcısı ve çıplak funnelEventFilter yok.
    expect(JSON.stringify(step)).not.toContain('"fieldFilter"');
  });

  it("carries the open flag, the date range and the quota request", () => {
    const steps = [
      { name: "A", kind: "event" as const, value: "a" },
      { name: "B", kind: "event" as const, value: "b" },
    ];
    const open = buildFunnelRequest({ isOpen: true, steps }, range);
    expect(open.funnel.isOpenFunnel).toBe(true);
    expect(open.dateRanges).toEqual([range]);
    expect(open.returnPropertyQuota).toBe(true);
    expect(
      buildFunnelRequest({ isOpen: false, steps }, range).funnel.isOpenFunnel,
    ).toBe(false);
    expect(open.funnel.steps.map((step) => step.name)).toEqual(["A", "B"]);
  });
});
