import { describe, expect, it } from "vitest";

import incidents from "@/server/integrations/search-console/__fixtures__/status-incidents.json";

import {
  parseStatusIncidents,
  searchUpdateKind,
  updatesOverlapping,
} from "./search-updates";

// Bu dosyanın kanıtladığı: Status Dashboard akışı (gerçek biçim, 10 olay)
// okunur; türler açıklamadan ve servis adından çıkar; bitişi olmayan
// güncelleme süren sayılır ve örtüşme hesabına girer.

describe("parseStatusIncidents", () => {
  it("parses the real-shape fixture", () => {
    const updates = parseStatusIncidents(incidents);
    expect(updates).toHaveLength(10);
    expect(updates[0]).toEqual({
      externalId: "t1Lq7hQx3sPq9cTz1Ab2",
      name: "September 2026 spam update",
      kind: "SPAM",
      startedAt: new Date("2026-09-16T17:00:00.000Z"),
      endedAt: null,
      url: "https://status.search.google.com/incidents/t1Lq7hQx3sPq9cTz1Ab2",
    });
    const march = updates.find((u) => u.name === "March 2026 core update");
    expect(march).toMatchObject({
      kind: "CORE",
      startedAt: new Date("2026-03-11T16:00:00.000Z"),
      endedAt: new Date("2026-03-29T18:00:00.000Z"),
    });
    expect(updates.filter((u) => u.kind === "SERVING")).toHaveLength(2);
  });

  it("skips malformed incidents and foreign links", () => {
    expect(parseStatusIncidents(null)).toEqual([]);
    expect(parseStatusIncidents({ incidents: [] })).toEqual([]);
    const parsed = parseStatusIncidents([
      { id: "a", external_desc: "No begin" },
      { id: "b", begin: "2026-01-01T00:00:00Z" },
      {
        id: "c",
        begin: "2026-01-01T00:00:00Z",
        end: "2025-12-01T00:00:00Z",
        external_desc: "Ends before it starts",
        uri: "https://evil.example.com/x",
      },
      {
        id: "c",
        begin: "2026-01-01T00:00:00Z",
        external_desc: "Duplicate id",
      },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      externalId: "c",
      endedAt: null,
      url: null,
    });
  });
});

describe("searchUpdateKind", () => {
  it("reads the update type, then the service", () => {
    expect(searchUpdateKind("Ranking", "March 2026 core update")).toBe("CORE");
    expect(searchUpdateKind("Ranking", "September 2026 spam update")).toBe(
      "SPAM",
    );
    expect(searchUpdateKind("Ranking", "August 2026 Discover update")).toBe(
      "DISCOVER",
    );
    expect(searchUpdateKind("Ranking", "April 2026 reviews update")).toBe(
      "REVIEWS",
    );
    expect(
      searchUpdateKind(
        "Ranking",
        "January 2026 helpful content system improvement",
      ),
    ).toBe("HELPFUL_CONTENT");
    expect(searchUpdateKind("Ranking", "A ranking issue")).toBe(
      "OTHER_RANKING",
    );
    expect(
      searchUpdateKind("Serving", "Serving issues affecting Google Search"),
    ).toBe("SERVING");
    expect(searchUpdateKind("Crawling", "Crawling delays")).toBe("CRAWLING");
    expect(searchUpdateKind("Indexing", "Indexing issue")).toBe("INDEXING");
    expect(searchUpdateKind(null, "Something else")).toBe("OTHER");
  });
});

describe("updatesOverlapping", () => {
  const now = new Date("2026-10-06T00:00:00.000Z");
  const updates = [
    {
      name: "closed",
      startedAt: new Date("2026-09-01T00:00:00Z"),
      endedAt: new Date("2026-09-10T00:00:00Z"),
    },
    {
      name: "open",
      startedAt: new Date("2026-09-16T00:00:00Z"),
      endedAt: null,
    },
  ];

  it("treats open-ended updates as running until now", () => {
    const names = (from: string, to: string) =>
      updatesOverlapping(updates, new Date(from), new Date(to), now).map(
        (u) => u.name,
      );
    expect(names("2026-09-05T00:00:00Z", "2026-09-06T00:00:00Z")).toEqual([
      "closed",
    ]);
    expect(names("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z")).toEqual([
      "open",
    ]);
    expect(names("2026-09-09T00:00:00Z", "2026-09-20T00:00:00Z")).toEqual([
      "closed",
      "open",
    ]);
    expect(names("2026-08-01T00:00:00Z", "2026-08-30T00:00:00Z")).toEqual([]);
    expect(names("2026-10-07T00:00:00Z", "2026-10-08T00:00:00Z")).toEqual([]);
  });
});
