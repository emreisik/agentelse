import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GoogleApiError } from "@/server/integrations/google/errors";

import { createGaAdminWriter } from "./admin-write";
import {
  mockGaAdminCalls,
  mockGaAdminPushChange,
  resetMockGaAdmin,
  seedMockGaAdmin,
  setMockGaAdminFault,
  setMockGaAdminReadBackLie,
} from "./admin-write-mock";

// Bu dosyanın kanıtladığı (GA-F7, mock modu): AGENTELSE_PROVIDER_MODE=mock iken
// fetch'e hiç ulaşılmaz; mock belirlenimcidir (tohum, kaynak adları), hata
// enjeksiyonunu, "yazıldı sonra hata" kipini ve geri okuma yalanını uygular,
// gerçek istemciyle aynı kimlik/kaynak adı korumalarına sahiptir ve çağrı
// sırasını kaydeder.

const mocks = vi.hoisted(() => ({ recordGaApiOutcome: vi.fn() }));
vi.mock("@/server/website-analytics/api-counters", () => ({
  recordGaApiOutcome: mocks.recordGaApiOutcome,
}));

const fetchMock = vi.fn(() => {
  throw new Error("fetch must never be called in mock mode");
});

const P = "424242";
const S = "777";
const writer = () => createGaAdminWriter("ignored-token");

beforeEach(() => {
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  mocks.recordGaApiOutcome.mockClear();
  resetMockGaAdmin();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function error(status: number, code: string, message = "boom"): GoogleApiError {
  return new GoogleApiError(message, code, { httpStatus: status });
}

describe("deterministic seed", () => {
  it("starts with purchase, two months, only the stream enabled, nothing else", async () => {
    const w = writer();
    expect(await w.listKeyEvents(P)).toEqual([
      {
        name: `properties/${P}/keyEvents/1`,
        eventName: "purchase",
        countingMethod: "ONCE_PER_EVENT",
        custom: false,
        deletable: false,
      },
    ]);
    expect((await w.getDataRetention(P)).eventDataRetention).toBe("TWO_MONTHS");
    const enhanced = await w.getEnhancedMeasurement(P, S);
    expect(enhanced).toMatchObject({
      name: `properties/${P}/dataStreams/${S}/enhancedMeasurementSettings`,
      streamEnabled: true,
      scrollsEnabled: false,
      outboundClicksEnabled: false,
      siteSearchEnabled: false,
      fileDownloadsEnabled: false,
      formInteractionsEnabled: false,
      searchQueryParameter: "",
    });
    expect(await w.listChannelGroups(P)).toEqual([]);
    expect(await w.listAnnotations(P)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("same actions give the same names in a fresh store", async () => {
    const run = async () => {
      resetMockGaAdmin();
      const w = writer();
      const a = await w.createKeyEvent(P, "generate_lead");
      const b = await w.createKeyEvent(P, "click_to_call");
      return [a.name, b.name];
    };
    expect(await run()).toEqual([
      `properties/${P}/keyEvents/2`,
      `properties/${P}/keyEvents/3`,
    ]);
    expect(await run()).toEqual([
      `properties/${P}/keyEvents/2`,
      `properties/${P}/keyEvents/3`,
    ]);
  });

  it("properties are isolated and seedable", async () => {
    seedMockGaAdmin(P, {
      keyEvents: ["generate_lead"],
      retention: "FOURTEEN_MONTHS",
      enhanced: { scrollsEnabled: true },
      channelGroups: ["AI assistants"],
      annotations: [{ title: "Agentelse: x", day: "2026-10-01" }],
    });
    const w = writer();
    expect((await w.listKeyEvents(P)).map((k) => k.eventName)).toEqual(["generate_lead"]);
    expect((await w.getDataRetention(P)).eventDataRetention).toBe("FOURTEEN_MONTHS");
    expect((await w.getEnhancedMeasurement(P, S)).scrollsEnabled).toBe(true);
    expect((await w.listChannelGroups(P))[0]?.displayName).toBe("AI assistants");
    expect((await w.listAnnotations(P))[0]).toMatchObject({
      title: "Agentelse: x",
      day: "2026-10-01",
    });
    expect((await w.listKeyEvents("999")).map((k) => k.eventName)).toEqual(["purchase"]);
  });

  it("returns copies, not the stored objects", async () => {
    const w = writer();
    const list = await w.listKeyEvents(P);
    list.pop();
    expect(await w.listKeyEvents(P)).toHaveLength(1);
  });
});

describe("writes", () => {
  it("creates and deletes key events; a duplicate is a 409; deleting twice is a 404", async () => {
    const w = writer();
    const created = await w.createKeyEvent(P, "generate_lead");
    expect((await w.listKeyEvents(P)).map((k) => k.eventName)).toContain("generate_lead");
    const dup = await w.createKeyEvent(P, "generate_lead").catch((e: unknown) => e);
    expect((dup as GoogleApiError).httpStatus).toBe(409);
    await w.deleteKeyEvent(created.name);
    expect((await w.listKeyEvents(P)).map((k) => k.eventName)).toEqual(["purchase"]);
    const gone = await w.deleteKeyEvent(created.name).catch((e: unknown) => e);
    expect((gone as GoogleApiError).errorClass).toBe("NOT_FOUND");
  });

  it("the built-in purchase key event cannot be deleted", async () => {
    const err = await writer()
      .deleteKeyEvent(`properties/${P}/keyEvents/1`)
      .catch((e: unknown) => e);
    expect((err as GoogleApiError).errorClass).toBe("VALIDATION");
  });

  it("enforces the 30 key event limit as a limit error", async () => {
    seedMockGaAdmin(P, {
      keyEvents: Array.from({ length: 30 }, (_, i) => `ev_${i}`),
    });
    const err = await writer().createKeyEvent(P, "one_more").catch((e: unknown) => e);
    expect((err as GoogleApiError).errorClass).toBe("VALIDATION");
    expect((err as GoogleApiError).message).toMatch(/maximum|exceed/i);
  });

  it("updates retention and rejects an unknown value", async () => {
    const w = writer();
    const updated = await w.updateDataRetention(P, "FOURTEEN_MONTHS");
    expect(updated.eventDataRetention).toBe("FOURTEEN_MONTHS");
    expect((await w.getDataRetention(P)).eventDataRetention).toBe("FOURTEEN_MONTHS");
    const err = await w.updateDataRetention(P, "THREE_MONTHS").catch((e: unknown) => e);
    expect((err as GoogleApiError).errorClass).toBe("VALIDATION");
  });

  it("patches only the given enhanced measurement keys", async () => {
    const w = writer();
    const after = await w.updateEnhancedMeasurement(P, S, {
      scrollsEnabled: true,
      searchQueryParameter: "q",
    });
    expect(after.scrollsEnabled).toBe(true);
    expect(after.searchQueryParameter).toBe("q");
    expect(after.outboundClicksEnabled).toBe(false);
    expect((await w.getEnhancedMeasurement(P, S)).scrollsEnabled).toBe(true);
    // Başka akış etkilenmez.
    expect((await w.getEnhancedMeasurement(P, "888")).scrollsEnabled).toBe(false);
  });

  it("creates and deletes channel groups and annotations", async () => {
    const w = writer();
    const group = await w.createChannelGroup(P, {
      displayName: "AI assistants",
      description: "d",
      groupingRule: [
        {
          displayName: "AI assistants",
          expression: {
            filter: {
              fieldName: "eachScopeSource",
              stringFilter: { matchType: "PARTIAL_REGEXP", value: "chatgpt" },
            },
          },
        },
      ],
    });
    expect(group).toMatchObject({ displayName: "AI assistants", ruleCount: 1 });
    expect(await w.listChannelGroups(P)).toHaveLength(1);
    await w.deleteChannelGroup(group.name);
    expect(await w.listChannelGroups(P)).toHaveLength(0);

    const note = await w.createAnnotation(P, {
      title: "Agentelse: launch",
      description: "d",
      day: "2026-10-06",
      color: "BLUE",
    });
    expect(note.day).toBe("2026-10-06");
    expect(await w.listAnnotations(P)).toHaveLength(1);
    await w.deleteAnnotation(note.name);
    expect(await w.listAnnotations(P)).toHaveLength(0);
  });
});

describe("faults", () => {
  it("a fault throws before the write and leaves the store untouched", async () => {
    setMockGaAdminFault("createKeyEvent", error(503, "UNAVAILABLE"));
    const w = writer();
    const err = await w.createKeyEvent(P, "generate_lead").catch((e: unknown) => e);
    expect((err as GoogleApiError).errorClass).toBe("SERVER_ERROR");
    expect((await w.listKeyEvents(P)).map((k) => k.eventName)).toEqual(["purchase"]);
  });

  it("an 'after' fault happens after the write (timed-out write)", async () => {
    setMockGaAdminFault("updateDataRetention", error(504, "DEADLINE_EXCEEDED"), {
      after: true,
    });
    const w = writer();
    await expect(w.updateDataRetention(P, "FOURTEEN_MONTHS")).rejects.toBeInstanceOf(
      GoogleApiError,
    );
    expect((await w.getDataRetention(P)).eventDataRetention).toBe("FOURTEEN_MONTHS");
  });

  it("times limits the fault, null clears it", async () => {
    const w = writer();
    setMockGaAdminFault("listKeyEvents", error(503, "UNAVAILABLE"), { times: 1 });
    await expect(w.listKeyEvents(P)).rejects.toBeInstanceOf(GoogleApiError);
    await expect(w.listKeyEvents(P)).resolves.toHaveLength(1);

    setMockGaAdminFault("listKeyEvents", error(403, "PERMISSION_DENIED"));
    await expect(w.listKeyEvents(P)).rejects.toBeInstanceOf(GoogleApiError);
    setMockGaAdminFault("listKeyEvents", null);
    await expect(w.listKeyEvents(P)).resolves.toHaveLength(1);
  });

  it("faults are per method", async () => {
    setMockGaAdminFault("deleteAnnotation", error(500, "INTERNAL"));
    await expect(writer().listAnnotations(P)).resolves.toEqual([]);
  });
});

describe("read-back lies", () => {
  it("createKeyEvent answers ok but stores nothing", async () => {
    setMockGaAdminReadBackLie("createKeyEvent", true);
    const w = writer();
    const created = await w.createKeyEvent(P, "generate_lead");
    expect(created.eventName).toBe("generate_lead");
    expect((await w.listKeyEvents(P)).map((k) => k.eventName)).toEqual(["purchase"]);
    setMockGaAdminReadBackLie("createKeyEvent", false);
    await w.createKeyEvent(P, "generate_lead");
    expect((await w.listKeyEvents(P)).map((k) => k.eventName)).toContain("generate_lead");
  });

  it("retention, enhanced measurement, channel group and annotation lies", async () => {
    const w = writer();
    for (const method of [
      "updateDataRetention",
      "updateEnhancedMeasurement",
      "createChannelGroup",
      "createAnnotation",
    ] as const) {
      setMockGaAdminReadBackLie(method, true);
    }
    expect((await w.updateDataRetention(P, "FOURTEEN_MONTHS")).eventDataRetention).toBe(
      "FOURTEEN_MONTHS",
    );
    expect((await w.getDataRetention(P)).eventDataRetention).toBe("TWO_MONTHS");
    expect(
      (await w.updateEnhancedMeasurement(P, S, { scrollsEnabled: true })).scrollsEnabled,
    ).toBe(true);
    expect((await w.getEnhancedMeasurement(P, S)).scrollsEnabled).toBe(false);
    await w.createChannelGroup(P, {
      displayName: "AI assistants",
      description: "",
      groupingRule: [
        {
          displayName: "x",
          expression: {
            filter: {
              fieldName: "f",
              stringFilter: { matchType: "EXACT", value: "v" },
            },
          },
        },
      ],
    });
    expect(await w.listChannelGroups(P)).toEqual([]);
    await w.createAnnotation(P, {
      title: "t",
      description: "",
      day: "2026-10-06",
      color: "BLUE",
    });
    expect(await w.listAnnotations(P)).toEqual([]);
  });
});

describe("guards match the real client", () => {
  it("rejects bad ids and resource names without recording a call", async () => {
    const w = writer();
    await expect(w.listKeyEvents("../1")).rejects.toMatchObject({ errorClass: "VALIDATION" });
    await expect(w.getEnhancedMeasurement(P, "x")).rejects.toMatchObject({
      errorClass: "VALIDATION",
    });
    await expect(w.deleteKeyEvent("properties/1/channelGroups/1")).rejects.toMatchObject({
      errorClass: "VALIDATION",
    });
    await expect(
      w.deleteAnnotation("https://analyticsadmin.googleapis.com/v1alpha/properties/1/reportingDataAnnotations/1"),
    ).rejects.toMatchObject({ errorClass: "VALIDATION" });
    await expect(w.createKeyEvent(P, "bad name")).rejects.toMatchObject({
      errorClass: "VALIDATION",
    });
    expect(mockGaAdminCalls()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("call log and counters", () => {
  it("records method names in call order", async () => {
    const w = writer();
    await w.listKeyEvents(P);
    await w.createKeyEvent(P, "generate_lead");
    await w.getDataRetention(P);
    await w.listKeyEvents(P);
    expect(mockGaAdminCalls()).toEqual([
      "listKeyEvents",
      "createKeyEvent",
      "getDataRetention",
      "listKeyEvents",
    ]);
  });

  it("a faulted call is still logged and counted by its class", async () => {
    setMockGaAdminFault("getDataRetention", error(429, "RESOURCE_EXHAUSTED", "slow"));
    await writer().getDataRetention(P).catch(() => undefined);
    expect(mockGaAdminCalls()).toEqual(["getDataRetention"]);
    expect(mocks.recordGaApiOutcome).toHaveBeenCalledWith("RATE_LIMIT");
  });

  it("successful calls count as ok", async () => {
    await writer().listChannelGroups(P);
    expect(mocks.recordGaApiOutcome).toHaveBeenCalledWith("ok");
  });

  it("resetMockGaAdmin isolates tests", async () => {
    const w = writer();
    await w.createKeyEvent(P, "generate_lead");
    setMockGaAdminFault("listKeyEvents", error(500, "INTERNAL"));
    resetMockGaAdmin();
    expect(mockGaAdminCalls()).toEqual([]);
    expect((await w.listKeyEvents(P)).map((k) => k.eventName)).toEqual(["purchase"]);
  });
});

describe("change history", () => {
  const search = (extra: { pageToken?: string; pageSize?: number } = {}) =>
    writer().searchChangeHistory({
      accountId: "55",
      propertyId: P,
      earliest: new Date("2026-10-01T00:00:00Z"),
      latest: new Date("2026-10-07T00:00:00Z"),
      ...extra,
    });

  it("returns pushed changes newest first inside the window", async () => {
    mockGaAdminPushChange(P, {
      resource: `properties/${P}/keyEvents/2`,
      action: "DELETED",
      before: { keyEvent: { eventName: "generate_lead" } },
      at: new Date("2026-10-03T10:00:00Z"),
    });
    mockGaAdminPushChange(P, {
      resource: `properties/${P}/dataRetentionSettings`,
      action: "UPDATED",
      before: { dataRetentionSettings: { eventDataRetention: "FOURTEEN_MONTHS" } },
      after: { dataRetentionSettings: { eventDataRetention: "TWO_MONTHS" } },
      at: new Date("2026-10-05T10:00:00Z"),
    });
    mockGaAdminPushChange(P, {
      resource: `properties/${P}/keyEvents/9`,
      action: "CREATED",
      at: new Date("2026-09-01T10:00:00Z"),
    });

    const result = await search();

    expect(result.nextPageToken).toBeNull();
    expect(result.events.map((e) => e.changes[0]?.action)).toEqual(["UPDATED", "DELETED"]);
    expect(result.events[0]).toMatchObject({ actorType: "USER" });
    expect(JSON.stringify(result)).not.toContain("@");
  });

  it("pages with a token", async () => {
    for (let i = 0; i < 5; i += 1) {
      mockGaAdminPushChange(P, {
        resource: `properties/${P}/keyEvents/${i + 2}`,
        action: "CREATED",
        at: new Date(`2026-10-0${i + 1}T10:00:00Z`),
      });
    }
    const first = await search({ pageSize: 2 });
    expect(first.events).toHaveLength(2);
    expect(first.nextPageToken).toBe("2");
    const second = await search({ pageSize: 2, pageToken: first.nextPageToken ?? "" });
    expect(second.events).toHaveLength(2);
    const third = await search({ pageSize: 2, pageToken: second.nextPageToken ?? "" });
    expect(third.events).toHaveLength(1);
    expect(third.nextPageToken).toBeNull();
    const ids = [...first.events, ...second.events, ...third.events].map((e) => e.id);
    expect(new Set(ids).size).toBe(5);
  });

  it("does not record its own writes as history", async () => {
    await writer().createKeyEvent(P, "generate_lead");
    expect((await search()).events).toEqual([]);
  });
});

describe("no network, ever", () => {
  it("every method works with a fetch that throws", async () => {
    const w = writer();
    await w.listKeyEvents(P);
    await w.getDataRetention(P);
    await w.getEnhancedMeasurement(P, S);
    await w.listChannelGroups(P);
    await w.listAnnotations(P);
    await search();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  function search() {
    return writer().searchChangeHistory({
      accountId: "55",
      propertyId: P,
      earliest: new Date("2026-10-01T00:00:00Z"),
      latest: new Date("2026-10-07T00:00:00Z"),
    });
  }
});
