import { describe, expect, it } from "vitest";
import { buildAiChannelGroup } from "./channel-group";
import { verifyReadBack } from "./readback";
import type {
  GaEnhancedMeasurementResource,
  GaKeyEventResource,
} from "./resources";
import type { GaFixCurrent } from "./types";

const keyEvent = (eventName: string): GaKeyEventResource => ({
  name: `properties/1/keyEvents/${eventName}`,
  eventName,
  countingMethod: null,
  custom: true,
  deletable: true,
});

function enhanced(
  patch: Partial<GaEnhancedMeasurementResource> = {},
): GaEnhancedMeasurementResource {
  return {
    name: "n",
    streamEnabled: true,
    scrollsEnabled: true,
    outboundClicksEnabled: true,
    siteSearchEnabled: true,
    videoEngagementEnabled: false,
    fileDownloadsEnabled: true,
    formInteractionsEnabled: false,
    pageChangesEnabled: false,
    searchQueryParameter: "q",
    uriQueryParameter: null,
    ...patch,
  };
}

describe("verifyReadBack", () => {
  const keyParams = { kind: "KEY_EVENT_CREATE", eventName: "generate_lead" } as const;
  const keyWrite = { op: "createKeyEvent", eventName: "generate_lead" } as const;

  it("anahtar olay: tamam, anlık görüntü ve kaynak adı", () => {
    expect(
      verifyReadBack(keyParams, keyWrite, {
        kind: "KEY_EVENT_CREATE",
        keyEvents: [keyEvent("generate_lead")],
        limit: 30,
      }),
    ).toEqual({
      ok: true,
      snapshot: {
        kind: "KEY_EVENT_CREATE",
        exists: true,
        resourceName: "properties/1/keyEvents/generate_lead",
        deletable: true,
      },
      resourceName: "properties/1/keyEvents/generate_lead",
    });
  });

  it("anahtar olay: yazma kabul edildi ama listede yok (yalan) -> uyuşmazlık", () => {
    const result = verifyReadBack(keyParams, keyWrite, {
      kind: "KEY_EVENT_CREATE",
      keyEvents: [keyEvent("purchase")],
      limit: 30,
    });
    expect(result).toEqual({ ok: false, reason: "not_in_list" });
  });

  it("saklama", () => {
    const write = { op: "updateRetention", value: "FOURTEEN_MONTHS" } as const;
    const at = (value: string): GaFixCurrent => ({
      kind: "RETENTION_14M",
      retention: { eventDataRetention: value, resetUserDataOnNewActivity: true },
    });
    expect(verifyReadBack({ kind: "RETENTION_14M" }, write, at("FOURTEEN_MONTHS"))).toEqual({
      ok: true,
      snapshot: { kind: "RETENTION_14M", eventDataRetention: "FOURTEEN_MONTHS" },
      resourceName: null,
    });
    expect(verifyReadBack({ kind: "RETENTION_14M" }, write, at("TWO_MONTHS")).ok).toBe(
      false,
    );
  });

  it("gelişmiş ölçüm: yamadaki her anahtar açık olmalı", () => {
    const write = {
      op: "updateEnhanced",
      streamId: "2",
      patch: { scrollsEnabled: true, siteSearchEnabled: true, searchQueryParameter: "q" },
    } as const;
    const params = { kind: "ENHANCED_MEASUREMENT" } as const;
    const ok = verifyReadBack(params, write, {
      kind: "ENHANCED_MEASUREMENT",
      streamId: "2",
      settings: enhanced(),
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.snapshot).toMatchObject({
        kind: "ENHANCED_MEASUREMENT",
        streamId: "2",
        scrollsEnabled: true,
        searchQueryParameter: "q",
      });
    }
    const bad = verifyReadBack(params, write, {
      kind: "ENHANCED_MEASUREMENT",
      streamId: "2",
      settings: enhanced({ siteSearchEnabled: false }),
    });
    expect(bad).toEqual({ ok: false, reason: "not_applied:siteSearchEnabled" });
    const badParam = verifyReadBack(params, write, {
      kind: "ENHANCED_MEASUREMENT",
      streamId: "2",
      settings: enhanced({ searchQueryParameter: "" }),
    });
    expect(badParam.ok).toBe(false);
  });

  it("kanal grubu", () => {
    const write = { op: "createChannelGroup", body: buildAiChannelGroup() } as const;
    const group = {
      name: "properties/1/channelGroups/9",
      displayName: "AI assistants",
      description: null,
      systemDefined: false,
      ruleCount: 1,
    };
    expect(
      verifyReadBack({ kind: "CHANNEL_GROUP_AI" }, write, {
        kind: "CHANNEL_GROUP_AI",
        groups: [group],
      }),
    ).toEqual({
      ok: true,
      snapshot: {
        kind: "CHANNEL_GROUP_AI",
        exists: true,
        resourceName: "properties/1/channelGroups/9",
      },
      resourceName: "properties/1/channelGroups/9",
    });
    expect(
      verifyReadBack({ kind: "CHANNEL_GROUP_AI" }, write, {
        kind: "CHANNEL_GROUP_AI",
        groups: [],
      }).ok,
    ).toBe(false);
  });

  it("not", () => {
    const params = {
      kind: "ANNOTATION_CREATE",
      title: "Agentelse: Launch",
      day: "2026-10-01",
    } as const;
    const write = {
      op: "createAnnotation",
      input: { title: params.title, description: "d", day: params.day, color: "BLUE" },
    } as const;
    const found = {
      name: "properties/1/reportingDataAnnotations/5",
      title: params.title,
      description: null,
      day: params.day,
      color: "BLUE",
      systemGenerated: false,
    };
    const ok = verifyReadBack(params, write, {
      kind: "ANNOTATION_CREATE",
      annotations: [found],
    });
    expect(ok).toMatchObject({
      ok: true,
      resourceName: "properties/1/reportingDataAnnotations/5",
    });
    expect(
      verifyReadBack(params, write, {
        kind: "ANNOTATION_CREATE",
        annotations: [{ ...found, day: "2026-10-02" }],
      }).ok,
    ).toBe(false);
  });

  it("tür uyuşmazlığı uyuşmazlık sayılır", () => {
    expect(
      verifyReadBack(keyParams, { op: "updateRetention", value: "FOURTEEN_MONTHS" }, {
        kind: "KEY_EVENT_CREATE",
        keyEvents: [],
        limit: 30,
      }),
    ).toEqual({ ok: false, reason: "kind_mismatch" });
  });
});
