import { describe, expect, it } from "vitest";
import { detectManualChanges } from "./change-events";
import type { GaChangeHistoryEvent } from "./resources";

const T0 = new Date("2026-10-06T10:00:00Z");

function event(
  partial: Partial<GaChangeHistoryEvent> & {
    changes: GaChangeHistoryEvent["changes"];
  },
): GaChangeHistoryEvent {
  return {
    id: "e",
    changeTime: T0.toISOString(),
    actorType: "USER",
    ...partial,
  };
}

const removeKey = (
  name: string,
  shape: "keyEvent" | "conversionEvent" | "flat" = "keyEvent",
  resource = `properties/1/keyEvents/${name}`,
) => ({
  resource,
  action: "DELETED" as const,
  before:
    shape === "flat"
      ? { eventName: name }
      : { [shape]: { eventName: name } },
  after: null,
});

const retention = (before: string, after: string, nested = true) => ({
  resource: "properties/1/dataRetentionSettings",
  action: "UPDATED" as const,
  before: nested
    ? { dataRetentionSettings: { eventDataRetention: before } }
    : { eventDataRetention: before },
  after: nested
    ? { dataRetentionSettings: { eventDataRetention: after } }
    : { eventDataRetention: after },
});

describe("detectManualChanges", () => {
  it("keyEvents ve conversionEvents biçimlerini okur", () => {
    const result = detectManualChanges(
      [
        event({
          changes: [
            removeKey("lead"),
            removeKey("call", "conversionEvent", "properties/1/conversionEvents/9"),
            removeKey("flat_one", "flat"),
          ],
        }),
      ],
      { ownTouches: [] },
    );
    expect(result.removedKeyEvents).toEqual(["call", "flat_one", "lead"]);
    expect(result.eventsSeen).toBe(1);
    expect(result.unparsed).toBe(0);
  });

  it("yalnız USER sayılır", () => {
    const result = detectManualChanges(
      [
        event({ actorType: "SYSTEM", changes: [removeKey("a")] }),
        event({ actorType: "SUPPORT", changes: [removeKey("b")] }),
        event({ actorType: "UNKNOWN", changes: [removeKey("c")] }),
        event({ actorType: "USER", changes: [removeKey("d")] }),
      ],
      { ownTouches: [] },
    );
    expect(result.removedKeyEvents).toEqual(["d"]);
    expect(result.eventsSeen).toBe(4);
  });

  it("kendi dokunuşları +/-15 dk içinde yok sayılır (ad ve tekil önek)", () => {
    const events = [
      event({
        changes: [removeKey("lead"), retention("FOURTEEN_MONTHS", "TWO_MONTHS")],
      }),
    ];
    const near = new Date(T0.getTime() + 14 * 60 * 1000);
    const far = new Date(T0.getTime() + 16 * 60 * 1000);
    const own = detectManualChanges(events, {
      ownTouches: [
        { resource: "properties/1/keyEvents/lead", at: near },
        { resource: "properties/1/dataRetentionSettings", at: near },
      ],
    });
    expect(own.removedKeyEvents).toEqual([]);
    expect(own.retentionShortened).toBe(false);

    const late = detectManualChanges(events, {
      ownTouches: [
        { resource: "properties/1/keyEvents/lead", at: far },
        { resource: "properties/1/dataRetentionSettings", at: far },
      ],
    });
    expect(late.removedKeyEvents).toEqual(["lead"]);
    expect(late.retentionShortened).toBe(true);

    const prefix = detectManualChanges(
      [event({ changes: [retention("FOURTEEN_MONTHS", "TWO_MONTHS")] })],
      { ownTouches: [{ resource: "properties/1", at: near }] },
    );
    expect(prefix.retentionShortened).toBe(false);
    const other = detectManualChanges(events, {
      ownTouches: [{ resource: "properties/1/keyEvents/other", at: near }],
    });
    expect(other.removedKeyEvents).toEqual(["lead"]);
  });

  it("saklama kısalması ve uzaması; en yüksek önceki değer", () => {
    const shortened = detectManualChanges(
      [
        event({ changes: [retention("TWENTY_SIX_MONTHS", "FOURTEEN_MONTHS")] }),
        event({ changes: [retention("FOURTEEN_MONTHS", "TWO_MONTHS", false)] }),
      ],
      { ownTouches: [] },
    );
    expect(shortened.retentionShortened).toBe(true);
    expect(shortened.retentionBefore).toBe("TWENTY_SIX_MONTHS");

    const lengthened = detectManualChanges(
      [event({ changes: [retention("TWO_MONTHS", "FOURTEEN_MONTHS")] })],
      { ownTouches: [] },
    );
    expect(lengthened.retentionShortened).toBe(false);
    expect(lengthened.retentionBefore).toBeNull();
  });

  it("çözümlenemeyenleri sayar", () => {
    const result = detectManualChanges(
      [
        event({
          changes: [
            {
              resource: "properties/1/keyEvents/9",
              action: "DELETED",
              before: null,
              after: null,
            },
            {
              resource: "properties/1/keyEvents/8",
              action: "DELETED",
              before: { keyEvent: { eventName: "bad name!" } },
              after: null,
            },
            {
              resource: "properties/1/dataRetentionSettings",
              action: "UPDATED",
              before: {},
              after: {},
            },
            {
              resource: "properties/1/keyEvents/7",
              action: "CREATED",
              before: null,
              after: { keyEvent: { eventName: "x" } },
            },
          ],
        }),
      ],
      { ownTouches: [] },
    );
    expect(result.unparsed).toBe(3);
    expect(result.removedKeyEvents).toEqual([]);
  });

  it("removedKeyEvents sıralı, tekil ve en çok 10", () => {
    const names = Array.from({ length: 14 }, (_, i) => `e${String(i).padStart(2, "0")}`);
    const result = detectManualChanges(
      [
        event({
          changes: [...names, ...names].reverse().map((name) => removeKey(name)),
        }),
      ],
      { ownTouches: [] },
    );
    expect(result.removedKeyEvents).toEqual(names.slice(0, 10));
  });

  it("çıktıda kişi verisi yok", () => {
    const result = detectManualChanges(
      [event({ changes: [removeKey("lead")] })],
      { ownTouches: [] },
    );
    expect(Object.keys(result).sort()).toEqual([
      "eventsSeen",
      "removedKeyEvents",
      "retentionBefore",
      "retentionShortened",
      "unparsed",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/@/);
  });
});
