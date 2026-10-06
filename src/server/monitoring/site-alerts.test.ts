import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  projectFind: vi.fn(),
  credentialFind: vi.fn(),
  notifyProject: vi.fn(),
  operatorTelegram: vi.fn(),
  excluded: vi.fn(),
  telegramAllowed: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    adsAlert: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
      update: mocks.update,
      updateMany: mocks.updateMany,
      findMany: mocks.findMany,
      deleteMany: mocks.deleteMany,
    },
    project: { findUnique: mocks.projectFind },
    integrationCredential: { findFirst: mocks.credentialFind },
  },
}));
vi.mock("@/server/notifications/project-telegram-notifier", () => ({
  notifyProjectTelegram: mocks.notifyProject,
}));
vi.mock("@/server/notifications/telegram.service", () => ({
  sendTelegramMessage: mocks.operatorTelegram,
}));
vi.mock("@/server/website-analytics/reports/settings", () => ({
  gaAlertTelegramAllowed: mocks.telegramAllowed,
}));
vi.mock("@/lib/local-worker-policy", () => ({
  metaWorkExcludedHere: mocks.excluded,
}));
vi.mock("@/lib/app-url", () => ({
  appUrl: (path: string) => new URL(path, "https://app.example"),
}));
vi.mock("@/lib/seo/health/alert-kinds", () => ({
  SEARCH_TELEGRAM_FALLBACK: "a search health check needs attention",
  seoTelegramPhrase: () => "a search health check needs attention",
}));

import { SiteAlerts } from "./site-alerts";

// Bu dosyanın kanıtladığı: CRITICAL site uyarısı yalnız projenin kendi
// Telegram'ına gider (operatöre asla), bağlı sohbet yoksa yalnız uygulama
// içi kalır; yerel geliştirme koruması ve CAS gönderimi durdurur; GA_MH24
// günlük yeniden bildirilmez; listOpen/mute yalnız site uyarılarına dokunur.

const now = new Date("2026-10-06T10:00:00Z");
const hours = (h: number) => new Date(now.getTime() - h * 3_600_000);
const input = {
  workspaceId: "w1",
  projectId: "p1",
  source: "GA4" as const,
  kind: "GA_MH1",
  severity: "CRITICAL" as const,
  dedupeKey: "ga4:link1:MH1",
  title: "Google Analytics stopped receiving data",
  detail: null,
  data: { checkKey: "MH1", linkId: "link1" },
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    workspaceId: "w1",
    projectId: "p1",
    source: "GA4",
    kind: "GA_MH1",
    severity: "CRITICAL",
    status: "OPEN",
    dedupeKey: "ga4:link1:MH1",
    title: input.title,
    detail: null,
    notifiedAt: null,
    mutedUntil: null,
    lastSeenAt: now,
    ...overrides,
  };
}

describe("SiteAlerts.raise", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ALLOW_DEV_NOTIFICATIONS", "");
    mocks.excluded.mockReturnValue(false);
    mocks.telegramAllowed.mockResolvedValue(true);
    mocks.projectFind.mockResolvedValue({ name: "Acme" });
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.credentialFind.mockResolvedValue({ metadata: { chatId: "123" } });
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue(row());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws when the dedupe prefix does not match the source", async () => {
    await expect(
      SiteAlerts.raise({ ...input, dedupeKey: "gsc:x" }, now),
    ).rejects.toThrow();
    await expect(
      SiteAlerts.raise({ ...input, source: "SEO" }, now),
    ).rejects.toThrow();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("creates a new row with its source and firstSeenAt", async () => {
    await SiteAlerts.raise(input, now);
    const call = mocks.upsert.mock.calls[0]![0];
    expect(call.where).toEqual({
      projectId_dedupeKey: { projectId: "p1", dedupeKey: "ga4:link1:MH1" },
    });
    expect(call.create).toMatchObject({
      source: "GA4",
      firstSeenAt: now,
      lastSeenAt: now,
      kind: "GA_MH1",
    });
  });

  it("sends a new CRITICAL alert once to the project's own Telegram", async () => {
    await SiteAlerts.raise(input, now);
    expect(mocks.notifyProject).toHaveBeenCalledOnce();
    const [projectId, text] = mocks.notifyProject.mock.calls[0]!;
    expect(projectId).toBe("p1");
    expect(text).toContain("Website tracking alert for Acme");
    expect(mocks.updateMany.mock.calls[0]![0].data).toEqual({
      notifiedAt: now,
      notifyChannels: ["in_app", "telegram"],
    });
    expect(mocks.updateMany.mock.calls[0]![0].where).toMatchObject({
      id: "a1",
      status: "OPEN",
    });
    expect(mocks.operatorTelegram).not.toHaveBeenCalled();
  });

  it("stays in-app without a project Telegram connection", async () => {
    mocks.credentialFind.mockResolvedValue(null);
    await SiteAlerts.raise(input, now);
    expect(mocks.updateMany.mock.calls[0]![0].data.notifyChannels).toEqual([
      "in_app",
    ]);
    expect(mocks.notifyProject).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.excluded.mockReturnValue(false);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue(row());
    mocks.credentialFind.mockResolvedValue({ metadata: { chatId: 42 } });
    await SiteAlerts.raise(input, now);
    expect(mocks.updateMany.mock.calls[0]![0].data.notifyChannels).toEqual([
      "in_app",
    ]);
    expect(mocks.notifyProject).not.toHaveBeenCalled();
    expect(mocks.operatorTelegram).not.toHaveBeenCalled();
  });

  it("keeps a GA4 alert in-app when the project turned Telegram off (GA-F5)", async () => {
    mocks.telegramAllowed.mockResolvedValue(false);
    await SiteAlerts.raise(input, now);
    expect(mocks.telegramAllowed).toHaveBeenCalledWith("p1");
    expect(mocks.notifyProject).not.toHaveBeenCalled();
    expect(mocks.updateMany.mock.calls[0]![0].data.notifyChannels).toEqual([
      "in_app",
    ]);
  });

  it("never consults the GA preference for a Search Console alert", async () => {
    mocks.telegramAllowed.mockResolvedValue(false);
    mocks.upsert.mockResolvedValue(
      row({ source: "GSC", kind: "SH1", dedupeKey: "gsc:link1:SH1" }),
    );
    await SiteAlerts.raise(
      {
        ...input,
        source: "GSC",
        kind: "SH1",
        dedupeKey: "gsc:link1:SH1",
        data: { checkKey: "SH1" },
      },
      now,
    );
    expect(mocks.telegramAllowed).not.toHaveBeenCalled();
    expect(mocks.notifyProject).toHaveBeenCalledOnce();
  });

  it("the dev guard stops before any claim or send", async () => {
    mocks.excluded.mockReturnValue(true);
    await SiteAlerts.raise(input, now);
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.notifyProject).not.toHaveBeenCalled();

    vi.stubEnv("ALLOW_DEV_NOTIFICATIONS", "true");
    await SiteAlerts.raise(input, now);
    expect(mocks.notifyProject).toHaveBeenCalledOnce();
  });

  it("a lost CAS claim sends nothing", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    await SiteAlerts.raise(input, now);
    expect(mocks.notifyProject).not.toHaveBeenCalled();
  });

  it("re-notifies GA_MH1 after a day but never GA_MH24", async () => {
    mocks.findUnique.mockResolvedValue(row({ notifiedAt: hours(25) }));
    mocks.update.mockResolvedValue(row({ notifiedAt: hours(25) }));
    await SiteAlerts.raise(input, now);
    expect(mocks.notifyProject).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    mocks.excluded.mockReturnValue(false);
    const mh24 = row({
      kind: "GA_MH24",
      dedupeKey: "ga4:link1:MH24",
      notifiedAt: hours(25),
    });
    mocks.findUnique.mockResolvedValue(mh24);
    mocks.update.mockResolvedValue(mh24);
    await SiteAlerts.raise(
      { ...input, kind: "GA_MH24", dedupeKey: "ga4:link1:MH24" },
      now,
    );
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.notifyProject).not.toHaveBeenCalled();

    // Bildirilmiş GA_MH1 bir günden önce yeniden gönderilmez.
    vi.clearAllMocks();
    mocks.excluded.mockReturnValue(false);
    mocks.findUnique.mockResolvedValue(row({ notifiedAt: hours(2) }));
    mocks.update.mockResolvedValue(row({ notifiedAt: hours(2) }));
    await SiteAlerts.raise(input, now);
    expect(mocks.notifyProject).not.toHaveBeenCalled();
  });

  it("reopens a resolved alert and counts the occurrence", async () => {
    mocks.findUnique.mockResolvedValue(
      row({ status: "RESOLVED", notifiedAt: hours(100) }),
    );
    mocks.update.mockResolvedValue(row());
    await SiteAlerts.raise(input, now);
    expect(mocks.update.mock.calls[0]![0].data).toMatchObject({
      status: "OPEN",
      firstSeenAt: now,
      resolvedAt: null,
      mutedUntil: null,
      notifiedAt: null,
      occurrences: { increment: 1 },
      source: "GA4",
      lastSeenAt: now,
    });
  });

  it("keeps a muted alert muted but escalation outside a mute re-notifies", async () => {
    const mutedUntil = new Date(now.getTime() + 3_600_000);
    mocks.findUnique.mockResolvedValue(
      row({ status: "MUTED", mutedUntil, severity: "WARN" }),
    );
    mocks.update.mockResolvedValue(row({ status: "MUTED", mutedUntil }));
    await SiteAlerts.raise(input, now);
    expect(mocks.update.mock.calls[0]![0].data.status).toBeUndefined();
    expect(mocks.notifyProject).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.excluded.mockReturnValue(false);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.findUnique.mockResolvedValue(
      row({ severity: "WARN", notifiedAt: hours(1) }),
    );
    mocks.update.mockResolvedValue(row());
    await SiteAlerts.raise(input, now);
    expect(mocks.update.mock.calls[0]![0].data).toMatchObject({
      notifiedAt: null,
      status: "OPEN",
    });
    expect(mocks.notifyProject).toHaveBeenCalledOnce();
  });

  it("WARN alerts never notify", async () => {
    mocks.upsert.mockResolvedValue(row({ severity: "WARN" }));
    await SiteAlerts.raise({ ...input, severity: "WARN" }, now);
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.notifyProject).not.toHaveBeenCalled();
    expect(mocks.operatorTelegram).not.toHaveBeenCalled();
  });

  it("a failing notification never breaks raise", async () => {
    mocks.credentialFind.mockRejectedValue(new Error("db down"));
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await expect(SiteAlerts.raise(input, now)).resolves.toBeUndefined();
    expect(String(error.mock.calls[0]![0])).not.toContain(input.title);
    error.mockRestore();
  });
});

describe("SiteAlerts queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMany.mockResolvedValue({ count: 2 });
    mocks.deleteMany.mockResolvedValue({ count: 3 });
  });

  it("listOpen filters by source and returns nothing without sources", async () => {
    expect(await SiteAlerts.listOpen("p1", [])).toEqual([]);
    expect(mocks.findMany).not.toHaveBeenCalled();

    mocks.findMany.mockResolvedValue([
      row({ id: "w", severity: "WARN", lastSeenAt: hours(0) }),
      row({ id: "c", severity: "CRITICAL", lastSeenAt: hours(5) }),
      row({ id: "x", source: null, severity: "CRITICAL" }),
    ]);
    const open = await SiteAlerts.listOpen("p1", ["GA4"], 5);
    expect(mocks.findMany.mock.calls[0]![0]).toMatchObject({
      where: {
        projectId: "p1",
        status: { in: ["OPEN", "ACKED"] },
        source: { in: ["GA4"] },
      },
      orderBy: { lastSeenAt: "desc" },
      take: 10,
    });
    expect(open.map((alert) => alert.id)).toEqual(["c", "w"]);
    expect(open[0]).toEqual({
      id: "c",
      source: "GA4",
      kind: "GA_MH1",
      severity: "CRITICAL",
      title: input.title,
      detail: null,
      lastSeenAt: hours(5),
      dedupeKey: "ga4:link1:MH1",
    });
  });

  it("mute only touches site alerts", async () => {
    await SiteAlerts.mute("a1", "p1", 7);
    const call = mocks.updateMany.mock.calls[0]![0];
    expect(call.where).toEqual({
      id: "a1",
      projectId: "p1",
      source: { not: null },
    });
    expect(call.data.status).toBe("MUTED");
    expect(call.data.mutedUntil).toBeInstanceOf(Date);
  });

  it("resolveMissing stays inside its source and kinds", async () => {
    const count = await SiteAlerts.resolveMissing(
      {
        projectId: "p1",
        source: "GA4",
        kinds: ["GA_MH1", "GA_MH6"],
        stillOpen: new Set(["ga4:l:MH6"]),
      },
      now,
    );
    expect(count).toBe(2);
    expect(mocks.updateMany.mock.calls[0]![0]).toEqual({
      where: {
        projectId: "p1",
        source: "GA4",
        kind: { in: ["GA_MH1", "GA_MH6"] },
        status: { in: ["OPEN", "ACKED", "MUTED"] },
        dedupeKey: { notIn: ["ga4:l:MH6"] },
      },
      data: { status: "RESOLVED", resolvedAt: now },
    });
  });

  it("bulk helpers skip the query for empty project lists", async () => {
    expect(await SiteAlerts.deleteForProjects([], "GA4")).toBe(0);
    expect(await SiteAlerts.resolveForProjects([], "GA4", now)).toBe(0);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();

    expect(await SiteAlerts.deleteForProjects(["p1"], "GA4")).toBe(3);
    expect(mocks.deleteMany.mock.calls[0]![0]).toEqual({
      where: { projectId: { in: ["p1"] }, source: "GA4" },
    });
    expect(await SiteAlerts.purgeResolved("GA4", 180, now)).toBe(3);
    expect(mocks.deleteMany.mock.calls[1]![0].where).toMatchObject({
      source: "GA4",
      status: "RESOLVED",
      resolvedAt: { lt: new Date(now.getTime() - 180 * 86_400_000) },
    });
  });
});
