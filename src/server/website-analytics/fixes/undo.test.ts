import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  mockGaAdminCalls,
  resetMockGaAdmin,
  seedMockGaAdmin,
  setMockGaAdminFault,
} from "@/server/integrations/google-analytics/admin-write-mock";

import { applyGaConfigChange } from "./apply";
import { recordGaFixAudit } from "./audit";
import { clearGaEditGrant, loadGaEditAccess } from "./edit-grant";
import {
  NOW,
  PROPERTY_ID,
  STREAM_ID,
  change,
  classedError,
  createMockGaAdminWriter,
  fake,
  mutating,
  resetFake,
} from "./engine-b.testkit";
import { undoGaConfigChange } from "./undo";

// Bu dosyanın kanıtladığı (GA-F7 geri alma): yönetici olmayan kullanıcı
// yazıcıya hiç çağrı yapmadan reddedilir; yalnız VERIFIED ve noop olmayan satır
// geri alınır; her tür [okuma, geri alma, okuma] sırasıyla geri okunur;
// başarısızlık VERIFIED'a error.undo ile döner; tek örnekli kaynaklar
// (saklama, gelişmiş ölçüm) elle değiştirilmişse üzerine yazılmaz
// (cannot_undo); silmede 404 "zaten yok" sayılır; mock uyuşmazlığı reddedilir.

vi.mock("@/lib/prisma", async () => ({
  prisma: (await import("./engine-b.testkit")).fakePrisma,
}));
vi.mock("./audit", () => ({ recordGaFixAudit: vi.fn(async () => undefined) }));
vi.mock("./edit-grant", () => ({
  loadGaEditAccess: vi.fn(),
  clearGaEditGrant: vi.fn(async () => undefined),
}));
vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: { transition: vi.fn(async () => ({})) },
}));
vi.mock("@/server/website-analytics/api-counters", () => ({
  recordGaApiOutcome: vi.fn(),
}));

type Kind =
  | "KEY_EVENT_CREATE"
  | "RETENTION_14M"
  | "ENHANCED_MEASUREMENT"
  | "CHANNEL_GROUP_AI"
  | "ANNOTATION_CREATE";

const CANNOT_UNDO =
  "It was changed again since. Change it back in Google Analytics if you still want it reverted.";
const NOT_MANAGER = "Only a workspace owner or admin can undo this.";

const FIXTURES: Record<
  Kind,
  { params: Record<string, unknown>; dedupeKey: string; calls: string[] }
> = {
  KEY_EVENT_CREATE: {
    params: { kind: "KEY_EVENT_CREATE", eventName: "generate_lead" },
    dedupeKey: "KEY_EVENT_CREATE:generate_lead",
    calls: ["listKeyEvents", "deleteKeyEvent", "listKeyEvents"],
  },
  RETENTION_14M: {
    params: { kind: "RETENTION_14M" },
    dedupeKey: "RETENTION_14M:-",
    calls: ["getDataRetention", "updateDataRetention", "getDataRetention"],
  },
  ENHANCED_MEASUREMENT: {
    params: { kind: "ENHANCED_MEASUREMENT" },
    dedupeKey: "ENHANCED_MEASUREMENT:-",
    calls: [
      "getEnhancedMeasurement",
      "updateEnhancedMeasurement",
      "getEnhancedMeasurement",
    ],
  },
  CHANNEL_GROUP_AI: {
    params: { kind: "CHANNEL_GROUP_AI" },
    dedupeKey: "CHANNEL_GROUP_AI:-",
    calls: ["listChannelGroups", "deleteChannelGroup", "listChannelGroups"],
  },
  ANNOTATION_CREATE: {
    params: {
      kind: "ANNOTATION_CREATE",
      title: "Agentelse: Spring sale launched",
      day: "2026-10-05",
    },
    dedupeKey: "ANNOTATION_CREATE:launch:l1",
    calls: ["listAnnotations", "deleteAnnotation", "listAnnotations"],
  },
};
const KINDS = Object.keys(FIXTURES) as Kind[];

const INPUT = { projectId: "proj-1", changeId: "chg-1", userId: "owner-1" };

function deps(
  overrides: Partial<
    NonNullable<Parameters<typeof undoGaConfigChange>[1]>
  > = {},
): NonNullable<Parameters<typeof undoGaConfigChange>[1]> {
  return {
    writer: createMockGaAdminWriter(),
    mock: true,
    now: new Date(NOW.getTime() + 60 * 60_000),
    tokenFor: async () => "token",
    ...overrides,
  };
}

function setupChange(kind: Kind, overrides: Record<string, unknown> = {}) {
  resetMockGaAdmin();
  seedMockGaAdmin(PROPERTY_ID, {});
  resetFake({
    change: {
      kind,
      status: "APPROVED",
      params: FIXTURES[kind].params,
      dedupeKey: FIXTURES[kind].dedupeKey,
      openKey: FIXTURES[kind].dedupeKey,
      ...overrides,
    },
  });
}

// Gerçek apply motoruyla VERIFIED bir satır üretir (gerçekçi anlık görüntüler).
async function appliedChange(kind: Kind): Promise<void> {
  setupChange(kind);
  const result = await applyGaConfigChange("chg-1", {
    writer: createMockGaAdminWriter(),
    mock: true,
    now: NOW,
    tokenFor: async () => "token",
  });
  expect(result).toEqual({ state: "verified" });
  vi.mocked(recordGaFixAudit).mockClear();
}

function callsSince(baseline: number): string[] {
  return mockGaAdminCalls().slice(baseline);
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_FIXES", "true");
  vi.stubEnv("GA_FIXES_ALPHA", "true");
  vi.mocked(loadGaEditAccess).mockReset();
  vi.mocked(loadGaEditAccess).mockResolvedValue({
    credentialId: "cred-1",
    workspaceId: "ws-1",
    granted: true,
    grantedAt: NOW.toISOString(),
    grantedByUserId: "owner-1",
    connectedEmail: null,
    mock: true,
  });
  vi.mocked(clearGaEditGrant).mockClear();
  vi.mocked(recordGaFixAudit).mockClear();
});

describe("yetki ve durum kapıları", () => {
  it.each([
    ["düz üye", "member-1", "MEMBER"],
    ["üyeliği olmayan", "stranger", null],
    ["telegram sözde kullanıcısı", "telegram:1", null],
  ])("%s reddedilir, yazıcıya çağrı yok", async (_label, userId, role) => {
    await appliedChange("KEY_EVENT_CREATE");
    if (role) fake.members.set(`ws-1:${userId}`, role);
    const baseline = mockGaAdminCalls().length;
    const result = await undoGaConfigChange({ ...INPUT, userId }, deps());
    expect(result).toEqual({ ok: false, message: NOT_MANAGER });
    expect(callsSince(baseline)).toEqual([]);
    expect(change().status).toBe("VERIFIED");
  });

  it("ADMIN geri alabilir", async () => {
    await appliedChange("KEY_EVENT_CREATE");
    fake.members.set("ws-1:admin-1", "ADMIN");
    const result = await undoGaConfigChange(
      { ...INPUT, userId: "admin-1" },
      deps(),
    );
    expect(result).toEqual({ ok: true });
    expect(change().undoneByUserId).toBe("admin-1");
  });

  it.each([
    "PROPOSED",
    "APPROVED",
    "APPLYING",
    "APPLIED",
    "FAILED",
    "UNDOING",
    "UNDONE",
    "REJECTED",
    "EXPIRED",
  ])("%s durumundaki satır geri alınmaz", async (status) => {
    await appliedChange("KEY_EVENT_CREATE");
    change().status = status;
    const baseline = mockGaAdminCalls().length;
    const result = await undoGaConfigChange(INPUT, deps());
    expect(result.ok).toBe(false);
    expect(callsSince(baseline)).toEqual([]);
    expect(change().status).toBe(status);
  });

  it("noop satır geri alınmaz", async () => {
    await appliedChange("KEY_EVENT_CREATE");
    change().noop = true;
    const baseline = mockGaAdminCalls().length;
    expect((await undoGaConfigChange(INPUT, deps())).ok).toBe(false);
    expect(callsSince(baseline)).toEqual([]);
  });

  it("başka projenin satırı bulunamaz", async () => {
    await appliedChange("KEY_EVENT_CREATE");
    const result = await undoGaConfigChange(
      { ...INPUT, projectId: "proj-2" },
      deps(),
    );
    expect(result).toEqual({
      ok: false,
      message: "This change was not found.",
    });
  });

  it("bayrak kapalıyken reddedilir", async () => {
    await appliedChange("KEY_EVENT_CREATE");
    vi.stubEnv("GA_FIXES", "false");
    const baseline = mockGaAdminCalls().length;
    expect((await undoGaConfigChange(INPUT, deps())).ok).toBe(false);
    expect(callsSince(baseline)).toEqual([]);
    expect(change().status).toBe("VERIFIED");
  });

  it("alpha anahtarı kapalıyken alpha satırı geri alınmaz", async () => {
    await appliedChange("CHANNEL_GROUP_AI");
    vi.stubEnv("GA_FIXES_ALPHA", "false");
    const baseline = mockGaAdminCalls().length;
    expect((await undoGaConfigChange(INPUT, deps())).ok).toBe(false);
    expect(callsSince(baseline)).toEqual([]);
  });

  it("düzenleme izni yoksa reddedilir", async () => {
    await appliedChange("KEY_EVENT_CREATE");
    vi.mocked(loadGaEditAccess).mockResolvedValue(null);
    const baseline = mockGaAdminCalls().length;
    expect((await undoGaConfigChange(INPUT, deps())).ok).toBe(false);
    expect(callsSince(baseline)).toEqual([]);
  });

  it("mock uyuşmazlığı reddedilir (gerçek süreç + mock bağ ve tersi)", async () => {
    await appliedChange("KEY_EVENT_CREATE");
    let baseline = mockGaAdminCalls().length;
    expect((await undoGaConfigChange(INPUT, deps({ mock: false }))).ok).toBe(
      false,
    );
    expect(callsSince(baseline)).toEqual([]);

    fake.link = { ...fake.link, isMock: false };
    baseline = mockGaAdminCalls().length;
    expect((await undoGaConfigChange(INPUT, deps({ mock: true }))).ok).toBe(
      false,
    );
    expect(callsSince(baseline)).toEqual([]);
    expect(change().status).toBe("VERIFIED");
  });

  it("mülk değiştiyse (bağ birincil değil) reddedilir", async () => {
    await appliedChange("KEY_EVENT_CREATE");
    fake.link = { ...fake.link, isPrimary: false };
    const baseline = mockGaAdminCalls().length;
    expect((await undoGaConfigChange(INPUT, deps())).ok).toBe(false);
    expect(callsSince(baseline)).toEqual([]);
  });

  it("kilitli satır meşgul sayılır", async () => {
    await appliedChange("KEY_EVENT_CREATE");
    change().leaseUntil = new Date(NOW.getTime() + 3 * 60 * 60_000);
    const baseline = mockGaAdminCalls().length;
    const result = await undoGaConfigChange(INPUT, deps());
    expect(result.ok).toBe(false);
    expect(callsSince(baseline)).toEqual([]);
  });
});

describe("başarılı geri alma, her tür geri okunur", () => {
  it.each(KINDS)("%s: [okuma, geri alma, okuma] ve UNDONE", async (kind) => {
    await appliedChange(kind);
    const baseline = mockGaAdminCalls().length;
    const now = deps().now ?? NOW;
    const result = await undoGaConfigChange(INPUT, deps({ now }));
    expect(result).toEqual({ ok: true });
    expect(callsSince(baseline)).toEqual(FIXTURES[kind].calls);

    const row = change();
    expect(row.status).toBe("UNDONE");
    expect(row.rolledBackAt).toEqual(now);
    expect(row.undoneByUserId).toBe("owner-1");
    expect(row.openKey).toBeNull();
    expect(row.error).toBeNull();
    expect(row.leaseOwner).toBeNull();
    expect(recordGaFixAudit).toHaveBeenCalledWith(
      "ga_config_change.undone",
      expect.objectContaining({ changeId: "chg-1", kind }),
      { workspaceId: "ws-1", projectId: "proj-1", userId: "owner-1" },
    );
  });

  it("anahtar olay silinir ve bağın keyEvents sütunu tazelenir", async () => {
    await appliedChange("KEY_EVENT_CREATE");
    fake.linkUpdates = [];
    await undoGaConfigChange(INPUT, deps());
    const events = await createMockGaAdminWriter().listKeyEvents(PROPERTY_ID);
    expect(events.map((e) => e.eventName)).toEqual(["purchase"]);
    expect(fake.linkUpdates).toEqual([
      {
        keyEvents: [
          {
            eventName: "purchase",
            countingMethod: "ONCE_PER_EVENT",
            createTime: null,
          },
        ],
      },
    ]);
  });

  it("saklama önceki değere (TWO_MONTHS) döner", async () => {
    await appliedChange("RETENTION_14M");
    expect(
      (await createMockGaAdminWriter().getDataRetention(PROPERTY_ID))
        .eventDataRetention,
    ).toBe("FOURTEEN_MONTHS");
    fake.linkUpdates = [];
    await undoGaConfigChange(INPUT, deps());
    expect(
      (await createMockGaAdminWriter().getDataRetention(PROPERTY_ID))
        .eventDataRetention,
    ).toBe("TWO_MONTHS");
    expect(fake.linkUpdates).toEqual([{ dataRetention: "TWO_MONTHS" }]);
  });

  it("gelişmiş ölçüm yalnız değişen anahtarları geri alır", async () => {
    await appliedChange("ENHANCED_MEASUREMENT");
    await undoGaConfigChange(INPUT, deps());
    const settings = await createMockGaAdminWriter().getEnhancedMeasurement(
      PROPERTY_ID,
      STREAM_ID,
    );
    expect(settings).toMatchObject({
      streamEnabled: true,
      scrollsEnabled: false,
      outboundClicksEnabled: false,
      siteSearchEnabled: false,
      fileDownloadsEnabled: false,
    });
  });

  it("silmede 404 'zaten yok' sayılır, geri okumayla UNDONE olur", async () => {
    await appliedChange("KEY_EVENT_CREATE");
    const writer = createMockGaAdminWriter();
    const created = (await writer.listKeyEvents(PROPERTY_ID)).find(
      (e) => e.eventName === "generate_lead",
    );
    await writer.deleteKeyEvent(created?.name ?? "");
    const baseline = mockGaAdminCalls().length;
    const result = await undoGaConfigChange(INPUT, deps());
    expect(result).toEqual({ ok: true });
    expect(callsSince(baseline)).toEqual([
      "listKeyEvents",
      "deleteKeyEvent",
      "listKeyEvents",
    ]);
    expect(change().status).toBe("UNDONE");
  });
});

describe("başarısızlık VERIFIED'a döner", () => {
  it("Google hatası: VERIFIED + error.undo, mesaj döner", async () => {
    await appliedChange("KEY_EVENT_CREATE");
    setMockGaAdminFault("deleteKeyEvent", classedError("VALIDATION", 400));
    const result = await undoGaConfigChange(INPUT, deps());
    expect(result.ok).toBe(false);
    const row = change();
    expect(row.status).toBe("VERIFIED");
    expect(row.error).toMatchObject({ code: "rejected_by_google", undo: true });
    expect(row.leaseOwner).toBeNull();
    expect(row.rolledBackAt).toBeNull();
    expect(row.undoneByUserId).toBeNull();
    expect(recordGaFixAudit).not.toHaveBeenCalled();
  });

  it("SCOPE_MISSING düzenleme iznini de siler", async () => {
    await appliedChange("KEY_EVENT_CREATE");
    setMockGaAdminFault("deleteKeyEvent", classedError("SCOPE_MISSING", 403));
    await undoGaConfigChange(INPUT, deps());
    expect(clearGaEditGrant).toHaveBeenCalledWith("cred-1");
    expect(change().status).toBe("VERIFIED");
    expect(change().error).toMatchObject({ code: "scope_missing", undo: true });
  });

  it("geri okuma silinmediğini gösterirse VERIFIED + readback_mismatch", async () => {
    await appliedChange("KEY_EVENT_CREATE");
    const base = createMockGaAdminWriter();
    const writer = { ...base, deleteKeyEvent: async () => undefined };
    const result = await undoGaConfigChange(INPUT, deps({ writer }));
    expect(result.ok).toBe(false);
    expect(change().status).toBe("VERIFIED");
    expect(change().error).toMatchObject({
      code: "readback_mismatch",
      undo: true,
    });
    expect(change().undoneByUserId).toBeNull();
  });

  it("silinemez anahtar olay reddedilir, yazıcıya çağrı yok", async () => {
    setupChange("KEY_EVENT_CREATE", {
      status: "VERIFIED",
      openKey: null,
      resourceName: `properties/${PROPERTY_ID}/keyEvents/1`,
      before: {
        kind: "KEY_EVENT_CREATE",
        exists: false,
        resourceName: null,
        deletable: null,
      },
      after: {
        kind: "KEY_EVENT_CREATE",
        exists: true,
        resourceName: `properties/${PROPERTY_ID}/keyEvents/1`,
        deletable: false,
      },
    });
    const result = await undoGaConfigChange(INPUT, deps());
    expect(result.ok).toBe(false);
    expect(mockGaAdminCalls()).toEqual([]);
    expect(change().status).toBe("VERIFIED");
    expect(change().leaseOwner).toBeNull();
  });
});

describe("saklama ve gelişmiş ölçüm: sonradan elle değişmişse üzerine yazılmaz", () => {
  it("saklama tekrar değiştirildiyse cannot_undo, yazma yok", async () => {
    await appliedChange("RETENTION_14M");
    await createMockGaAdminWriter().updateDataRetention(
      PROPERTY_ID,
      "TWENTY_SIX_MONTHS",
    );
    const baseline = mockGaAdminCalls().length;
    const result = await undoGaConfigChange(INPUT, deps());
    expect(result).toEqual({ ok: false, message: CANNOT_UNDO });
    expect(mutating(callsSince(baseline))).toEqual([]);
    expect(change().status).toBe("VERIFIED");
    expect(change().error).toMatchObject({ code: "cannot_undo", undo: true });
    expect(
      (await createMockGaAdminWriter().getDataRetention(PROPERTY_ID))
        .eventDataRetention,
    ).toBe("TWENTY_SIX_MONTHS");
  });

  it("gelişmiş ölçüm tekrar değiştirildiyse cannot_undo, yazma yok", async () => {
    await appliedChange("ENHANCED_MEASUREMENT");
    await createMockGaAdminWriter().updateEnhancedMeasurement(
      PROPERTY_ID,
      STREAM_ID,
      { scrollsEnabled: false },
    );
    const baseline = mockGaAdminCalls().length;
    const result = await undoGaConfigChange(INPUT, deps());
    expect(result).toEqual({ ok: false, message: CANNOT_UNDO });
    expect(mutating(callsSince(baseline))).toEqual([]);
    expect(change().status).toBe("VERIFIED");
    expect(change().error).toMatchObject({ code: "cannot_undo", undo: true });
  });
});
