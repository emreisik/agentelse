import { describe, expect, it } from "vitest";

import {
  addDaysUTC,
  addMonthsUTC,
  quotaWindowAt,
  remainingFraction,
} from "./windows";

const d = (iso: string) => new Date(iso);

describe("addMonthsUTC", () => {
  it("ay sonu çapasını kelepçeler ama kaydırmaz", () => {
    const anchor = d("2026-01-31T10:30:00.000Z");
    expect(addMonthsUTC(anchor, 1).toISOString()).toBe(
      "2026-02-28T10:30:00.000Z",
    );
    // Şubat'tan değil çapadan hesaplanır: Mart yine 31.
    expect(addMonthsUTC(anchor, 2).toISOString()).toBe(
      "2026-03-31T10:30:00.000Z",
    );
    expect(addMonthsUTC(anchor, 3).toISOString()).toBe(
      "2026-04-30T10:30:00.000Z",
    );
  });

  it("artık yıl ve yıl atlama", () => {
    expect(addMonthsUTC(d("2028-01-31T00:00:00.000Z"), 1).toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
    expect(addMonthsUTC(d("2026-11-15T00:00:00.000Z"), 3).toISOString()).toBe(
      "2027-02-15T00:00:00.000Z",
    );
    expect(addMonthsUTC(d("2026-12-31T00:00:00.000Z"), 12).toISOString()).toBe(
      "2027-12-31T00:00:00.000Z",
    );
  });
});

describe("quotaWindowAt", () => {
  const anchor = d("2026-01-31T10:30:00.000Z");

  it("çapadan önce pencere yok", () => {
    expect(quotaWindowAt(anchor, d("2026-01-31T10:29:59.999Z"))).toBeNull();
  });

  it("çapanın kendisi ilk pencerenin başlangıcıdır", () => {
    const window = quotaWindowAt(anchor, anchor)!;
    expect(window.index).toBe(0);
    expect(window.start.toISOString()).toBe("2026-01-31T10:30:00.000Z");
    expect(window.end.toISOString()).toBe("2026-02-28T10:30:00.000Z");
  });

  it("sınırda bir milisaniye önce eski, tam sınırda yeni pencere", () => {
    const before = quotaWindowAt(anchor, d("2026-02-28T10:29:59.999Z"))!;
    const at = quotaWindowAt(anchor, d("2026-02-28T10:30:00.000Z"))!;
    expect(before.index).toBe(0);
    expect(at.index).toBe(1);
    expect(at.start.toISOString()).toBe("2026-02-28T10:30:00.000Z");
    expect(at.end.toISOString()).toBe("2026-03-31T10:30:00.000Z");
  });

  it("aylık pencereler boşluksuz ve çakışmasız ardışıktır (bir yıl boyunca)", () => {
    let expectedStart = anchor.getTime();
    for (let index = 0; index < 14; index += 1) {
      const window = quotaWindowAt(anchor, new Date(expectedStart))!;
      expect(window.index).toBe(index);
      expect(window.start.getTime()).toBe(expectedStart);
      expect(window.end.getTime()).toBeGreaterThan(window.start.getTime());
      expectedStart = window.end.getTime();
    }
  });

  it("yıllık fatura aralığında bile pencere aylıktır", () => {
    // 11 ay sonra hâlâ 12. pencerede değil, 11. pencerede.
    const window = quotaWindowAt(
      d("2026-03-05T00:00:00.000Z"),
      d("2027-02-10T00:00:00.000Z"),
    )!;
    expect(window.index).toBe(11);
    expect(window.start.toISOString()).toBe("2027-02-05T00:00:00.000Z");
    expect(window.end.toISOString()).toBe("2027-03-05T00:00:00.000Z");
  });
});

describe("remainingFraction", () => {
  it("pencere başında 1, ortada 0,5, sonda 0; aralık dışı kelepçelenir", () => {
    const window = {
      index: 0,
      start: d("2026-06-01T00:00:00.000Z"),
      end: d("2026-07-01T00:00:00.000Z"),
    };
    expect(remainingFraction(window, window.start)).toBe(1);
    expect(remainingFraction(window, d("2026-06-16T00:00:00.000Z"))).toBe(0.5);
    expect(remainingFraction(window, window.end)).toBe(0);
    expect(remainingFraction(window, d("2026-08-01T00:00:00.000Z"))).toBe(0);
    expect(remainingFraction(window, d("2026-05-01T00:00:00.000Z"))).toBe(1);
  });
});

describe("addDaysUTC", () => {
  it("gün ekler", () => {
    expect(addDaysUTC(d("2026-10-08T00:00:00.000Z"), 7).toISOString()).toBe(
      "2026-10-15T00:00:00.000Z",
    );
  });
});
