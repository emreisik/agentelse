import { describe, expect, it } from "vitest";
import type {
  GaAnnotationResource,
  GaChannelGroupResource,
  GaEnhancedMeasurementResource,
  GaKeyEventResource,
} from "./resources";
import {
  planFix,
  planUndo,
  retentionRank,
  undoPrecondition,
  verifyUndo,
} from "./plan";
import type { GaFixCurrent, GaFixSnapshot } from "./types";

function keyEvent(eventName: string, deletable = true): GaKeyEventResource {
  return {
    name: `properties/1/keyEvents/${eventName}`,
    eventName,
    countingMethod: "ONCE_PER_EVENT",
    custom: true,
    deletable,
  };
}

function enhanced(
  patch: Partial<GaEnhancedMeasurementResource> = {},
): GaEnhancedMeasurementResource {
  return {
    name: "properties/1/dataStreams/2/enhancedMeasurementSettings",
    streamEnabled: true,
    scrollsEnabled: false,
    outboundClicksEnabled: false,
    siteSearchEnabled: false,
    videoEngagementEnabled: false,
    fileDownloadsEnabled: false,
    formInteractionsEnabled: false,
    pageChangesEnabled: false,
    searchQueryParameter: "",
    uriQueryParameter: null,
    ...patch,
  };
}

const ALL_ON = {
  streamEnabled: true,
  scrollsEnabled: true,
  outboundClicksEnabled: true,
  siteSearchEnabled: true,
  fileDownloadsEnabled: true,
};

function current(settings: GaEnhancedMeasurementResource): GaFixCurrent {
  return { kind: "ENHANCED_MEASUREMENT", streamId: "2", settings };
}

describe("retentionRank", () => {
  it("sıra", () => {
    expect(retentionRank("TWO_MONTHS")).toBeLessThan(
      retentionRank("FOURTEEN_MONTHS"),
    );
    expect(retentionRank("FIFTY_MONTHS")).toBeGreaterThan(
      retentionRank("THIRTY_EIGHT_MONTHS"),
    );
    expect(retentionRank(null)).toBe(0);
    expect(retentionRank("???")).toBe(0);
  });
});

describe("planFix KEY_EVENT_CREATE", () => {
  const params = {
    kind: "KEY_EVENT_CREATE",
    eventName: "generate_lead",
  } as const;

  it("var olan olay noop", () => {
    const plan = planFix(params, {
      kind: "KEY_EVENT_CREATE",
      keyEvents: [keyEvent("generate_lead")],
      limit: 30,
    });
    expect(plan).toEqual({
      kind: "noop",
      snapshot: {
        kind: "KEY_EVENT_CREATE",
        exists: true,
        resourceName: "properties/1/keyEvents/generate_lead",
        deletable: true,
      },
    });
  });

  it("yoksa yazar", () => {
    const plan = planFix(params, {
      kind: "KEY_EVENT_CREATE",
      keyEvents: [keyEvent("purchase")],
      limit: 30,
    });
    expect(plan).toEqual({
      kind: "write",
      before: {
        kind: "KEY_EVENT_CREATE",
        exists: false,
        resourceName: null,
        deletable: null,
      },
      write: { op: "createKeyEvent", eventName: "generate_lead" },
    });
  });

  it.each([30, 50])("liste %i olunca limit_reached", (limit) => {
    const keyEvents = Array.from({ length: limit }, (_, i) =>
      keyEvent(`e${i}`),
    );
    expect(
      planFix(params, { kind: "KEY_EVENT_CREATE", keyEvents, limit }),
    ).toEqual({ kind: "refuse", code: "limit_reached" });
    expect(
      planFix(params, {
        kind: "KEY_EVENT_CREATE",
        keyEvents: keyEvents.slice(1),
        limit,
      }).kind,
    ).toBe("write");
  });

  it("sınır doluyken olay zaten varsa noop", () => {
    const keyEvents = Array.from({ length: 30 }, (_, i) => keyEvent(`e${i}`));
    keyEvents[0] = keyEvent("generate_lead");
    expect(
      planFix(params, { kind: "KEY_EVENT_CREATE", keyEvents, limit: 30 }).kind,
    ).toBe("noop");
  });

  it("tür uyuşmazlığı atar", () => {
    expect(() =>
      planFix(params, {
        kind: "RETENTION_14M",
        retention: {
          eventDataRetention: "TWO_MONTHS",
          resetUserDataOnNewActivity: false,
        },
      }),
    ).toThrow();
  });
});

describe("planFix RETENTION_14M", () => {
  const params = { kind: "RETENTION_14M" } as const;
  const at = (value: string): GaFixCurrent => ({
    kind: "RETENTION_14M",
    retention: { eventDataRetention: value, resetUserDataOnNewActivity: true },
  });

  it("iki ay yazılır", () => {
    expect(planFix(params, at("TWO_MONTHS"))).toEqual({
      kind: "write",
      before: { kind: "RETENTION_14M", eventDataRetention: "TWO_MONTHS" },
      write: { op: "updateRetention", value: "FOURTEEN_MONTHS" },
    });
  });

  it.each(["FOURTEEN_MONTHS", "TWENTY_SIX_MONTHS", "FIFTY_MONTHS"])(
    "%s noop",
    (value) => {
      expect(planFix(params, at(value)).kind).toBe("noop");
    },
  );
});

describe("planFix ENHANCED_MEASUREMENT", () => {
  const params = { kind: "ENHANCED_MEASUREMENT" } as const;

  it("yalnız kapalı öğeler yamaya girer, form etkileşimi asla", () => {
    const plan = planFix(
      params,
      current(
        enhanced({ scrollsEnabled: true, formInteractionsEnabled: false }),
      ),
    );
    expect(plan.kind).toBe("write");
    if (plan.kind !== "write" || plan.write.op !== "updateEnhanced") return;
    expect(plan.write.streamId).toBe("2");
    expect(plan.write.patch).toEqual({
      outboundClicksEnabled: true,
      siteSearchEnabled: true,
      fileDownloadsEnabled: true,
      searchQueryParameter: "q,s,search,query,keyword",
    });
    expect("formInteractionsEnabled" in plan.write.patch).toBe(false);
  });

  it("site araması zaten açıksa sorgu parametresi eklenmez", () => {
    const plan = planFix(
      params,
      current(enhanced({ siteSearchEnabled: true, searchQueryParameter: "" })),
    );
    if (plan.kind !== "write" || plan.write.op !== "updateEnhanced") {
      throw new Error("yazma bekleniyordu");
    }
    expect(plan.write.patch).toEqual({
      scrollsEnabled: true,
      outboundClicksEnabled: true,
      fileDownloadsEnabled: true,
    });
  });

  it("sorgu parametresi doluysa dokunulmaz", () => {
    const plan = planFix(
      params,
      current(enhanced({ searchQueryParameter: "kw" })),
    );
    if (plan.kind !== "write" || plan.write.op !== "updateEnhanced") {
      throw new Error("yazma bekleniyordu");
    }
    expect("searchQueryParameter" in plan.write.patch).toBe(false);
    expect(plan.write.patch.siteSearchEnabled).toBe(true);
  });

  it("akış kapalıysa onu da açar", () => {
    const plan = planFix(params, current(enhanced({ streamEnabled: false })));
    if (plan.kind !== "write" || plan.write.op !== "updateEnhanced") {
      throw new Error("yazma bekleniyordu");
    }
    expect(plan.write.patch.streamEnabled).toBe(true);
  });

  it("beşi de açıksa noop (form etkileşimi kapalı olsa da)", () => {
    const plan = planFix(
      params,
      current(enhanced({ ...ALL_ON, searchQueryParameter: "q" })),
    );
    expect(plan.kind).toBe("noop");
  });
});

describe("planFix CHANNEL_GROUP_AI ve ANNOTATION_CREATE", () => {
  const group = (displayName: string): GaChannelGroupResource => ({
    name: "properties/1/channelGroups/9",
    displayName,
    description: null,
    systemDefined: false,
    ruleCount: 1,
  });
  const note = (title: string, day: string): GaAnnotationResource => ({
    name: "properties/1/reportingDataAnnotations/5",
    title,
    description: null,
    day,
    color: "BLUE",
    systemGenerated: false,
  });

  it("kanal grubu var -> noop, yok -> yaz", () => {
    expect(
      planFix(
        { kind: "CHANNEL_GROUP_AI" },
        { kind: "CHANNEL_GROUP_AI", groups: [group("AI assistants")] },
      ).kind,
    ).toBe("noop");
    const plan = planFix(
      { kind: "CHANNEL_GROUP_AI" },
      { kind: "CHANNEL_GROUP_AI", groups: [group("Default")] },
    );
    expect(plan.kind).toBe("write");
    if (plan.kind === "write" && plan.write.op === "createChannelGroup") {
      expect(plan.write.body.displayName).toBe("AI assistants");
    }
  });

  it("not: aynı başlık ve gün noop, farklı gün yaz", () => {
    const params = {
      kind: "ANNOTATION_CREATE",
      title: "Agentelse: Launch",
      day: "2026-10-01",
    } as const;
    expect(
      planFix(params, {
        kind: "ANNOTATION_CREATE",
        annotations: [note("Agentelse: Launch", "2026-10-01")],
      }).kind,
    ).toBe("noop");
    const plan = planFix(params, {
      kind: "ANNOTATION_CREATE",
      annotations: [note("Agentelse: Launch", "2026-10-02")],
    });
    expect(plan).toMatchObject({
      kind: "write",
      write: {
        op: "createAnnotation",
        input: { title: "Agentelse: Launch", day: "2026-10-01", color: "BLUE" },
      },
    });
  });
});

describe("planUndo", () => {
  const keyBefore: GaFixSnapshot = {
    kind: "KEY_EVENT_CREATE",
    exists: false,
    resourceName: null,
    deletable: null,
  };
  const keyAfter: GaFixSnapshot = {
    kind: "KEY_EVENT_CREATE",
    exists: true,
    resourceName: "properties/1/keyEvents/7",
    deletable: true,
  };

  it("noop geri alınamaz", () => {
    expect(
      planUndo({
        kind: "RETENTION_14M",
        noop: true,
        before: null,
        after: null,
        resourceName: null,
      }),
    ).toEqual({ ok: false, reason: "nothing_to_undo" });
  });

  it("anahtar olay adıyla silinir", () => {
    expect(
      planUndo({
        kind: "KEY_EVENT_CREATE",
        noop: false,
        before: keyBefore,
        after: keyAfter,
        resourceName: "properties/1/keyEvents/7",
      }),
    ).toEqual({
      ok: true,
      undo: { op: "deleteKeyEvent", resourceName: "properties/1/keyEvents/7" },
    });
  });

  it("silinemez anahtar olay ve eksik kaynak reddedilir", () => {
    const base = {
      kind: "KEY_EVENT_CREATE" as const,
      noop: false,
      before: keyBefore,
    };
    expect(
      planUndo({
        ...base,
        after: { ...keyAfter, deletable: false },
        resourceName: "properties/1/keyEvents/7",
      }),
    ).toEqual({ ok: false, reason: "not_deletable" });
    expect(planUndo({ ...base, after: keyAfter, resourceName: null }).ok).toBe(
      true,
    );
    expect(
      planUndo({
        ...base,
        after: { ...keyAfter, resourceName: null },
        resourceName: null,
      }),
    ).toEqual({ ok: false, reason: "no_resource" });
    expect(
      planUndo({
        ...base,
        before: { ...keyBefore, exists: true },
        after: keyAfter,
        resourceName: "x",
      }).ok,
    ).toBe(false);
  });

  it("saklama önceki değere döner", () => {
    expect(
      planUndo({
        kind: "RETENTION_14M",
        noop: false,
        before: { kind: "RETENTION_14M", eventDataRetention: "TWO_MONTHS" },
        after: {
          kind: "RETENTION_14M",
          eventDataRetention: "FOURTEEN_MONTHS",
        },
        resourceName: null,
      }),
    ).toEqual({
      ok: true,
      undo: { op: "restoreRetention", value: "TWO_MONTHS" },
    });
    expect(
      planUndo({
        kind: "RETENTION_14M",
        noop: false,
        before: { kind: "RETENTION_14M", eventDataRetention: null },
        after: null,
        resourceName: null,
      }).ok,
    ).toBe(false);
  });

  it("gelişmiş ölçüm yalnız değişen anahtarları geri alır", () => {
    const before: GaFixSnapshot = {
      kind: "ENHANCED_MEASUREMENT",
      streamId: "2",
      streamEnabled: true,
      scrollsEnabled: true,
      outboundClicksEnabled: false,
      siteSearchEnabled: false,
      fileDownloadsEnabled: false,
      searchQueryParameter: null,
    };
    const after: GaFixSnapshot = {
      kind: "ENHANCED_MEASUREMENT",
      streamId: "2",
      streamEnabled: true,
      scrollsEnabled: true,
      outboundClicksEnabled: true,
      siteSearchEnabled: true,
      fileDownloadsEnabled: true,
      searchQueryParameter: "q,s,search,query,keyword",
    };
    expect(
      planUndo({
        kind: "ENHANCED_MEASUREMENT",
        noop: false,
        before,
        after,
        resourceName: null,
      }),
    ).toEqual({
      ok: true,
      undo: {
        op: "restoreEnhanced",
        streamId: "2",
        patch: {
          outboundClicksEnabled: false,
          siteSearchEnabled: false,
          fileDownloadsEnabled: false,
        },
      },
    });
    expect(
      planUndo({
        kind: "ENHANCED_MEASUREMENT",
        noop: false,
        before,
        after: before,
        resourceName: null,
      }),
    ).toEqual({ ok: false, reason: "nothing_to_undo" });
  });

  it("kanal grubu ve not adıyla silinir", () => {
    const before = (
      kind: "CHANNEL_GROUP_AI" | "ANNOTATION_CREATE",
    ): GaFixSnapshot => ({ kind, exists: false, resourceName: null });
    expect(
      planUndo({
        kind: "CHANNEL_GROUP_AI",
        noop: false,
        before: before("CHANNEL_GROUP_AI"),
        after: null,
        resourceName: "properties/1/channelGroups/9",
      }),
    ).toEqual({
      ok: true,
      undo: {
        op: "deleteChannelGroup",
        resourceName: "properties/1/channelGroups/9",
      },
    });
    expect(
      planUndo({
        kind: "ANNOTATION_CREATE",
        noop: false,
        before: before("ANNOTATION_CREATE"),
        after: null,
        resourceName: "properties/1/reportingDataAnnotations/5",
      }),
    ).toEqual({
      ok: true,
      undo: {
        op: "deleteAnnotation",
        resourceName: "properties/1/reportingDataAnnotations/5",
      },
    });
    expect(
      planUndo({
        kind: "ANNOTATION_CREATE",
        noop: false,
        before: before("ANNOTATION_CREATE"),
        after: null,
        resourceName: null,
      }).ok,
    ).toBe(false);
  });
});

describe("undoPrecondition", () => {
  const retentionAfter: GaFixSnapshot = {
    kind: "RETENTION_14M",
    eventDataRetention: "FOURTEEN_MONTHS",
  };
  const retentionAt = (value: string): GaFixCurrent => ({
    kind: "RETENTION_14M",
    retention: { eventDataRetention: value, resetUserDataOnNewActivity: true },
  });

  it("saklama: canlı değer sonrası değerle aynıysa doğru", () => {
    const change = { kind: "RETENTION_14M" as const, after: retentionAfter };
    expect(undoPrecondition(change, retentionAt("FOURTEEN_MONTHS"))).toBe(true);
    expect(undoPrecondition(change, retentionAt("TWENTY_SIX_MONTHS"))).toBe(
      false,
    );
  });

  const enhAfter: GaFixSnapshot = {
    kind: "ENHANCED_MEASUREMENT",
    streamId: "2",
    streamEnabled: true,
    scrollsEnabled: true,
    outboundClicksEnabled: true,
    siteSearchEnabled: true,
    fileDownloadsEnabled: true,
    searchQueryParameter: "q,s,search,query,keyword",
  };

  it("gelişmiş ölçüm: sonradan elle kapatılan öğe önkoşulu bozar", () => {
    const change = { kind: "ENHANCED_MEASUREMENT" as const, after: enhAfter };
    const ok = enhanced({
      ...ALL_ON,
      searchQueryParameter: "q,s,search,query,keyword",
    });
    expect(undoPrecondition(change, current(ok))).toBe(true);
    expect(
      undoPrecondition(change, current({ ...ok, scrollsEnabled: false })),
    ).toBe(false);
    expect(
      undoPrecondition(change, current({ ...ok, searchQueryParameter: "kw" })),
    ).toBe(false);
  });

  it("before verilirse yalnız değişen öğeler denetlenir", () => {
    const before: GaFixSnapshot = {
      ...enhAfter,
      kind: "ENHANCED_MEASUREMENT",
      outboundClicksEnabled: false,
    };
    const change = {
      kind: "ENHANCED_MEASUREMENT" as const,
      before,
      after: enhAfter,
    };
    const live = enhanced({
      ...ALL_ON,
      scrollsEnabled: false,
      searchQueryParameter: "q,s,search,query,keyword",
    });
    // scrolls düzeltme tarafından değiştirilmedi; elle kapatılması önkoşulu
    // bozmaz. outbound değiştirildi ve hâlâ açık.
    expect(undoPrecondition(change, current(live))).toBe(true);
    expect(
      undoPrecondition(
        change,
        current({ ...live, outboundClicksEnabled: false }),
      ),
    ).toBe(false);
  });

  it("yaratılan kaynaklar ve tür uyuşmazlığı", () => {
    expect(
      undoPrecondition(
        { kind: "KEY_EVENT_CREATE", after: null },
        { kind: "KEY_EVENT_CREATE", keyEvents: [], limit: 30 },
      ),
    ).toBe(true);
    expect(
      undoPrecondition(
        { kind: "RETENTION_14M", after: retentionAfter },
        { kind: "KEY_EVENT_CREATE", keyEvents: [], limit: 30 },
      ),
    ).toBe(false);
  });
});

describe("verifyUndo", () => {
  it("anahtar olay silindi mi", () => {
    const op = {
      op: "deleteKeyEvent",
      resourceName: "properties/1/keyEvents/generate_lead",
    } as const;
    expect(
      verifyUndo(op, {
        kind: "KEY_EVENT_CREATE",
        keyEvents: [keyEvent("purchase")],
        limit: 30,
      }),
    ).toBe(true);
    expect(
      verifyUndo(op, {
        kind: "KEY_EVENT_CREATE",
        keyEvents: [keyEvent("generate_lead")],
        limit: 30,
      }),
    ).toBe(false);
  });

  it("saklama ve gelişmiş ölçüm geri döndü mü", () => {
    expect(
      verifyUndo(
        { op: "restoreRetention", value: "TWO_MONTHS" },
        {
          kind: "RETENTION_14M",
          retention: {
            eventDataRetention: "TWO_MONTHS",
            resetUserDataOnNewActivity: true,
          },
        },
      ),
    ).toBe(true);
    const op = {
      op: "restoreEnhanced",
      streamId: "2",
      patch: { scrollsEnabled: false },
    } as const;
    expect(verifyUndo(op, current(enhanced({ scrollsEnabled: false })))).toBe(
      true,
    );
    expect(verifyUndo(op, current(enhanced({ scrollsEnabled: true })))).toBe(
      false,
    );
  });

  it("kanal grubu ve not silindi mi; tür uyuşmazlığı false", () => {
    expect(
      verifyUndo(
        {
          op: "deleteChannelGroup",
          resourceName: "properties/1/channelGroups/9",
        },
        { kind: "CHANNEL_GROUP_AI", groups: [] },
      ),
    ).toBe(true);
    expect(
      verifyUndo(
        { op: "deleteAnnotation", resourceName: "n" },
        { kind: "ANNOTATION_CREATE", annotations: [] },
      ),
    ).toBe(true);
    expect(
      verifyUndo(
        { op: "deleteAnnotation", resourceName: "n" },
        { kind: "CHANNEL_GROUP_AI", groups: [] },
      ),
    ).toBe(false);
  });
});
