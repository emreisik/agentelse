import { describe, expect, it } from "vitest";

import dateAll from "@/server/integrations/search-console/__fixtures__/query-date-all.json";
import dateFinal from "@/server/integrations/search-console/__fixtures__/query-date-final.json";
import queryPage from "@/server/integrations/search-console/__fixtures__/query-query-page.json";

import { parseGscResponse, positionWeighted } from "./response";

// Bu dosyanın kanıtladığı: kayıtlı Search Analytics yanıtları ayrıştırılır;
// eksik metrik 0, first_incomplete_date yalnız geçerli gün anahtarıyla
// okunur, bozuk girdi boş yanıt verir.

describe("parseGscResponse", () => {
  it("parses a dataState=all response with metadata", () => {
    const parsed = parseGscResponse(dateAll);
    expect(parsed.rows).toHaveLength(10);
    expect(parsed.rows[0]).toEqual({
      keys: ["2026-09-26"],
      clicks: 41,
      impressions: 1873,
      ctr: 0.0218900160170849,
      position: 6.82,
    });
    expect(parsed.responseAggregationType).toBe("byProperty");
    expect(parsed.firstIncompleteDate).toBe("2026-10-04");
    expect(parsed.firstIncompleteHour).toBe("2026-10-04T00:00:00-07:00");
  });

  it("parses a final response without metadata", () => {
    const parsed = parseGscResponse(dateFinal);
    expect(parsed.rows.map((row) => row.keys[0])).toEqual([
      "2026-09-26",
      "2026-09-27",
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
    ]);
    expect(parsed.firstIncompleteDate).toBeNull();
    expect(parsed.firstIncompleteHour).toBeNull();
  });

  it("keeps query×page keys in order, including non-ASCII text", () => {
    const parsed = parseGscResponse(queryPage);
    expect(parsed.responseAggregationType).toBe("byPage");
    expect(parsed.rows[4]!.keys).toEqual([
      "ışıklı ayakkabı fiyatları",
      "https://www.example.com/products/kids",
    ]);
  });

  it("defaults missing or non-numeric metrics to 0", () => {
    const parsed = parseGscResponse({
      rows: [
        { keys: ["a"] },
        { keys: ["b"], clicks: "7", impressions: null, position: "NaN" },
        { clicks: Infinity },
        "not a row",
      ],
    });
    expect(parsed.rows).toEqual([
      { keys: ["a"], clicks: 0, impressions: 0, ctr: 0, position: 0 },
      { keys: ["b"], clicks: 7, impressions: 0, ctr: 0, position: 0 },
      { keys: [], clicks: 0, impressions: 0, ctr: 0, position: 0 },
    ]);
    expect(parsed.responseAggregationType).toBeNull();
  });

  it("validates first_incomplete_date", () => {
    expect(
      parseGscResponse({ metadata: { first_incomplete_date: "2026-10-04" } })
        .firstIncompleteDate,
    ).toBe("2026-10-04");
    expect(
      parseGscResponse({ metadata: { first_incomplete_date: "20261004" } })
        .firstIncompleteDate,
    ).toBeNull();
    expect(
      parseGscResponse({ metadata: { first_incomplete_date: 20261004 } })
        .firstIncompleteDate,
    ).toBeNull();
  });

  it("returns an empty response for malformed input", () => {
    const empty = {
      rows: [],
      responseAggregationType: null,
      firstIncompleteDate: null,
      firstIncompleteHour: null,
    };
    expect(parseGscResponse(null)).toEqual(empty);
    expect(parseGscResponse("oops")).toEqual(empty);
    expect(parseGscResponse([1, 2])).toEqual(empty);
    expect(parseGscResponse({ rows: "nope" })).toEqual(empty);
    expect(parseGscResponse({ responseAggregationType: "auto" }).rows).toEqual(
      [],
    );
  });
});

describe("positionWeighted", () => {
  it("multiplies position by impressions", () => {
    expect(positionWeighted({ position: 6.5, impressions: 200 })).toBe(1300);
  });

  it("is 0 without impressions or with a non-finite position", () => {
    expect(positionWeighted({ position: 3, impressions: 0 })).toBe(0);
    expect(positionWeighted({ position: 3, impressions: -1 })).toBe(0);
    expect(positionWeighted({ position: Number.NaN, impressions: 10 })).toBe(0);
    expect(
      positionWeighted({ position: Number.POSITIVE_INFINITY, impressions: 10 }),
    ).toBe(0);
  });
});
