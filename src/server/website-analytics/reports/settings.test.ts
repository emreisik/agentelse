import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: satır yokken varsayılanlar (stored false, yazma
// yok); gaAlertTelegramAllowed bayrak kapalıyken sorgusuz true, satır false
// diyorsa false, veritabanı hatasında true döner.

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gaReportSettings: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
    },
  },
}));

const { gaAlertTelegramAllowed, loadGaReportSettings, saveGaReportSettings } =
  await import("./settings");

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_REPORTS", "true");
});

describe("loadGaReportSettings", () => {
  it("returns the defaults with stored false when there is no row", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const view = await loadGaReportSettings("p1");
    expect(view.stored).toBe(false);
    expect(view.weeklyEnabled).toBe(true);
    expect(view.weeklyWeekday).toBe(1);
    expect(view.monthlyDay).toBe(2);
    expect(view.pulse).toBe("notable");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("falls back per field for out-of-range stored values", async () => {
    mocks.findUnique.mockResolvedValue({
      weeklyEnabled: false,
      weeklyWeekday: 9,
      monthlyEnabled: true,
      monthlyDay: 5,
      pulse: "sometimes",
      alertChat: true,
      alertTelegram: false,
    });
    const view = await loadGaReportSettings("p1");
    expect(view).toMatchObject({
      stored: true,
      weeklyEnabled: false,
      weeklyWeekday: 1,
      monthlyDay: 5,
      pulse: "notable",
      alertTelegram: false,
    });
  });
});

describe("saveGaReportSettings", () => {
  it("upserts by projectId and records the editor", async () => {
    mocks.upsert.mockImplementation(async (args: { create: object }) => ({
      ...args.create,
    }));
    const view = await saveGaReportSettings({
      workspaceId: "w1",
      projectId: "p1",
      userId: "u1",
      value: {
        weeklyEnabled: true,
        weeklyWeekday: 3,
        monthlyEnabled: false,
        monthlyDay: 4,
        pulse: "off",
        alertChat: true,
        alertTelegram: false,
      },
    });
    const args = mocks.upsert.mock.calls[0]?.[0] as {
      where: { projectId: string };
      update: { updatedByUserId: string };
    };
    expect(args.where).toEqual({ projectId: "p1" });
    expect(args.update.updatedByUserId).toBe("u1");
    expect(view).toMatchObject({ stored: true, weeklyWeekday: 3, pulse: "off" });
  });
});

describe("gaAlertTelegramAllowed", () => {
  it("is true without a query when the flag is off", async () => {
    vi.stubEnv("GA_REPORTS", "false");
    expect(await gaAlertTelegramAllowed("p1")).toBe(true);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("is false when the stored row says false", async () => {
    mocks.findUnique.mockResolvedValue({ alertTelegram: false });
    expect(await gaAlertTelegramAllowed("p1")).toBe(false);
  });

  it("is true when there is no row", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect(await gaAlertTelegramAllowed("p1")).toBe(true);
  });

  it("is true on a database error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.findUnique.mockRejectedValue(new Error("connection reset"));
    expect(await gaAlertTelegramAllowed("p1")).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("connection reset");
    spy.mockRestore();
  });
});
