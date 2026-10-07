import { describe, expect, it } from "vitest";

import { GoogleApiError } from "@/server/integrations/google/errors";

import {
  buildEnhancedMeasurementPatch,
  isGaResourceName,
  isGaResourceNameOf,
  parseAnnotation,
  parseAnnotationList,
  parseChangeHistory,
  parseChannelGroup,
  parseChannelGroupList,
  parseEnhanced,
  parseGaDay,
  parseKeyEvent,
  parseKeyEventList,
  parseRetention,
} from "./admin-parse";

// Bu dosyanın kanıtladığı (GA-F7): Admin API ayrıştırıcıları bilinmeyen alanları
// yok sayar, isteğe bağlı alanlara varsayılan verir, zorunlu alan eksikse
// UNEXPECTED_SHAPE (sınıf UNKNOWN) fırlatır; not tarihi YYYY-MM-DD olur; değişim
// geçmişi çıktısında eylemi yapanın e-postası bulunmaz.

function shapeError(run: () => unknown): GoogleApiError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(GoogleApiError);
    return error as GoogleApiError;
  }
  throw new Error("expected a throw");
}

function expectDrift(run: () => unknown) {
  const error = shapeError(run);
  expect(error.googleErrorCode).toBe("UNEXPECTED_SHAPE");
  expect(error.errorClass).toBe("UNKNOWN");
  expect(error.message).toBe("Google returned an unexpected response");
}

describe("key events", () => {
  it("parses a key event and ignores extra fields", () => {
    expect(
      parseKeyEvent({
        name: "properties/1/keyEvents/2",
        eventName: "generate_lead",
        countingMethod: "ONCE_PER_SESSION",
        custom: true,
        deletable: true,
        createTime: "2026-10-01T00:00:00Z",
        defaultValue: { numericValue: 1 },
      }),
    ).toEqual({
      name: "properties/1/keyEvents/2",
      eventName: "generate_lead",
      countingMethod: "ONCE_PER_SESSION",
      custom: true,
      deletable: true,
    });
  });

  it("defaults optional fields to the safe side", () => {
    expect(
      parseKeyEvent({ name: "properties/1/keyEvents/2", eventName: "purchase" }),
    ).toEqual({
      name: "properties/1/keyEvents/2",
      eventName: "purchase",
      countingMethod: null,
      custom: false,
      deletable: false,
    });
  });

  it("throws when a required field is missing or has the wrong type", () => {
    expectDrift(() => parseKeyEvent({ eventName: "x" }));
    expectDrift(() => parseKeyEvent({ name: "n" }));
    expectDrift(() => parseKeyEvent({ name: 5, eventName: "x" }));
    expectDrift(() => parseKeyEvent({ name: "n", eventName: "x", custom: "yes" }));
    expectDrift(() => parseKeyEvent(null));
    expectDrift(() => parseKeyEvent([]));
  });

  it("lists: empty object is an empty list, wrong types are drift", () => {
    expect(parseKeyEventList({})).toEqual([]);
    expect(parseKeyEventList({ keyEvents: [] })).toEqual([]);
    expectDrift(() => parseKeyEventList(null));
    expectDrift(() => parseKeyEventList({ keyEvents: "x" }));
    expectDrift(() => parseKeyEventList({ keyEvents: [{ eventName: "x" }] }));
  });
});

describe("retention", () => {
  it("parses and defaults the reset flag", () => {
    expect(parseRetention({ eventDataRetention: "TWO_MONTHS", extra: 1 })).toEqual({
      eventDataRetention: "TWO_MONTHS",
      resetUserDataOnNewActivity: false,
    });
  });
  it("requires the retention value", () => {
    expectDrift(() => parseRetention({}));
    expectDrift(() => parseRetention({ eventDataRetention: 14 }));
  });
});

describe("enhanced measurement", () => {
  it("defaults booleans to false and the query parameter to ''", () => {
    expect(parseEnhanced({ name: "properties/1/dataStreams/2/enhancedMeasurementSettings" })).toEqual({
      name: "properties/1/dataStreams/2/enhancedMeasurementSettings",
      streamEnabled: false,
      scrollsEnabled: false,
      outboundClicksEnabled: false,
      siteSearchEnabled: false,
      videoEngagementEnabled: false,
      fileDownloadsEnabled: false,
      formInteractionsEnabled: false,
      pageChangesEnabled: false,
      searchQueryParameter: "",
      uriQueryParameter: null,
    });
  });
  it("reads set flags", () => {
    const parsed = parseEnhanced({
      name: "n",
      streamEnabled: true,
      scrollsEnabled: true,
      searchQueryParameter: "q",
      uriQueryParameter: "utm",
    });
    expect(parsed.streamEnabled).toBe(true);
    expect(parsed.scrollsEnabled).toBe(true);
    expect(parsed.siteSearchEnabled).toBe(false);
    expect(parsed.searchQueryParameter).toBe("q");
    expect(parsed.uriQueryParameter).toBe("utm");
  });
  it("is drift without a name or with a wrapper", () => {
    expectDrift(() => parseEnhanced({ streamEnabled: true }));
    expectDrift(() => parseEnhanced({ enhancedMeasurementSettings: { name: "n" } }));
    expectDrift(() => parseEnhanced({ name: "n", scrollsEnabled: "true" }));
  });
});

describe("channel groups", () => {
  it("counts the grouping rules", () => {
    expect(
      parseChannelGroup({
        name: "properties/1/channelGroups/2",
        displayName: "AI assistants",
        description: "d",
        groupingRule: [{}, {}],
        systemDefined: true,
      }),
    ).toEqual({
      name: "properties/1/channelGroups/2",
      displayName: "AI assistants",
      description: "d",
      systemDefined: true,
      ruleCount: 2,
    });
  });
  it("defaults and drift", () => {
    expect(parseChannelGroup({ name: "n", displayName: "x" })).toEqual({
      name: "n",
      displayName: "x",
      description: null,
      systemDefined: false,
      ruleCount: 0,
    });
    expectDrift(() => parseChannelGroup({ name: "n" }));
    expectDrift(() => parseChannelGroup({ name: "n", displayName: "x", groupingRule: {} }));
    expect(parseChannelGroupList({})).toEqual([]);
    expectDrift(() => parseChannelGroupList({ channelGroups: {} }));
  });
});

describe("annotations", () => {
  it("converts annotationDate to YYYY-MM-DD with padding", () => {
    expect(
      parseAnnotation({
        name: "n",
        title: "t",
        annotationDate: { year: 2026, month: 3, day: 7 },
        color: "BLUE",
        systemGenerated: true,
        description: "d",
      }),
    ).toEqual({
      name: "n",
      title: "t",
      description: "d",
      day: "2026-03-07",
      color: "BLUE",
      systemGenerated: true,
    });
  });
  it("a date range or a missing date gives day null", () => {
    const range = parseAnnotation({
      name: "n",
      title: "t",
      annotationDateRange: {
        startDate: { year: 2026, month: 1, day: 1 },
        endDate: { year: 2026, month: 1, day: 5 },
      },
    });
    expect(range.day).toBeNull();
    expect(parseAnnotation({ name: "n", title: "t" }).day).toBeNull();
    expect(
      parseAnnotation({ name: "n", title: "t", annotationDate: { year: "2026" } }).day,
    ).toBeNull();
  });
  it("requires name and title", () => {
    expectDrift(() => parseAnnotation({ title: "t" }));
    expectDrift(() => parseAnnotation({ name: "n" }));
    expectDrift(() => parseAnnotationList({ reportingDataAnnotations: [{ title: "t" }] }));
    expect(parseAnnotationList({})).toEqual([]);
  });
});

describe("change history", () => {
  const raw = {
    changeHistoryEvents: [
      {
        id: "1",
        changeTime: "2026-10-06T08:00:00Z",
        actorType: "USER",
        userActorEmail: "someone@example.com",
        changesFiltered: true,
        changes: [
          {
            resource: "properties/1/keyEvents/2",
            action: "DELETED",
            resourceBeforeChange: {
              keyEvent: { eventName: "generate_lead", createdBy: "boss@example.com" },
            },
          },
          {
            resource: "properties/1/dataRetentionSettings",
            action: "UPDATED",
            resourceBeforeChange: {
              dataRetentionSettings: { eventDataRetention: "FOURTEEN_MONTHS" },
            },
            resourceAfterChange: {
              dataRetentionSettings: { eventDataRetention: "TWO_MONTHS" },
            },
          },
        ],
      },
      { id: "2", changeTime: "2026-10-06T09:00:00Z", actorType: "ACTOR_TYPE_UNSPECIFIED" },
    ],
    nextPageToken: "100",
  };

  it("parses events, changes and snapshots", () => {
    const parsed = parseChangeHistory(raw);
    expect(parsed.nextPageToken).toBe("100");
    expect(parsed.events).toHaveLength(2);
    const [first, second] = parsed.events;
    expect(first?.actorType).toBe("USER");
    expect(first?.changes[0]).toMatchObject({
      resource: "properties/1/keyEvents/2",
      action: "DELETED",
      after: null,
    });
    expect(first?.changes[1]?.before).toEqual({
      dataRetentionSettings: { eventDataRetention: "FOURTEEN_MONTHS" },
    });
    expect(second).toEqual({
      id: "2",
      changeTime: "2026-10-06T09:00:00Z",
      actorType: "UNKNOWN",
      changes: [],
    });
  });

  it("never carries an e-mail address, even nested", () => {
    const text = JSON.stringify(parseChangeHistory(raw));
    expect(text).not.toMatch(/@/);
    expect(text).not.toContain("userActorEmail");
    expect(text).not.toContain("someone@example.com");
    expect(text).not.toContain("boss@example.com");
  });

  it("empty answer and missing token", () => {
    expect(parseChangeHistory({})).toEqual({ events: [], nextPageToken: null });
    expect(parseChangeHistory({ nextPageToken: "" }).nextPageToken).toBeNull();
  });

  it("is drift on a bad shape", () => {
    expectDrift(() => parseChangeHistory(null));
    expectDrift(() => parseChangeHistory({ changeHistoryEvents: {} }));
    expectDrift(() => parseChangeHistory({ changeHistoryEvents: [{ changeTime: "t" }] }));
    expectDrift(() =>
      parseChangeHistory({
        changeHistoryEvents: [{ id: "1", changeTime: "t", changes: [{ action: "CREATED" }] }],
      }),
    );
    expectDrift(() => parseChangeHistory({ nextPageToken: 5 }));
  });
});

describe("path helpers", () => {
  it("resource names", () => {
    expect(isGaResourceName("properties/1/keyEvents/2")).toBe(true);
    expect(isGaResourceNameOf("properties/1/keyEvents/2", "keyEvents")).toBe(true);
    expect(isGaResourceNameOf("properties/1/keyEvents/2", "channelGroups")).toBe(false);
    expect(isGaResourceName("properties/1/keyEvents/2/../3")).toBe(false);
  });
  it("parseGaDay accepts real days only", () => {
    expect(parseGaDay("2026-10-06")).toEqual({ year: 2026, month: 10, day: 6 });
    expect(parseGaDay("2028-02-29")).toEqual({ year: 2028, month: 2, day: 29 });
    for (const bad of ["2026-02-29", "2026-13-01", "2026-1-1", "", "tomorrow"]) {
      expect(() => parseGaDay(bad)).toThrow(GoogleApiError);
    }
  });
  it("enhanced patch: stable order, no unknown or empty patch", () => {
    expect(
      buildEnhancedMeasurementPatch({
        searchQueryParameter: "q",
        siteSearchEnabled: true,
        scrollsEnabled: true,
      }).keys,
    ).toEqual(["scrollsEnabled", "siteSearchEnabled", "searchQueryParameter"]);
    expect(() => buildEnhancedMeasurementPatch({})).toThrow(GoogleApiError);
    expect(() =>
      buildEnhancedMeasurementPatch({ videoEngagementEnabled: true } as never),
    ).toThrow(GoogleApiError);
    expect(() =>
      buildEnhancedMeasurementPatch({ scrollsEnabled: "yes" } as never),
    ).toThrow(GoogleApiError);
  });
});
