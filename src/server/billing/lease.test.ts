import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Veritabanı yok: kilidin sözleşmesinin hata ve tekrar dalları. Gerçek satır
// davranışı (CAS, devralma, başkasının satırını silmeme) lease.integration.test.ts'te.
const mocks = vi.hoisted(() => ({
  claimPeriodic: vi.fn(),
  executeRaw: vi.fn(),
}));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: mocks.claimPeriodic,
}));
vi.mock("@/lib/prisma", () => ({ prisma: { $executeRaw: mocks.executeRaw } }));

import { acquireLease } from "./lease";

const NOW = new Date();

describe("acquireLease", () => {
  beforeEach(() => {
    mocks.claimPeriodic.mockReset();
    mocks.executeRaw.mockReset();
    mocks.executeRaw.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("claims the key for the ttl at the given time and returns nothing when it is held", async () => {
    mocks.claimPeriodic.mockResolvedValue(false);
    expect(await acquireLease("k", 4_000, NOW)).toBeNull();
    expect(mocks.claimPeriodic).toHaveBeenCalledWith("k", 4_000, NOW);
    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });

  it("releases only its own row: matched by the key and by its own claim time", async () => {
    mocks.claimPeriodic.mockResolvedValue(true);
    const lease = await acquireLease("k", 4_000, NOW);
    await lease?.release();

    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    const [sql, ...values] = mocks.executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(sql.join("?")).toMatch(/DELETE FROM "SystemHeartbeat"/);
    expect(values).toEqual(["k", NOW]);
  });

  it("issues the delete once however often release is called", async () => {
    mocks.claimPeriodic.mockResolvedValue(true);
    const lease = await acquireLease("k", 4_000, NOW);
    await Promise.all([lease?.release(), lease?.release()]);
    await lease?.release();
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
  });

  it("never throws when the row cannot be released: it logs and leaves the ttl to free it", async () => {
    mocks.claimPeriodic.mockResolvedValue(true);
    mocks.executeRaw.mockRejectedValue(new Error("connection reset"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const lease = await acquireLease("k", 4_000, NOW);
    await expect(lease?.release()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      "[lease] k could not be released:",
      "connection reset",
    );
  });
});
