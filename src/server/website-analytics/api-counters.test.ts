import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: sayaçlar GA_SYNC kapalıyken hiç tutulmaz;
// boşaltma saklanan saatlere ekler, yalnız yazılanı bellekten düşer ve
// yazamazsa sayıları kaybetmez; canlı veritabanını paylaşan geliştirme süreci
// operatör satırına asla yazmaz; okuma saklananla yazılmamışı toplar.

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    systemHeartbeat: { findUnique: mocks.findUnique, upsert: mocks.upsert },
  },
}));

const {
  flushGaApiCounters,
  readGaApiCounters,
  recordGaApiOutcome,
  resetGaApiCounters,
} = await import("./api-counters");

const HOUR = new Date().toISOString().slice(0, 13);

beforeEach(() => {
  vi.clearAllMocks();
  resetGaApiCounters();
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("NODE_ENV", "production");
  mocks.findUnique.mockResolvedValue(null);
  mocks.upsert.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GA API counters (server)", () => {
  it("records nothing with GA_SYNC off", async () => {
    vi.stubEnv("GA_SYNC", "");
    recordGaApiOutcome("ok", 3);
    vi.stubEnv("GA_SYNC", "true");
    expect(await readGaApiCounters()).toEqual({
      windowHours: 24,
      calls: 0,
      errors: {},
    });
  });

  it("adds to the stored hours and clears what it wrote", async () => {
    // İlk kayıt da boşaltmayı tetikler; o yazımı bekleyip temizleyelim.
    recordGaApiOutcome("ok", 5);
    await flushGaApiCounters();
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({
      data: { v: 1, hours: { [HOUR]: { ok: 5 } } },
    });
    mocks.upsert.mockResolvedValue({});
    recordGaApiOutcome("SERVER_ERROR");
    recordGaApiOutcome("ok", 2);
    await flushGaApiCounters();
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const data = mocks.upsert.mock.calls[0]![0].update.data;
    expect(data).toEqual({
      v: 1,
      hours: { [HOUR]: { ok: 7, SERVER_ERROR: 1 } },
    });
    // Yazılan bellekten düştü: okuma çift saymaz.
    mocks.findUnique.mockResolvedValue({ data });
    expect(await readGaApiCounters()).toEqual({
      windowHours: 24,
      calls: 8,
      errors: { SERVER_ERROR: 1 },
    });
  });

  it("keeps the counts when the write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.upsert.mockRejectedValue(new Error("db down"));
    recordGaApiOutcome("RATE_LIMIT");
    await flushGaApiCounters();
    expect(warn).toHaveBeenCalled();
    mocks.findUnique.mockResolvedValue(null);
    expect((await readGaApiCounters()).errors).toEqual({ RATE_LIMIT: 1 });
    warn.mockRestore();
  });

  it("never writes from a dev process sharing the live database", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://user:pw@ep-cool-base.neon.tech/neondb",
    );
    recordGaApiOutcome("ok");
    await flushGaApiCounters();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect((await readGaApiCounters()).calls).toBe(1);
  });
});
