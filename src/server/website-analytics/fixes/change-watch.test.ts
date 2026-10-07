import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  GaChangeHistoryEvent,
  GaKeyEventResource,
} from "@/lib/website-analytics/fixes/resources";
import { GoogleApiError } from "@/server/integrations/google/errors";

// Bu dosyanın kanıtladığı: bayrak kapalıyken sorgusuz 0; ilk tur ve 3 günden
// eski boşluk yalnız imleci kurar; sonraki tur imleç-1 saat penceresini okur;
// Agentelse'in kendi değişiklikleri (kaynak adı, saklama tekil kaynağı)
// uyarı üretmez; elle anahtar olay silme WARN, saklama kısaltma INFO uyarısı
// açar; karar CANLI okumayla verilir (bağın eski sütunları değil), aynı turda
// açılan uyarı kapanmaz, geri gelmiş olay açılmaz, ertesi gün kapanır;
// stillOpen diğer bağların uyarılarını ve koşulu süren satırları taşır;
// 5 sayfada kesilince 'truncated' ve imleç ilerler; hatalar imleci
// ilerletmez, uyarı açmaz/kapatmaz; SCOPE_MISSING izni temizler; kira çift
// koşuyu önler; dev koruması ve mock uyuşmazlığı atlanır; hiçbir log ya da
// uyarı kimse bilgisi taşımaz.

const NOW = new Date("2026-10-07T09:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  linkFindMany: vi.fn(),
  watchUpsert: vi.fn(),
  watchFindUnique: vi.fn(),
  watchUpdateMany: vi.fn(),
  credentialFindUnique: vi.fn(),
  changeFindMany: vi.fn(),
  alertFindMany: vi.fn(),
  loadAccess: vi.fn(),
  clearGrant: vi.fn(),
  raise: vi.fn(),
  resolveMissing: vi.fn(),
  beat: vi.fn(),
  ok: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    gaPropertyLink: { findMany: mocks.linkFindMany },
    gaChangeWatch: {
      upsert: mocks.watchUpsert,
      findUnique: mocks.watchFindUnique,
      updateMany: mocks.watchUpdateMany,
    },
    integrationCredential: { findUnique: mocks.credentialFindUnique },
    gaConfigChange: { findMany: mocks.changeFindMany },
    adsAlert: { findMany: mocks.alertFindMany },
  },
}));
vi.mock("./edit-grant", () => ({
  loadGaEditAccess: mocks.loadAccess,
  clearGaEditGrant: mocks.clearGrant,
}));
vi.mock("@/server/monitoring/site-alerts", () => ({
  SiteAlerts: { raise: mocks.raise, resolveMissing: mocks.resolveMissing },
}));
vi.mock("@/server/observability/heartbeat", () => ({
  Heartbeat: { beat: mocks.beat, ok: mocks.ok },
}));

const { GaChangeWatcher } = await import("./change-watch");

const LINK = {
  id: "link-1",
  workspaceId: "ws-1",
  projectId: "proj-1",
  credentialId: "cred-1",
  propertyId: "424242",
  accountId: "777",
  isPrimary: true,
  isMock: false,
  // Eski sütun: bekçi buna bakmamalı.
  keyEvents: [{ eventName: "generate_lead" }] as unknown,
  dataRetention: "FOURTEEN_MONTHS" as string | null,
};

type Watch = {
  cursorAt: Date | null;
  lastRunAt: Date | null;
};

function keyEvent(eventName: string): GaKeyEventResource {
  return {
    name: `properties/424242/keyEvents/${eventName}`,
    eventName,
    countingMethod: null,
    custom: true,
    deletable: true,
  };
}

function removalEvent(
  eventName: string,
  at: Date,
  resource = "properties/424242/keyEvents/9",
): GaChangeHistoryEvent {
  return {
    id: `e-${eventName}`,
    changeTime: at.toISOString(),
    actorType: "USER",
    changes: [
      {
        resource,
        action: "DELETED",
        before: { keyEvent: { eventName } },
        after: null,
      },
    ],
  };
}

function retentionEvent(
  before: string,
  after: string,
  at: Date,
): GaChangeHistoryEvent {
  return {
    id: "e-retention",
    changeTime: at.toISOString(),
    actorType: "USER",
    changes: [
      {
        resource: "properties/424242/dataRetentionSettings",
        action: "UPDATED",
        before: { eventDataRetention: before },
        after: { eventDataRetention: after },
      },
    ],
  };
}

const writer = {
  searchChangeHistory: vi.fn(),
  listKeyEvents: vi.fn(),
  getDataRetention: vi.fn(),
};

let watch: Watch;
let claimCount: number;
let link: typeof LINK;
let openRows: {
  dedupeKey: string;
  kind: string;
  data: unknown;
}[];
let otherRows: { dedupeKey: string }[];

function deps(overrides: { mock?: boolean } = {}) {
  return {
    writer: writer as never,
    mock: overrides.mock ?? false,
    tokenFor: async () => "token",
  };
}

async function run() {
  return GaChangeWatcher.runDue(3, NOW, deps());
}

function finishCalls() {
  return mocks.watchUpdateMany.mock.calls
    .map(
      ([args]) =>
        args as {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        },
    )
    .filter((args) => !("OR" in args.where));
}

function lastFinish() {
  const calls = finishCalls();
  const last = calls[calls.length - 1];
  if (!last) throw new Error("no finish call");
  return last.data;
}

function resolveInput() {
  return mocks.resolveMissing.mock.calls[0]?.[0] as {
    stillOpen: Set<string>;
    kinds: string[];
    source: string;
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("GA_FIXES", "true");
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
  link = { ...LINK };
  watch = {
    cursorAt: new Date(NOW.getTime() - DAY),
    lastRunAt: new Date(NOW.getTime() - DAY),
  };
  claimCount = 1;
  openRows = [];
  otherRows = [];
  mocks.queryRaw.mockResolvedValue([{ id: "link-1" }]);
  mocks.linkFindMany.mockImplementation(() => Promise.resolve([link]));
  mocks.watchUpsert.mockImplementation(() =>
    Promise.resolve({ linkId: "link-1", ...watch }),
  );
  mocks.watchUpdateMany.mockImplementation(
    ({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve({ count: "OR" in where ? claimCount : 1 }),
  );
  mocks.loadAccess.mockResolvedValue({ granted: true, credentialId: "cred-1" });
  mocks.credentialFindUnique.mockResolvedValue({
    id: "cred-1",
    status: "ACTIVE",
    encryptedSecret: "secret",
  });
  mocks.changeFindMany.mockResolvedValue([]);
  mocks.alertFindMany.mockImplementation(
    ({ where }: { where: { NOT?: unknown } }) =>
      Promise.resolve(where.NOT ? otherRows : openRows),
  );
  mocks.raise.mockResolvedValue(undefined);
  mocks.resolveMissing.mockResolvedValue(0);
  mocks.clearGrant.mockResolvedValue(undefined);
  writer.searchChangeHistory.mockResolvedValue({
    events: [],
    nextPageToken: null,
  });
  writer.listKeyEvents.mockResolvedValue([keyEvent("purchase")]);
  writer.getDataRetention.mockResolvedValue({
    eventDataRetention: "TWO_MONTHS",
    resetUserDataOnNewActivity: true,
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GaChangeWatcher.runDue gates", () => {
  it("returns 0 with no database call when the flag is off", async () => {
    vi.stubEnv("GA_FIXES", "");
    expect(await run()).toBe(0);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(mocks.beat).not.toHaveBeenCalled();
    expect(mocks.watchUpsert).not.toHaveBeenCalled();
  });

  it("returns 0 when GA_SYNC is off even if GA_FIXES is on", async () => {
    vi.stubEnv("GA_SYNC", "");
    expect(await run()).toBe(0);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("skips a link whose lease is held by another process", async () => {
    claimCount = 0;
    expect(await run()).toBe(0);
    expect(writer.searchChangeHistory).not.toHaveBeenCalled();
    expect(finishCalls()).toHaveLength(0);
  });

  it("skips a mock/real mismatch before touching the watch row", async () => {
    link = { ...LINK, isMock: true };
    expect(await run()).toBe(0);
    expect(mocks.watchUpsert).not.toHaveBeenCalled();
    expect(writer.searchChangeHistory).not.toHaveBeenCalled();
  });

  it("skips projects outside the dev allow-list and sends the list to SQL", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.example.com/main");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "other-project");
    expect(await run()).toBe(0);
    const query = mocks.queryRaw.mock.calls[0]?.[0] as { values: unknown[] };
    expect(query.values).toContainEqual(["other-project"]);
    expect(mocks.watchUpsert).not.toHaveBeenCalled();
  });

  it("passes no allow-list to SQL outside a dev process", async () => {
    await run();
    const query = mocks.queryRaw.mock.calls[0]?.[0] as { values: unknown[] };
    expect(query.values.some((value) => Array.isArray(value))).toBe(false);
  });

  it("stops at the limit", async () => {
    mocks.queryRaw.mockResolvedValue([{ id: "link-1" }, { id: "link-2" }]);
    mocks.linkFindMany.mockResolvedValue([
      link,
      { ...LINK, id: "link-2", propertyId: "999" },
    ]);
    expect(await GaChangeWatcher.runDue(1, NOW, deps())).toBe(1);
  });

  it("writes the heartbeat", async () => {
    await run();
    expect(mocks.beat).toHaveBeenCalledWith("ga.changewatch", NOW);
    expect(mocks.ok).toHaveBeenCalledWith("ga.changewatch", NOW);
  });

  it("never throws out of runDue", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("db down"));
    await expect(run()).resolves.toBe(0);
  });
});

describe("cursor handling", () => {
  it("first run only sets the cursor and never reads history or alerts", async () => {
    watch = { cursorAt: null, lastRunAt: null };
    expect(await run()).toBe(1);
    expect(writer.searchChangeHistory).not.toHaveBeenCalled();
    expect(mocks.raise).not.toHaveBeenCalled();
    expect(mocks.resolveMissing).not.toHaveBeenCalled();
    expect(lastFinish()).toMatchObject({
      cursorAt: NOW,
      lastRunAt: NOW,
      lastError: null,
    });
  });

  it("treats a run after more than 3 days as a first run", async () => {
    watch = {
      cursorAt: new Date(NOW.getTime() - 5 * DAY),
      lastRunAt: new Date(NOW.getTime() - 4 * DAY),
    };
    expect(await run()).toBe(1);
    expect(writer.searchChangeHistory).not.toHaveBeenCalled();
    expect(lastFinish()).toMatchObject({ cursorAt: NOW });
  });

  it("reads from cursor minus one hour up to now and advances the cursor", async () => {
    expect(await run()).toBe(1);
    expect(writer.searchChangeHistory).toHaveBeenCalledTimes(1);
    expect(writer.searchChangeHistory).toHaveBeenCalledWith({
      accountId: "777",
      propertyId: "424242",
      earliest: new Date(watch.cursorAt!.getTime() - HOUR),
      latest: NOW,
      pageToken: undefined,
      pageSize: 100,
    });
    expect(lastFinish()).toMatchObject({
      cursorAt: NOW,
      lastRunAt: NOW,
      lastEventCount: 0,
      lastAlertCount: 0,
      lastError: null,
      leaseUntil: null,
      leaseOwner: null,
    });
    // Hiçbir olay ve açık uyarı yok: canlı okuma ve çözme yok.
    expect(writer.listKeyEvents).not.toHaveBeenCalled();
    expect(writer.getDataRetention).not.toHaveBeenCalled();
    expect(mocks.resolveMissing).not.toHaveBeenCalled();
  });

  it("flags 'truncated' after 5 pages and still advances the cursor", async () => {
    writer.searchChangeHistory.mockResolvedValue({
      events: [],
      nextPageToken: "more",
    });
    await run();
    expect(writer.searchChangeHistory).toHaveBeenCalledTimes(5);
    expect(lastFinish()).toMatchObject({
      cursorAt: NOW,
      lastError: "truncated",
    });
  });

  it("records 'unknown' for a link without an account id", async () => {
    link = { ...LINK, accountId: null as unknown as string };
    await run();
    expect(writer.searchChangeHistory).not.toHaveBeenCalled();
    expect(lastFinish()).toMatchObject({
      lastError: "unknown",
      lastRunAt: NOW,
    });
    expect(lastFinish()).not.toHaveProperty("cursorAt");
  });

  it("records 'scope_missing' when edit access is gone", async () => {
    mocks.loadAccess.mockResolvedValue({
      granted: false,
      credentialId: "cred-1",
    });
    await run();
    expect(writer.searchChangeHistory).not.toHaveBeenCalled();
    expect(lastFinish()).toMatchObject({ lastError: "scope_missing" });
  });
});

describe("own changes", () => {
  it("ignores a key event removal Agentelse made itself (undo)", async () => {
    const at = new Date(NOW.getTime() - 2 * HOUR);
    writer.searchChangeHistory.mockResolvedValue({
      events: [
        removalEvent("generate_lead", new Date(at.getTime() + 5 * 60_000)),
      ],
      nextPageToken: null,
    });
    mocks.changeFindMany.mockResolvedValue([
      {
        kind: "KEY_EVENT_CREATE",
        resourceName: "properties/424242/keyEvents/9",
        appliedAt: new Date(at.getTime() - DAY),
        rolledBackAt: at,
      },
    ]);
    await run();
    expect(mocks.raise).not.toHaveBeenCalled();
    expect(lastFinish()).toMatchObject({
      lastEventCount: 1,
      lastAlertCount: 0,
    });
  });

  it("ignores a retention change inside the singleton window of its own touch", async () => {
    const at = new Date(NOW.getTime() - 2 * HOUR);
    writer.searchChangeHistory.mockResolvedValue({
      events: [
        retentionEvent(
          "FOURTEEN_MONTHS",
          "TWO_MONTHS",
          new Date(at.getTime() + 10 * 60_000),
        ),
      ],
      nextPageToken: null,
    });
    mocks.changeFindMany.mockResolvedValue([
      {
        kind: "RETENTION_14M",
        resourceName: null,
        appliedAt: at,
        rolledBackAt: null,
      },
    ]);
    await run();
    expect(mocks.raise).not.toHaveBeenCalled();
  });

  it("still alerts for the same resource outside the own-touch window", async () => {
    const at = new Date(NOW.getTime() - 5 * HOUR);
    writer.searchChangeHistory.mockResolvedValue({
      events: [retentionEvent("FOURTEEN_MONTHS", "TWO_MONTHS", NOW)],
      nextPageToken: null,
    });
    mocks.changeFindMany.mockResolvedValue([
      {
        kind: "RETENTION_14M",
        resourceName: null,
        appliedAt: at,
        rolledBackAt: null,
      },
    ]);
    await run();
    expect(mocks.raise).toHaveBeenCalledTimes(1);
  });
});

describe("raising alerts from live state", () => {
  const removed = () =>
    writer.searchChangeHistory.mockResolvedValue({
      events: [removalEvent("generate_lead", new Date(NOW.getTime() - HOUR))],
      nextPageToken: null,
    });

  it("raises a WARN alert with the exact dedupeKey for a manual key event removal", async () => {
    removed();
    await run();
    expect(writer.listKeyEvents).toHaveBeenCalledWith("424242");
    expect(mocks.raise).toHaveBeenCalledTimes(1);
    const [input, at] = mocks.raise.mock.calls[0] as [
      Record<string, unknown>,
      Date,
    ];
    expect(input).toMatchObject({
      workspaceId: "ws-1",
      projectId: "proj-1",
      source: "GA4",
      kind: "GA_CHG_KEY_EVENT_REMOVED",
      severity: "WARN",
      dedupeKey: "ga4:link-1:CHG:KEY_EVENT_REMOVED:generate_lead",
      title: "A key event was removed in Google Analytics",
    });
    expect(at).toEqual(NOW);
    expect(lastFinish()).toMatchObject({ lastAlertCount: 1, cursorAt: NOW });
  });

  it("decides from the LIVE list, not the stale link column, and does not resolve it in the same run", async () => {
    // link.keyEvents hâlâ generate_lead'i listeliyor; canlı liste listelemiyor.
    expect(JSON.stringify(link.keyEvents)).toContain("generate_lead");
    removed();
    await run();
    expect(mocks.raise).toHaveBeenCalledTimes(1);
    const input = resolveInput();
    expect(
      input.stillOpen.has("ga4:link-1:CHG:KEY_EVENT_REMOVED:generate_lead"),
    ).toBe(true);
    expect(input.source).toBe("GA4");
    expect(input.kinds).toEqual([
      "GA_CHG_KEY_EVENT_REMOVED",
      "GA_CHG_RETENTION_SHORTENED",
    ]);
  });

  it("does not raise an event that is already back in the live list", async () => {
    removed();
    writer.listKeyEvents.mockResolvedValue([keyEvent("generate_lead")]);
    await run();
    expect(mocks.raise).not.toHaveBeenCalled();
    expect(resolveInput().stillOpen.size).toBe(0);
  });

  it("raises an INFO alert with data.before for a retention shortening", async () => {
    writer.searchChangeHistory.mockResolvedValue({
      events: [
        retentionEvent(
          "FOURTEEN_MONTHS",
          "TWO_MONTHS",
          new Date(NOW.getTime() - HOUR),
        ),
      ],
      nextPageToken: null,
    });
    await run();
    expect(writer.getDataRetention).toHaveBeenCalledWith("424242");
    const [input] = mocks.raise.mock.calls[0] as [Record<string, unknown>];
    expect(input).toMatchObject({
      kind: "GA_CHG_RETENTION_SHORTENED",
      severity: "INFO",
      dedupeKey: "ga4:link-1:CHG:RETENTION",
      title: "Event data retention was shortened in Google Analytics",
      data: { before: "FOURTEEN_MONTHS" },
    });
  });

  it("does not raise a retention alert when the live value was already restored", async () => {
    writer.searchChangeHistory.mockResolvedValue({
      events: [
        retentionEvent(
          "FOURTEEN_MONTHS",
          "TWO_MONTHS",
          new Date(NOW.getTime() - HOUR),
        ),
      ],
      nextPageToken: null,
    });
    writer.getDataRetention.mockResolvedValue({
      eventDataRetention: "FOURTEEN_MONTHS",
      resetUserDataOnNewActivity: true,
    });
    await run();
    expect(mocks.raise).not.toHaveBeenCalled();
  });

  it("never uses CRITICAL and keeps actor details out of alerts and logs", async () => {
    const event = removalEvent("generate_lead", new Date(NOW.getTime() - HOUR));
    writer.searchChangeHistory.mockResolvedValue({
      events: [
        { ...event, actorEmail: "someone@example.com" } as GaChangeHistoryEvent,
      ],
      nextPageToken: null,
    });
    await run();
    for (const [input] of mocks.raise.mock.calls as [
      Record<string, unknown>,
    ][]) {
      expect(input.severity).not.toBe("CRITICAL");
      expect(JSON.stringify(input)).not.toMatch(/someone@|@example/);
    }
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toMatch(/someone@|generate_lead/);
  });
});

describe("resolving alerts", () => {
  it("closes a key event alert on the next day once the event is back live", async () => {
    openRows = [
      {
        dedupeKey: "ga4:link-1:CHG:KEY_EVENT_REMOVED:generate_lead",
        kind: "GA_CHG_KEY_EVENT_REMOVED",
        data: null,
      },
    ];
    writer.listKeyEvents.mockResolvedValue([keyEvent("generate_lead")]);
    await run();
    expect(mocks.raise).not.toHaveBeenCalled();
    expect(
      resolveInput().stillOpen.has(
        "ga4:link-1:CHG:KEY_EVENT_REMOVED:generate_lead",
      ),
    ).toBe(false);
  });

  it("keeps an open alert (also a muted one) whose condition still holds live", async () => {
    openRows = [
      {
        dedupeKey: "ga4:link-1:CHG:KEY_EVENT_REMOVED:generate_lead",
        kind: "GA_CHG_KEY_EVENT_REMOVED",
        data: null,
      },
    ];
    await run();
    expect(
      resolveInput().stillOpen.has(
        "ga4:link-1:CHG:KEY_EVENT_REMOVED:generate_lead",
      ),
    ).toBe(true);
  });

  it("keeps the alerts of the project's other links so this run never closes them", async () => {
    otherRows = [
      { dedupeKey: "ga4:link-2:CHG:KEY_EVENT_REMOVED:whatsapp_click" },
      { dedupeKey: "ga4:link-2:CHG:RETENTION" },
    ];
    openRows = [
      {
        dedupeKey: "ga4:link-1:CHG:KEY_EVENT_REMOVED:generate_lead",
        kind: "GA_CHG_KEY_EVENT_REMOVED",
        data: null,
      },
    ];
    writer.listKeyEvents.mockResolvedValue([keyEvent("generate_lead")]);
    await run();
    const input = resolveInput();
    expect(
      input.stillOpen.has("ga4:link-2:CHG:KEY_EVENT_REMOVED:whatsapp_click"),
    ).toBe(true);
    expect(input.stillOpen.has("ga4:link-2:CHG:RETENTION")).toBe(true);
    const othersQuery = mocks.alertFindMany.mock.calls
      .map(
        ([args]) =>
          args as { where: { NOT?: { dedupeKey: { startsWith: string } } } },
      )
      .find((args) => args.where.NOT);
    expect(othersQuery?.where.NOT?.dedupeKey.startsWith).toBe(
      "ga4:link-1:CHG:",
    );
  });

  it.each([
    ["TWO_MONTHS", true],
    ["FOURTEEN_MONTHS", false],
    ["TWENTY_SIX_MONTHS", false],
  ])("retention alert with live %s stays open: %s", async (live, stays) => {
    openRows = [
      {
        dedupeKey: "ga4:link-1:CHG:RETENTION",
        kind: "GA_CHG_RETENTION_SHORTENED",
        data: { before: "FOURTEEN_MONTHS" },
      },
    ];
    writer.getDataRetention.mockResolvedValue({
      eventDataRetention: live,
      resetUserDataOnNewActivity: true,
    });
    await run();
    expect(resolveInput().stillOpen.has("ga4:link-1:CHG:RETENTION")).toBe(
      stays,
    );
  });

  it("without data.before the retention alert stays open while below 14 months", async () => {
    openRows = [
      {
        dedupeKey: "ga4:link-1:CHG:RETENTION",
        kind: "GA_CHG_RETENTION_SHORTENED",
        data: null,
      },
    ];
    await run();
    expect(resolveInput().stillOpen.has("ga4:link-1:CHG:RETENTION")).toBe(true);
  });
});

describe("errors", () => {
  it.each([
    ["AUTH", "reconnect"],
    ["PERMISSION", "permission"],
    ["RATE_LIMIT", "rate_limited"],
    ["SERVER_ERROR", "google_unavailable"],
    ["TRANSIENT", "google_unavailable"],
    ["UNKNOWN", "unknown"],
  ] as const)(
    "maps %s to lastError %s without moving the cursor or alerting",
    async (errorClass, code) => {
      writer.searchChangeHistory.mockRejectedValue(
        new GoogleApiError("boom", undefined, { errorClass }),
      );
      expect(await run()).toBe(1);
      const finish = lastFinish();
      expect(finish).toMatchObject({ lastError: code, lastRunAt: NOW });
      expect(finish).not.toHaveProperty("cursorAt");
      expect(mocks.raise).not.toHaveBeenCalled();
      expect(mocks.resolveMissing).not.toHaveBeenCalled();
      expect(mocks.clearGrant).not.toHaveBeenCalled();
    },
  );

  it("maps a non-Google error to unknown", async () => {
    writer.searchChangeHistory.mockRejectedValue(new Error("secret detail"));
    await run();
    expect(lastFinish()).toMatchObject({ lastError: "unknown" });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "secret detail",
    );
  });

  it("clears the edit grant on SCOPE_MISSING", async () => {
    writer.searchChangeHistory.mockRejectedValue(
      new GoogleApiError("scope", undefined, { errorClass: "SCOPE_MISSING" }),
    );
    await run();
    expect(mocks.clearGrant).toHaveBeenCalledWith("cred-1");
    expect(lastFinish()).toMatchObject({ lastError: "scope_missing" });
  });

  it("a failing live read after findings raises nothing, resolves nothing and keeps the cursor", async () => {
    writer.searchChangeHistory.mockResolvedValue({
      events: [removalEvent("generate_lead", new Date(NOW.getTime() - HOUR))],
      nextPageToken: null,
    });
    writer.listKeyEvents.mockRejectedValue(
      new GoogleApiError("down", undefined, { errorClass: "SERVER_ERROR" }),
    );
    await run();
    expect(mocks.raise).not.toHaveBeenCalled();
    expect(mocks.resolveMissing).not.toHaveBeenCalled();
    expect(lastFinish()).toMatchObject({ lastError: "google_unavailable" });
    expect(lastFinish()).not.toHaveProperty("cursorAt");
  });

  it("records 'reconnect' for a credential without a token", async () => {
    mocks.credentialFindUnique.mockResolvedValue({
      id: "cred-1",
      status: "ACTIVE",
      encryptedSecret: "",
    });
    await run();
    expect(writer.searchChangeHistory).not.toHaveBeenCalled();
    expect(lastFinish()).toMatchObject({ lastError: "reconnect" });
  });
});
