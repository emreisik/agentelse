import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  mockGaAdminCalls,
  resetMockGaAdmin,
  seedMockGaAdmin,
  setMockGaAdminFault,
  setMockGaAdminReadBackLie,
} from "@/server/integrations/google-analytics/admin-write-mock";
import { TaskRepository } from "@/server/repositories/task.repository";

import { applyGaConfigChange } from "./apply";
import { recordGaFixAudit } from "./audit";
import { clearGaEditGrant, loadGaEditAccess } from "./edit-grant";
import {
  NOW,
  PROPERTY_ID,
  change,
  classedError,
  createMockGaAdminWriter,
  failingFrom,
  fake,
  mutating,
  resetFake,
  transientError,
} from "./engine-b.testkit";

// Bu dosyanın kanıtladığı (GA-F7 uygulama motoru): onay yokken, bayrak
// kapalıyken, izin yokken ya da mülk değişmişken yazıcıya HİÇ mutating çağrı
// gitmez; her yazma [canlı okuma, yazma, canlı okuma] sırasıyla geri okunur;
// geri okuma yalanı FAILED readback_mismatch olur; geri okuması düşen satır
// ikinci bir yazma olmadan yeniden okunur; zaman aşımına uğrayan yazma
// yeniden denemede kopya üretmez.

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

const ANNOTATION_TITLE = "Agentelse: Spring sale launched";
const ANNOTATION_DAY = "2026-10-05";

type Fixture = {
  params: Record<string, unknown>;
  dedupeKey: string;
  calls: string[];
  readMethod: string;
  alreadyDone: Parameters<typeof seedMockGaAdmin>[1];
};

const FIXTURES: Record<Kind, Fixture> = {
  KEY_EVENT_CREATE: {
    params: { kind: "KEY_EVENT_CREATE", eventName: "generate_lead" },
    dedupeKey: "KEY_EVENT_CREATE:generate_lead",
    calls: ["listKeyEvents", "createKeyEvent", "listKeyEvents"],
    readMethod: "listKeyEvents",
    alreadyDone: { keyEvents: ["purchase", "generate_lead"] },
  },
  RETENTION_14M: {
    params: { kind: "RETENTION_14M" },
    dedupeKey: "RETENTION_14M:-",
    calls: ["getDataRetention", "updateDataRetention", "getDataRetention"],
    readMethod: "getDataRetention",
    alreadyDone: { retention: "FOURTEEN_MONTHS" },
  },
  ENHANCED_MEASUREMENT: {
    params: { kind: "ENHANCED_MEASUREMENT" },
    dedupeKey: "ENHANCED_MEASUREMENT:-",
    calls: [
      "getEnhancedMeasurement",
      "updateEnhancedMeasurement",
      "getEnhancedMeasurement",
    ],
    readMethod: "getEnhancedMeasurement",
    alreadyDone: {
      enhanced: {
        scrollsEnabled: true,
        outboundClicksEnabled: true,
        siteSearchEnabled: true,
        fileDownloadsEnabled: true,
        searchQueryParameter: "q",
      },
    },
  },
  CHANNEL_GROUP_AI: {
    params: { kind: "CHANNEL_GROUP_AI" },
    dedupeKey: "CHANNEL_GROUP_AI:-",
    calls: ["listChannelGroups", "createChannelGroup", "listChannelGroups"],
    readMethod: "listChannelGroups",
    alreadyDone: { channelGroups: ["AI assistants"] },
  },
  ANNOTATION_CREATE: {
    params: {
      kind: "ANNOTATION_CREATE",
      title: ANNOTATION_TITLE,
      day: ANNOTATION_DAY,
    },
    dedupeKey: `ANNOTATION_CREATE:launch:l1`,
    calls: ["listAnnotations", "createAnnotation", "listAnnotations"],
    readMethod: "listAnnotations",
    alreadyDone: {
      annotations: [{ title: ANNOTATION_TITLE, day: ANNOTATION_DAY }],
    },
  },
};

const KINDS = Object.keys(FIXTURES) as Kind[];
const LIE_METHOD = {
  KEY_EVENT_CREATE: "createKeyEvent",
  RETENTION_14M: "updateDataRetention",
  ENHANCED_MEASUREMENT: "updateEnhancedMeasurement",
  CHANNEL_GROUP_AI: "createChannelGroup",
  ANNOTATION_CREATE: "createAnnotation",
} as const;
const WRITE_METHOD = LIE_METHOD;

function setup(
  kind: Kind,
  options: {
    status?: string;
    link?: Record<string, unknown>;
    change?: Record<string, unknown>;
    seed?: Parameters<typeof seedMockGaAdmin>[1];
  } = {},
): void {
  const fixture = FIXTURES[kind];
  resetMockGaAdmin();
  seedMockGaAdmin(PROPERTY_ID, options.seed ?? {});
  resetFake({
    link: options.link,
    change: {
      kind,
      status: options.status ?? "APPROVED",
      params: fixture.params,
      dedupeKey: fixture.dedupeKey,
      openKey: fixture.dedupeKey,
      ...options.change,
    },
  });
}

function deps(
  overrides: Partial<Parameters<typeof applyGaConfigChange>[1]> = {},
): NonNullable<Parameters<typeof applyGaConfigChange>[1]> {
  return {
    writer: createMockGaAdminWriter(),
    mock: true,
    now: NOW,
    tokenFor: async () => "token",
    ...overrides,
  };
}

function plusMinutes(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * 60_000);
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
  vi.mocked(TaskRepository.transition).mockClear();
  setup("KEY_EVENT_CREATE");
});

describe("onay olmadan yazma yok", () => {
  it.each(["PROPOSED", "REJECTED", "EXPIRED", "FAILED", "UNDONE", "VERIFIED"])(
    "%s satırı için yazıcıya hiç çağrı gitmez ve satır değişmez",
    async (status) => {
      setup("KEY_EVENT_CREATE", { status });
      const before = { ...change() };
      const result = await applyGaConfigChange("chg-1", deps());
      expect(result).toEqual({ state: "skipped" });
      expect(mockGaAdminCalls()).toEqual([]);
      expect(change()).toEqual(before);
    },
  );

  it.each(["PENDING", "REJECTED", "EXPIRED"])(
    "Approval %s iken APPROVED satır FAILED approval_missing olur, yazıcı çağrılmaz",
    async (approvalStatus) => {
      fake.approval = { id: "appr-1", status: approvalStatus, expiresAt: null };
      const result = await applyGaConfigChange("chg-1", deps());
      expect(result).toEqual({ state: "failed" });
      expect(mockGaAdminCalls()).toEqual([]);
      expect(change().status).toBe("FAILED");
      expect(change().openKey).toBeNull();
      expect(change().error).toMatchObject({ code: "approval_missing" });
    },
  );

  it("approvalId'si olmayan satır FAILED approval_missing olur", async () => {
    change().approvalId = null;
    await applyGaConfigChange("chg-1", deps());
    expect(mockGaAdminCalls()).toEqual([]);
    expect(change().error).toMatchObject({ code: "approval_missing" });
  });

  it("onay süresi geçmiş ama Approval APPROVED ise yine uygulanır", async () => {
    fake.approval = {
      id: "appr-1",
      status: "APPROVED",
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    };
    const result = await applyGaConfigChange("chg-1", deps());
    expect(result).toEqual({ state: "verified" });
    expect(mutating(mockGaAdminCalls())).toEqual(["createKeyEvent"]);
  });
});

describe("bayraklar ve kapılar", () => {
  it("GA_FIXES kapalıyken skipped, satıra ve yazıcıya dokunulmaz", async () => {
    vi.stubEnv("GA_FIXES", "false");
    const before = { ...change() };
    expect(await applyGaConfigChange("chg-1", deps())).toEqual({
      state: "skipped",
    });
    expect(mockGaAdminCalls()).toEqual([]);
    expect(change()).toEqual(before);
    expect(loadGaEditAccess).not.toHaveBeenCalled();
  });

  it("GA_SYNC kapalıyken skipped", async () => {
    vi.stubEnv("GA_SYNC", "false");
    expect(await applyGaConfigChange("chg-1", deps())).toEqual({
      state: "skipped",
    });
    expect(change().status).toBe("APPROVED");
  });

  it("alpha anahtarı kapalıyken onaylı alpha satırı beklemeye kalır (FAILED olmaz)", async () => {
    vi.stubEnv("GA_FIXES_ALPHA", "false");
    setup("CHANNEL_GROUP_AI");
    const before = { ...change() };
    expect(await applyGaConfigChange("chg-1", deps())).toEqual({
      state: "skipped",
    });
    expect(change().status).toBe("APPROVED");
    expect(change()).toEqual(before);
    expect(mockGaAdminCalls()).toEqual([]);
  });

  it("alpha anahtarı kapalıyken v1beta satırı yine uygulanır", async () => {
    vi.stubEnv("GA_FIXES_ALPHA", "false");
    expect(await applyGaConfigChange("chg-1", deps())).toEqual({
      state: "verified",
    });
  });

  it("düzenleme izni yoksa FAILED no_edit_access, yazıcıya çağrı yok", async () => {
    vi.mocked(loadGaEditAccess).mockResolvedValue(null);
    const result = await applyGaConfigChange("chg-1", deps());
    expect(result).toEqual({ state: "failed" });
    expect(mockGaAdminCalls()).toEqual([]);
    expect(change().error).toMatchObject({ code: "no_edit_access" });
  });

  it("izin verilmemişse (granted false) yazıcıya çağrı yok", async () => {
    vi.mocked(loadGaEditAccess).mockResolvedValue({
      credentialId: "cred-1",
      workspaceId: "ws-1",
      granted: false,
      grantedAt: null,
      grantedByUserId: null,
      connectedEmail: null,
      mock: false,
    });
    await applyGaConfigChange("chg-1", deps());
    expect(mockGaAdminCalls()).toEqual([]);
    expect(change().error).toMatchObject({ code: "no_edit_access" });
  });

  it("mülk değiştiyse (bağ artık birincil değil) property_changed", async () => {
    setup("KEY_EVENT_CREATE", { link: { isPrimary: false } });
    await applyGaConfigChange("chg-1", deps());
    expect(mockGaAdminCalls()).toEqual([]);
    expect(change().error).toMatchObject({ code: "property_changed" });
  });

  it("izin başka bir bağlantıya aitse property_changed", async () => {
    vi.mocked(loadGaEditAccess).mockResolvedValue({
      credentialId: "cred-other",
      workspaceId: "ws-1",
      granted: true,
      grantedAt: null,
      grantedByUserId: null,
      connectedEmail: null,
      mock: true,
    });
    await applyGaConfigChange("chg-1", deps());
    expect(mockGaAdminCalls()).toEqual([]);
    expect(change().error).toMatchObject({ code: "property_changed" });
  });

  it("bağlantı ACTIVE değilse reconnect", async () => {
    fake.credential = { ...fake.credential, status: "EXPIRED" };
    await applyGaConfigChange("chg-1", deps());
    expect(mockGaAdminCalls()).toEqual([]);
    expect(change().error).toMatchObject({ code: "reconnect" });
  });

  it("mock süreç + gerçek bağ: FAILED not_enabled, bağ sütunlarına dokunulmaz", async () => {
    setup("KEY_EVENT_CREATE", { link: { isMock: false } });
    await applyGaConfigChange("chg-1", deps({ mock: true }));
    expect(mockGaAdminCalls()).toEqual([]);
    expect(change().error).toMatchObject({ code: "not_enabled" });
    expect(fake.linkUpdates).toEqual([]);
    expect(fake.healthRuns).toEqual([]);
  });

  it("gerçek süreç + mock bağ: FAILED not_enabled, bağ sütunlarına dokunulmaz", async () => {
    setup("KEY_EVENT_CREATE", { link: { isMock: true } });
    await applyGaConfigChange("chg-1", deps({ mock: false }));
    expect(mockGaAdminCalls()).toEqual([]);
    expect(change().error).toMatchObject({ code: "not_enabled" });
    expect(fake.linkUpdates).toEqual([]);
  });

  it("kilit alınmışsa busy, olmayan satır için gone", async () => {
    change().leaseUntil = plusMinutes(1);
    expect(await applyGaConfigChange("chg-1", deps())).toEqual({
      state: "busy",
    });
    expect(await applyGaConfigChange("yok", deps())).toEqual({ state: "gone" });
    expect(mockGaAdminCalls()).toEqual([]);
  });

  it("nextAttemptAt gelmemişse busy", async () => {
    change().nextAttemptAt = plusMinutes(5);
    expect(await applyGaConfigChange("chg-1", deps())).toEqual({
      state: "busy",
    });
    expect(mockGaAdminCalls()).toEqual([]);
  });
});

describe("her yazma geri okunur", () => {
  it.each(KINDS)(
    "%s: çağrı sırası [okuma, yazma, okuma] ve VERIFIED",
    async (kind) => {
      setup(kind);
      const result = await applyGaConfigChange("chg-1", deps());
      expect(result).toEqual({ state: "verified" });
      expect(mockGaAdminCalls()).toEqual(FIXTURES[kind].calls);

      const row = change();
      expect(row.status).toBe("VERIFIED");
      expect(row.noop).toBe(false);
      expect(row.openKey).toBeNull();
      expect(row.verifiedAt).toEqual(NOW);
      expect(row.appliedAt).toEqual(NOW);
      expect(row.before).not.toBeNull();
      expect(row.after).not.toBeNull();
      expect(row.leaseUntil).toBeNull();
      expect(row.leaseOwner).toBeNull();
      expect(row.attempts).toBe(1);
      expect(row.error).toBeNull();

      expect(recordGaFixAudit).toHaveBeenCalledWith(
        "ga_config_change.verified",
        expect.objectContaining({ changeId: "chg-1", kind }),
        { workspaceId: "ws-1", projectId: "proj-1" },
      );
      expect(TaskRepository.transition).toHaveBeenNthCalledWith(
        1,
        "task-1",
        "proj-1",
        "RUNNING",
      );
      expect(TaskRepository.transition).toHaveBeenNthCalledWith(
        2,
        "task-1",
        "proj-1",
        "COMPLETED",
        undefined,
      );
      expect(fake.healthRuns).toHaveLength(1);
      expect(fake.healthRuns[0]).toMatchObject({
        where: { linkId: "link-1" },
        data: { recheckRequestedAt: NOW },
      });
    },
  );

  it("anahtar olay yazması bağın keyEvents sütununu {eventName, countingMethod, createTime:null} ile günceller", async () => {
    await applyGaConfigChange("chg-1", deps());
    expect(fake.linkUpdates).toHaveLength(1);
    const keyEvents = fake.linkUpdates[0]?.keyEvents as unknown[];
    expect(keyEvents).toContainEqual({
      eventName: "generate_lead",
      countingMethod: "ONCE_PER_EVENT",
      createTime: null,
    });
    expect(keyEvents).toContainEqual({
      eventName: "purchase",
      countingMethod: "ONCE_PER_EVENT",
      createTime: null,
    });
  });

  it("saklama yazması bağın dataRetention sütununu günceller", async () => {
    setup("RETENTION_14M");
    await applyGaConfigChange("chg-1", deps());
    expect(fake.linkUpdates).toEqual([{ dataRetention: "FOURTEEN_MONTHS" }]);
  });

  it.each(KINDS)(
    "%s: geri okuma yalanı FAILED readback_mismatch olur, appliedAt kalır",
    async (kind) => {
      setup(kind);
      setMockGaAdminReadBackLie(LIE_METHOD[kind], true);
      const result = await applyGaConfigChange("chg-1", deps());
      expect(result).toEqual({ state: "failed" });
      expect(mockGaAdminCalls()).toEqual(FIXTURES[kind].calls);
      const row = change();
      expect(row.status).toBe("FAILED");
      expect(row.error).toMatchObject({ code: "readback_mismatch" });
      expect(row.appliedAt).toEqual(NOW);
      expect(row.after).toBeNull();
      expect(row.openKey).toBeNull();
      expect(fake.linkUpdates).toEqual([]);
      expect(TaskRepository.transition).toHaveBeenLastCalledWith(
        "task-1",
        "proj-1",
        "FAILED",
        { failureReason: expect.any(String) },
      );
      expect(recordGaFixAudit).toHaveBeenCalledWith(
        "ga_config_change.failed",
        expect.objectContaining({ code: "readback_mismatch" }),
        expect.anything(),
      );
    },
  );
});

describe("zaten sağlanmış hedef: yazma yok", () => {
  it.each(KINDS)("%s: noop VERIFIED, yalnız tek okuma", async (kind) => {
    setup(kind, { seed: FIXTURES[kind].alreadyDone });
    const result = await applyGaConfigChange("chg-1", deps());
    expect(result).toEqual({ state: "noop" });
    expect(mockGaAdminCalls()).toEqual([FIXTURES[kind].readMethod]);
    const row = change();
    expect(row.status).toBe("VERIFIED");
    expect(row.noop).toBe(true);
    expect(row.before).toEqual(row.after);
    expect(row.openKey).toBeNull();
  });

  it("anahtar olay sınırı doluysa FAILED limit_reached, yazma yok", async () => {
    const names = ["purchase"];
    for (let i = 1; i < 30; i += 1) names.push(`custom_event_${i}`);
    setup("KEY_EVENT_CREATE", { seed: { keyEvents: names } });
    const result = await applyGaConfigChange("chg-1", deps());
    expect(result).toEqual({ state: "failed" });
    expect(mutating(mockGaAdminCalls())).toEqual([]);
    expect(change().error).toMatchObject({ code: "limit_reached" });
  });

  it("create üzerinde 409: yeniden okur, VERIFIED noop", async () => {
    setMockGaAdminFault("createKeyEvent", classedError("VALIDATION", 409), {
      after: true,
      times: 1,
    });
    const result = await applyGaConfigChange("chg-1", deps());
    expect(result).toEqual({ state: "noop" });
    expect(mockGaAdminCalls()).toEqual([
      "listKeyEvents",
      "createKeyEvent",
      "listKeyEvents",
    ]);
    expect(change().status).toBe("VERIFIED");
    expect(change().noop).toBe(true);
  });
});

describe("hata yönetimi", () => {
  it("SCOPE_MISSING düzenleme iznini siler ve FAILED scope_missing olur", async () => {
    setMockGaAdminFault("createKeyEvent", classedError("SCOPE_MISSING", 403));
    const result = await applyGaConfigChange("chg-1", deps());
    expect(result).toEqual({ state: "failed" });
    expect(clearGaEditGrant).toHaveBeenCalledWith("cred-1");
    expect(change().error).toMatchObject({ code: "scope_missing" });
  });

  it("yazma öncesi geçici hata: APPROVED'a döner, nextAttemptAt ve kilit bırakılır", async () => {
    setMockGaAdminFault("listKeyEvents", transientError());
    const result = await applyGaConfigChange("chg-1", deps());
    expect(result).toEqual({ state: "retry" });
    const row = change();
    expect(row.status).toBe("APPROVED");
    expect(row.nextAttemptAt).toEqual(plusMinutes(2));
    expect(row.leaseUntil).toBeNull();
    expect(row.leaseOwner).toBeNull();
    expect(row.attempts).toBe(1);
    expect(mutating(mockGaAdminCalls())).toEqual([]);
    expect(TaskRepository.transition).not.toHaveBeenCalled();
    expect(recordGaFixAudit).not.toHaveBeenCalled();
  });

  it("üçüncü denemede aynı hata FAILED olur", async () => {
    setMockGaAdminFault("listKeyEvents", transientError());
    expect(await applyGaConfigChange("chg-1", deps())).toEqual({
      state: "retry",
    });
    expect(
      await applyGaConfigChange("chg-1", deps({ now: plusMinutes(3) })),
    ).toEqual({ state: "retry" });
    expect(change().nextAttemptAt).toEqual(plusMinutes(13));
    const third = await applyGaConfigChange(
      "chg-1",
      deps({ now: plusMinutes(20) }),
    );
    expect(third).toEqual({ state: "failed" });
    expect(change().status).toBe("FAILED");
    expect(change().attempts).toBe(3);
    expect(change().error).toMatchObject({ code: "google_unavailable" });
    expect(mutating(mockGaAdminCalls())).toEqual([]);
  });

  it("kalıcı hata (izin yok) yeniden denenmeden FAILED olur", async () => {
    setMockGaAdminFault("listKeyEvents", classedError("PERMISSION", 403));
    const result = await applyGaConfigChange("chg-1", deps());
    expect(result).toEqual({ state: "failed" });
    expect(change().error).toMatchObject({ code: "no_property_access" });
  });

  it("gelişmiş ölçüm için akış yoksa FAILED no_stream, yazıcıya çağrı yok", async () => {
    setup("ENHANCED_MEASUREMENT", { link: { streamId: null } });
    await applyGaConfigChange("chg-1", deps());
    expect(mockGaAdminCalls()).toEqual([]);
    expect(change().error).toMatchObject({ code: "no_stream" });
  });
});

describe("zaman aşımına uğrayan yazma kopya üretmez", () => {
  it("anahtar olay: yazıldı ama istek hata verdi, yeniden deneme noop olur", async () => {
    setMockGaAdminFault("createKeyEvent", transientError(), {
      after: true,
      times: 1,
    });
    expect(await applyGaConfigChange("chg-1", deps())).toEqual({
      state: "retry",
    });
    expect(change().status).toBe("APPROVED");

    const second = await applyGaConfigChange(
      "chg-1",
      deps({ now: plusMinutes(3) }),
    );
    expect(second).toEqual({ state: "noop" });
    expect(mutating(mockGaAdminCalls())).toEqual(["createKeyEvent"]);
    const writer = createMockGaAdminWriter();
    const events = await writer.listKeyEvents(PROPERTY_ID);
    expect(events.filter((e) => e.eventName === "generate_lead")).toHaveLength(
      1,
    );
    expect(change().noop).toBe(true);
  });

  it("not: yazıldı ama istek hata verdi, yeniden deneme noop olur", async () => {
    setup("ANNOTATION_CREATE");
    setMockGaAdminFault("createAnnotation", transientError(), {
      after: true,
      times: 1,
    });
    expect(await applyGaConfigChange("chg-1", deps())).toEqual({
      state: "retry",
    });
    const second = await applyGaConfigChange(
      "chg-1",
      deps({ now: plusMinutes(3) }),
    );
    expect(second).toEqual({ state: "noop" });
    expect(mutating(mockGaAdminCalls())).toEqual(["createAnnotation"]);
    const writer = createMockGaAdminWriter();
    expect(await writer.listAnnotations(PROPERTY_ID)).toHaveLength(1);
  });
});

describe("geri okuması düşen satır: ikinci yazma yok", () => {
  it("geri okuma hata verirse APPLIED kalır, kilit bırakılır", async () => {
    const writer = failingFrom(
      createMockGaAdminWriter(),
      "listKeyEvents",
      1,
      transientError(),
    );
    const result = await applyGaConfigChange("chg-1", deps({ writer }));
    expect(result).toEqual({ state: "retry" });
    const row = change();
    expect(row.status).toBe("APPLIED");
    expect(row.appliedAt).toEqual(NOW);
    expect(row.nextAttemptAt).toEqual(plusMinutes(2));
    expect(row.leaseOwner).toBeNull();
    expect(row.openKey).toBe("KEY_EVENT_CREATE:generate_lead");
    expect(mutating(mockGaAdminCalls())).toEqual(["createKeyEvent"]);
  });

  it("3 kilit alımından sonra FAILED google_unavailable, appliedAt kalır, ikinci yazma yok", async () => {
    const writer = failingFrom(
      createMockGaAdminWriter(),
      "listKeyEvents",
      1,
      transientError(),
    );
    expect(await applyGaConfigChange("chg-1", deps({ writer }))).toEqual({
      state: "retry",
    });
    // Bekleme süresi dolmadan: busy.
    expect(await applyGaConfigChange("chg-1", deps({ writer }))).toEqual({
      state: "busy",
    });
    expect(
      await applyGaConfigChange("chg-1", deps({ writer, now: plusMinutes(3) })),
    ).toEqual({ state: "retry" });
    expect(
      await applyGaConfigChange(
        "chg-1",
        deps({ writer, now: plusMinutes(20) }),
      ),
    ).toEqual({ state: "failed" });
    const row = change();
    expect(row.status).toBe("FAILED");
    expect(row.error).toMatchObject({ code: "google_unavailable" });
    expect(row.appliedAt).toEqual(NOW);
    expect(row.attempts).toBe(3);
    expect(mutating(mockGaAdminCalls())).toEqual(["createKeyEvent"]);
  });

  it("yazma öncesi 2 deneme tükenmiş olsa da geri okuma kendi bütçesini kullanır", async () => {
    const inner = failingFrom(
      createMockGaAdminWriter(),
      "listKeyEvents",
      0,
      transientError(),
      2,
    );
    // Dış sarmalayıcı 4. çağrıyı (geri okuma) düşürür.
    const writer = failingFrom(
      inner,
      "listKeyEvents",
      3,
      transientError(),
      4,
    );
    expect(await applyGaConfigChange("chg-1", deps({ writer }))).toEqual({
      state: "retry",
    });
    expect(
      await applyGaConfigChange("chg-1", deps({ writer, now: plusMinutes(3) })),
    ).toEqual({ state: "retry" });
    // 3. deneme yazar, geri okuması düşer: FAILED değil, APPLIED beklemede.
    expect(
      await applyGaConfigChange(
        "chg-1",
        deps({ writer, now: plusMinutes(20) }),
      ),
    ).toEqual({ state: "retry" });
    expect(change().status).toBe("APPLIED");
    expect(
      await applyGaConfigChange(
        "chg-1",
        deps({ writer, now: plusMinutes(60) }),
      ),
    ).toEqual({ state: "verified" });
    expect(change().status).toBe("VERIFIED");
    expect(mutating(mockGaAdminCalls())).toEqual(["createKeyEvent"]);
  });

  it.each(KINDS)(
    "%s: geri okuma toparlanırsa yazma tekrarlanmadan VERIFIED olur",
    async (kind) => {
      setup(kind);
      const writer = failingFrom(
        createMockGaAdminWriter(),
        FIXTURES[kind].readMethod as "listKeyEvents",
        1,
        transientError(),
        2,
      );
      expect(await applyGaConfigChange("chg-1", deps({ writer }))).toEqual({
        state: "retry",
      });
      expect(change().status).toBe("APPLIED");

      const second = await applyGaConfigChange(
        "chg-1",
        deps({ writer, now: plusMinutes(3) }),
      );
      expect(second).toEqual({ state: "verified" });
      expect(mutating(mockGaAdminCalls())).toEqual([WRITE_METHOD[kind]]);
      const row = change();
      expect(row.status).toBe("VERIFIED");
      expect(row.after).not.toBeNull();
      expect(row.noop).toBe(false);
      expect(row.openKey).toBeNull();
    },
  );

  it("alpha anahtarı kapanınca yazması dönmüş alpha satırı yine geri okunup doğrulanır", async () => {
    setup("CHANNEL_GROUP_AI");
    const method = FIXTURES.CHANNEL_GROUP_AI.readMethod as "listKeyEvents";
    const writer = failingFrom(
      createMockGaAdminWriter(),
      method,
      1,
      transientError(),
      2,
    );
    expect(await applyGaConfigChange("chg-1", deps({ writer }))).toEqual({
      state: "retry",
    });
    expect(change().status).toBe("APPLIED");
    vi.stubEnv("GA_FIXES_ALPHA", "false");
    expect(
      await applyGaConfigChange("chg-1", deps({ writer, now: plusMinutes(3) })),
    ).toEqual({ state: "verified" });
    expect(mutating(mockGaAdminCalls())).toEqual([
      WRITE_METHOD.CHANNEL_GROUP_AI,
    ]);
  });

  it("geri okuma-yalnız yolu onay satırına bakmaz ama bağ kapılarını sorar", async () => {
    const writer = failingFrom(
      createMockGaAdminWriter(),
      "listKeyEvents",
      1,
      transientError(),
      2,
    );
    await applyGaConfigChange("chg-1", deps({ writer }));
    fake.approval = { id: "appr-1", status: "CANCELLED", expiresAt: null };
    const second = await applyGaConfigChange(
      "chg-1",
      deps({ writer, now: plusMinutes(3) }),
    );
    expect(second).toEqual({ state: "verified" });

    setup("KEY_EVENT_CREATE");
    const flaky = failingFrom(
      createMockGaAdminWriter(),
      "listKeyEvents",
      1,
      transientError(),
      2,
    );
    await applyGaConfigChange("chg-1", deps({ writer: flaky }));
    fake.credential = { ...fake.credential, status: "EXPIRED" };
    const third = await applyGaConfigChange(
      "chg-1",
      deps({ writer: flaky, now: plusMinutes(3) }),
    );
    expect(third).toEqual({ state: "failed" });
    expect(change().error).toMatchObject({ code: "reconnect" });
    expect(change().appliedAt).toEqual(NOW);
  });
});
