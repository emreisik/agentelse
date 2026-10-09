import { randomUUID } from "node:crypto";

import { afterAll, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { describeIntegration } from "@/test-support/integration-suite";

import { acquireLease } from "./lease";

// Süreçler arası kilit (lease.ts) GERÇEK Postgres'e karşı: SystemHeartbeat satırı
// üzerinde CAS ile alınır, bırakma yalnız KENDİ aldığı satırı siler. Her test kendi
// anahtarını kullanır; zaman `now` parametresiyle verilir, duvar saatine bağlı
// değildir (saat yalnız varsayılan-saat testinde okunur). Satırın zaman damgası
// okunup karşılaştırılmaz (oturum saat dilimine bağlı kalmasın): davranış, aynı
// anahtarı farklı anlarda almayı deneyerek sınanır.

const runId = randomUUID().slice(0, 8);
let counter = 0;
const newKey = () => `lease.test.${runId}.${++counter}`;

const TTL_MS = 60_000;
const T0 = new Date();
const after = (base: Date, ms: number) => new Date(base.getTime() + ms);

const rowsOf = (key: string) =>
  prisma.systemHeartbeat.count({ where: { key } });

describeIntegration("lease (SystemHeartbeat lock)", () => {
  afterAll(async () => {
    await prisma.systemHeartbeat.deleteMany({
      where: { key: { startsWith: `lease.test.${runId}.` } },
    });
  });

  it("takes a free key", async () => {
    const key = newKey();
    const lease = await acquireLease(key, TTL_MS, T0);
    expect(lease).not.toBeNull();
    expect(await rowsOf(key)).toBe(1);
    await lease?.release();
  });

  it("refuses a key that is held, for as long as the ttl lasts, and refusing does not extend it", async () => {
    const key = newKey();
    const lease = await acquireLease(key, TTL_MS, T0);
    expect(lease).not.toBeNull();

    expect(await acquireLease(key, TTL_MS, T0)).toBeNull();
    // The last millisecond before the ttl runs out.
    expect(await acquireLease(key, TTL_MS, after(T0, TTL_MS - 1))).toBeNull();

    // The refusals did not move the holder's claim: the ttl still runs from T0.
    const taken = await acquireLease(key, TTL_MS, after(T0, TTL_MS + 1));
    expect(taken).not.toBeNull();
    await taken?.release();
  });

  it("lets exactly one of many concurrent callers in", async () => {
    const key = newKey();
    const leases = await Promise.all(
      Array.from({ length: 10 }, () => acquireLease(key, TTL_MS, T0)),
    );
    const winners = leases.filter((lease) => lease !== null);
    expect(winners).toHaveLength(1);
    await winners[0]?.release();
  });

  it("frees the key on release and leaves no row behind", async () => {
    const key = newKey();
    const lease = await acquireLease(key, TTL_MS, T0);
    await lease?.release();
    expect(await rowsOf(key)).toBe(0);

    // Well inside the first holder's ttl: only the release can have freed it.
    const again = await acquireLease(key, TTL_MS, after(T0, 1));
    expect(again).not.toBeNull();
    await again?.release();
    expect(await rowsOf(key)).toBe(0);
  });

  it("works on the real clock when no time is given, and releases the row it took", async () => {
    const key = newKey();
    const lease = await acquireLease(key, TTL_MS);
    expect(lease).not.toBeNull();

    // Claimed about now: still held a few seconds before the ttl runs out ...
    const early = after(new Date(), TTL_MS - 5_000);
    expect(await acquireLease(key, TTL_MS, early)).toBeNull();

    // ... and the release matches the row by the very instant it took.
    await lease?.release();
    expect(await rowsOf(key)).toBe(0);

    // Taken again on the real clock: free a few seconds after the ttl.
    const second = await acquireLease(key, TTL_MS);
    expect(second).not.toBeNull();
    const late = after(new Date(), TTL_MS + 5_000);
    const third = await acquireLease(key, TTL_MS, late);
    expect(third).not.toBeNull();
    await third?.release();
    await second?.release();
  });

  it("is harmless to release twice", async () => {
    const key = newKey();
    const lease = await acquireLease(key, TTL_MS, T0);
    await lease?.release();
    await expect(lease?.release()).resolves.toBeUndefined();
    expect(await rowsOf(key)).toBe(0);
  });

  it("never lets a second release free a lease somebody else took in the meantime", async () => {
    const key = newKey();
    const first = await acquireLease(key, TTL_MS, T0);
    await first?.release();

    // Another caller takes the key in the very same millisecond, so the rows
    // would look identical to a release that matched on the time alone.
    const second = await acquireLease(key, TTL_MS, T0);
    expect(second).not.toBeNull();

    await first?.release();
    expect(await rowsOf(key)).toBe(1);
    expect(await acquireLease(key, TTL_MS, after(T0, 1))).toBeNull();
    await second?.release();
  });

  it("keeps different keys apart", async () => {
    const keyA = newKey();
    const keyB = newKey();
    const a = await acquireLease(keyA, TTL_MS, T0);
    const b = await acquireLease(keyB, TTL_MS, T0);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    await a?.release();
    expect(await rowsOf(keyA)).toBe(0);
    // Releasing A took nothing from B.
    expect(await rowsOf(keyB)).toBe(1);
    expect(await acquireLease(keyB, TTL_MS, after(T0, 1))).toBeNull();
    await b?.release();
  });

  it("lets an expired lease be taken over, and the old holder's late release does not free the new holder's lease", async () => {
    const key = newKey();
    const first = await acquireLease(key, TTL_MS, T0);
    expect(first).not.toBeNull();

    // The first holder stalled past its ttl; a second caller takes over.
    const takeoverAt = after(T0, TTL_MS + 1);
    const second = await acquireLease(key, TTL_MS, takeoverAt);
    expect(second).not.toBeNull();

    // The first holder finally finishes and lets go: that row is not its own.
    await first?.release();
    expect(await rowsOf(key)).toBe(1);
    // The second holder is still the owner: a third caller inside its ttl is refused.
    expect(await acquireLease(key, TTL_MS, after(takeoverAt, 1))).toBeNull();

    await second?.release();
    expect(await rowsOf(key)).toBe(0);
    const third = await acquireLease(key, TTL_MS, after(takeoverAt, 2));
    expect(third).not.toBeNull();
    await third?.release();
  });
});
