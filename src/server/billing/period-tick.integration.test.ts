import { randomUUID } from "node:crypto";

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const config = vi.hoisted(() => ({
  current: {
    mode: "enforce" as "off" | "shadow" | "enforce",
    legacyBefore: null as Date | null,
    legacyUntil: null as Date | null,
  },
}));
vi.mock("./config", () => ({ getBillingConfig: () => config.current }));

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { reserveUsage } from "./ledger";
import { resetBillingTickThrottle, runBillingTick } from "./period-tick";

// Bakım adımı gerçek Postgres'e karşı: vadesi gelen pencere yenilenir, ödenmiş ama
// bakiyesiz abonelik pencere kazanır, çökmüş rezervasyon iade edilir; off iken sorgusuz.
const runId = randomUUID().slice(0, 8);
let counter = 0;
const newWs = () => `ws_tick_${runId}_${++counter}`;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Bakım adımına verilen "şimdi" benzetilmiş bir saattir ve gerçek saatten türetilir:
// ÖNCEKİ ayın 15'i, öğlen (UTC). Böylece gerçek saatin her zaman geçmişindedir:
// veritabanının kendi damgaladığı her şey (Prisma @updatedAt, default now()) NOW'a
// göre damgalanan her şeyden sonradır, takvimin hangi gününde olursak olalım.
// Sırası sonucu belirleyen yerlerde (süpürme iki damgayı karşılaştırır) test iki
// damgayı da kendisi yazar.
const REAL = new Date();
const monthStart = (offset: number) =>
  new Date(Date.UTC(REAL.getUTCFullYear(), REAL.getUTCMonth() + offset, 1));
const MONTH_START = monthStart(-1); // kota penceresinin çapası ve başlangıcı
const MONTH_END = monthStart(0); // ilk pencerenin sonu = ikinci pencerenin başı
const NEXT_MONTH_END = monthStart(1); // ikinci pencerenin sonu
const MID = new Date(MONTH_START.getTime() + 14 * DAY + 12 * HOUR);
// Hiçbir testteki işin park edilmiş olabileceğinden daha eski.
const LONG_AGO = new Date(MID.getTime() - 90 * DAY);

const statusOf = async (jobId: string) =>
  (await prisma.executionJob.findUniqueOrThrow({ where: { id: jobId } }))
    .status;

describeIntegration("billing maintenance tick", () => {
  const executionFixtures: AgencyFixture[] = [];

  beforeEach(async () => {
    resetBillingTickThrottle();
    // claimPeriodic 5 dk'lık kilidi: önceki testin izini temizle.
    await prisma.systemHeartbeat.deleteMany({
      where: { key: { in: ["billing.tick", "billing.drain"] } },
    });
    // off ve shadow tick'i veritabanındaki HER park edilmiş işi boşaltır, enforce
    // süpürmesi her workspace'e bakar: başka bir test dosyasının park edilmiş bıraktığı
    // iş buradaki sayıları ve sonuçları değiştirirdi. Önce emekliye ayrılır (bu
    // noktada bu dosyanın park edilmiş hiçbir işi yoktur: işler testlerin içinde
    // kurulur ve her tick'ten sonra boşalmış ya da kapanmıştır).
    await prisma.executionJob.updateMany({
      where: { status: "WAITING_BUDGET" },
      data: { status: "CANCELLED" },
    });
  });

  afterEach(() => {
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
  });

  afterAll(async () => {
    for (const fixture of executionFixtures) {
      const where = { workspaceId: fixture.workspaceId };
      await prisma.outboxEvent.deleteMany({ where });
      await prisma.executionJob.deleteMany({ where });
      await prisma.task.deleteMany({ where });
      await prisma.auditLog.deleteMany({ where });
      await teardownAgencyFixture(fixture.workspaceId);
    }
    const where = { workspaceId: { startsWith: `ws_tick_${runId}` } };
    await prisma.usageReservation.deleteMany({ where });
    await prisma.usageGrant.deleteMany({ where });
    await prisma.usageBalance.deleteMany({ where });
    await prisma.subscription.deleteMany({ where });
    await prisma.systemHeartbeat.deleteMany({
      where: { key: { in: ["billing.tick", "billing.drain"] } },
    });
  });

  async function subscription(workspaceId: string, paidThrough: Date) {
    await prisma.subscription.create({
      data: {
        workspaceId,
        planKey: "growth",
        interval: "MONTH",
        status: "ACTIVE",
        quotaAnchor: MONTH_START,
        paidThrough,
      },
    });
  }

  it("off: defter işlerine dokunmaz (pencere, bakiye, rezervasyon, bakım kilidi); yalnız kendi park edilmiş işini boşaltır", async () => {
    config.current = { ...config.current, mode: "off" };
    // Ödenmiş ama bakiyesi yok: defter işi çalışsaydı bu tick ilk pencereyi açardı.
    const ws = newWs();
    await subscription(ws, NEXT_MONTH_END);
    // Boşaltmanın dokunabileceği tek şey: bu testin kendi park edilmiş işi (hiçbir
    // defter satırı olmayan bir workspace'te).
    const { fixture, job } = await parkedJob(null);
    expect(
      await prisma.systemHeartbeat.count({ where: { key: "billing.drain" } }),
    ).toBe(0);

    const now = new Date(MONTH_END.getTime() + DAY);
    const work = await runBillingTick(now);

    // Yapılan iş tek bir şeydir: kendi işimizin kuyruğa dönmesi. Başka bir
    // workspace'in park edilmiş işi beforeEach'te emekliye ayrıldı.
    expect(work).toBe(1);
    expect(await statusOf(job.id)).toBe("QUEUED");
    // Hiçbir defter satırı yazılmadı: ne pencere/bakiye ne rezervasyon.
    for (const workspaceId of [ws, fixture.workspaceId]) {
      expect(await prisma.usageBalance.count({ where: { workspaceId } })).toBe(
        0,
      );
      expect(
        await prisma.usageReservation.count({ where: { workspaceId } }),
      ).toBe(0);
    }
    // Bakım kilidi alınmadı (koruma kalkarsa claimPeriodic en az bu satırı yazardı);
    // alınan tek kilit saatlik boşaltma kilididir, tek satır.
    expect(
      await prisma.systemHeartbeat.count({ where: { key: "billing.tick" } }),
    ).toBe(0);
    const drainBeats = await prisma.systemHeartbeat.findMany({
      where: { key: "billing.drain" },
    });
    expect(drainBeats).toHaveLength(1);
    expect(drainBeats[0]!.lastBeatAt).toEqual(now);
  });

  it("ödenmiş ama bakiyesiz abonelik ilk pencereyi kazanır", async () => {
    const ws = newWs();
    await subscription(ws, MONTH_END);
    const work = await runBillingTick(MID);
    expect(work).toBeGreaterThanOrEqual(1);
    const rows = await prisma.usageBalance.findMany({
      where: { workspaceId: ws },
    });
    expect(rows.map((row) => row.unit).sort()).toEqual(["AI_MICROS", "IMAGE"]);
  });

  it("vadesi gelen pencere ÖDEME geldiyse yenilenir, ödeme gelmediyse yenilenmez", async () => {
    const paid = newWs();
    const unpaid = newWs();
    await subscription(paid, NEXT_MONTH_END);
    await subscription(unpaid, MONTH_END);
    // İlk pencereyi kur ve kullandır.
    for (const ws of [paid, unpaid]) {
      await reserveUsage({
        workspaceId: ws,
        unit: "IMAGE",
        amount: 10,
        reservationKey: "k#1",
        now: MID,
      });
      await prisma.usageBalance.update({
        where: { workspaceId_unit: { workspaceId: ws, unit: "IMAGE" } },
        data: { periodUsed: BigInt(10), periodReserved: BigInt(0) },
      });
      await prisma.usageReservation.deleteMany({ where: { workspaceId: ws } });
    }

    await runBillingTick(new Date(MONTH_END.getTime() + 2 * HOUR));

    const paidRow = await prisma.usageBalance.findUniqueOrThrow({
      where: { workspaceId_unit: { workspaceId: paid, unit: "IMAGE" } },
    });
    expect(paidRow.periodStart).toEqual(MONTH_END);
    expect(paidRow.periodUsed).toBe(BigInt(0));
    const unpaidRow = await prisma.usageBalance.findUniqueOrThrow({
      where: { workspaceId_unit: { workspaceId: unpaid, unit: "IMAGE" } },
    });
    // Ödenmemiş yenileme bedava pencere açmaz.
    expect(unpaidRow.periodStart).toEqual(MONTH_START);
    expect(unpaidRow.periodUsed).toBe(BigInt(10));
  });

  it("çökmüş rezervasyonu iade eder", async () => {
    const ws = newWs();
    await subscription(ws, MONTH_END);
    const now = MID;
    await runBillingTick(now);
    resetBillingTickThrottle();
    await prisma.systemHeartbeat.deleteMany({ where: { key: "billing.tick" } });
    await reserveUsage({
      workspaceId: ws,
      unit: "IMAGE",
      amount: 5,
      reservationKey: "zombie#1",
      now,
      ttlMs: 60_000,
    });
    expect(
      (
        await prisma.usageBalance.findUniqueOrThrow({
          where: { workspaceId_unit: { workspaceId: ws, unit: "IMAGE" } },
        })
      ).periodReserved,
    ).toBe(BigInt(5));

    await runBillingTick(new Date(now.getTime() + 10 * MINUTE));
    const after = await prisma.usageBalance.findUniqueOrThrow({
      where: { workspaceId_unit: { workspaceId: ws, unit: "IMAGE" } },
    });
    expect(after.periodReserved).toBe(BigInt(0));
    expect(
      (
        await prisma.usageReservation.findFirstOrThrow({
          where: { workspaceId: ws },
        })
      ).status,
    ).toBe("RELEASED");
  });

  it("5 dakikalık kısma: ilk çağrıdan sonra çıkan iş, aynı pencerede işlenmez; sonraki pencerede işlenir", async () => {
    const now = MID;
    await runBillingTick(now);

    // İlk çağrıdan SONRA bir iş çıkıyor: ödenmiş ama bakiyesiz abonelik.
    const ws = newWs();
    await subscription(ws, MONTH_END);
    expect(await runBillingTick(new Date(now.getTime() + MINUTE))).toBe(0);
    expect(
      await prisma.usageBalance.count({ where: { workspaceId: ws } }),
    ).toBe(0);

    // Bellek içi kısma bu süreçte sıfırlansa bile paylaşılan kilit (SystemHeartbeat)
    // aynı 5 dakikayı tutar: süreçler arası tek çalıştırıcı.
    resetBillingTickThrottle();
    expect(await runBillingTick(new Date(now.getTime() + 2 * MINUTE))).toBe(0);
    expect(
      await prisma.usageBalance.count({ where: { workspaceId: ws } }),
    ).toBe(0);

    // 5 dakika geçince iş işlenir.
    resetBillingTickThrottle();
    expect(
      await runBillingTick(new Date(now.getTime() + 6 * MINUTE)),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.usageBalance.count({ where: { workspaceId: ws } }),
    ).toBe(2);
  });

  // Park edilmiş iş kurar. `images` null ise workspace'in hiçbir defter satırı
  // (abonelik, bakiye) yoktur; sayı ise o kadar görsel hakkı olan bir pencere.
  async function parkedJob(images: number | null) {
    const fixture = await createAgencyFixture(
      `${runId}-tick-${executionFixtures.length}`,
    );
    executionFixtures.push(fixture);
    if (images !== null) {
      await prisma.subscription.create({
        data: {
          workspaceId: fixture.workspaceId,
          planKey: "growth",
          interval: "MONTH",
          status: "ACTIVE",
          quotaAnchor: MONTH_START,
          paidThrough: NEXT_MONTH_END,
          // Aksi halde veritabanının kendi saatiyle damgalanır; süpürme bunu
          // işlerin benzetilmiş saatleriyle karşılaştırır.
          updatedAt: LONG_AGO,
        },
      });
      await prisma.usageBalance.create({
        data: {
          id: randomUUID(),
          workspaceId: fixture.workspaceId,
          unit: "IMAGE",
          periodStart: MONTH_START,
          periodEnd: MONTH_END,
          periodGranted: BigInt(images),
          updatedAt: MID,
        },
      });
    }
    const task = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        title: "A post",
        capability: "CREATE_SOCIAL_CREATIVE",
        status: "QUEUED",
        riskLevel: "LOW",
        createdByType: "USER",
      },
    });
    const job = await prisma.executionJob.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        taskId: task.id,
        capability: "CREATE_SOCIAL_CREATIVE",
        providerType: "SYSTEM",
        correlationId: randomUUID(),
        idempotencyKey: randomUUID(),
        requestPayload: { request: "x" } as never,
        status: "WAITING_BUDGET",
        // Benzetilmiş saatten (MID) bir saat önce park edildi.
        updatedAt: new Date(MID.getTime() - HOUR),
      },
    });
    return { fixture, job };
  }

  describe("park edilmiş iş ve uzlaştırma (Faz 3)", () => {
    it("bakım adımı, hakkı yenilenen workspace'in park edilmiş işini kuyruğa döndürür", async () => {
      const { job } = await parkedJob(1);
      const work = await runBillingTick(MID);
      expect(work).toBeGreaterThanOrEqual(1);
      expect(await statusOf(job.id)).toBe("QUEUED");
    });

    it("teslim edilmiş işin süresi dolan rezervasyonu iade edilmez, mahsup edilir (süreç çökmesi)", async () => {
      const { fixture, job } = await parkedJob(3);
      await prisma.executionJob.update({
        where: { id: job.id },
        data: { status: "COMPLETED" },
      });
      // The process died after the job was delivered and before it settled.
      const t0 = MID;
      const held = await reserveUsage({
        workspaceId: fixture.workspaceId,
        unit: "IMAGE",
        amount: 1,
        reservationKey: `exec:${job.id}#evt.1`,
        operationId: `exec:${job.id}`,
        ttlMs: 60_000,
        now: t0,
      });
      expect(held.ok).toBe(true);

      await runBillingTick(new Date(t0.getTime() + 10 * MINUTE));

      const row = await prisma.usageBalance.findUniqueOrThrow({
        where: {
          workspaceId_unit: { workspaceId: fixture.workspaceId, unit: "IMAGE" },
        },
      });
      expect(row.periodUsed).toBe(BigInt(1)); // charged, not handed back
      expect(row.periodReserved).toBe(BigInt(0));
      const reservation = await prisma.usageReservation.findFirstOrThrow({
        where: { workspaceId: fixture.workspaceId },
      });
      expect(reservation.status).toBe("SETTLED");
    });

    it("başarısız ya da bitmemiş işin süresi dolan rezervasyonu iade edilir", async () => {
      const { fixture, job } = await parkedJob(3);
      await prisma.executionJob.update({
        where: { id: job.id },
        data: { status: "FAILED" },
      });
      const t0 = MID;
      await reserveUsage({
        workspaceId: fixture.workspaceId,
        unit: "IMAGE",
        amount: 1,
        reservationKey: `exec:${job.id}#evt.1`,
        operationId: `exec:${job.id}`,
        ttlMs: 60_000,
        now: t0,
      });
      await runBillingTick(new Date(t0.getTime() + 10 * MINUTE));
      const row = await prisma.usageBalance.findUniqueOrThrow({
        where: {
          workspaceId_unit: { workspaceId: fixture.workspaceId, unit: "IMAGE" },
        },
      });
      expect(row.periodUsed).toBe(BigInt(0));
      expect(row.periodReserved).toBe(BigInt(0));
    });

    it("shadow: park edilmiş kalıntıyı hakka bakmadan boşaltır", async () => {
      config.current = { ...config.current, mode: "shadow" };
      const { job } = await parkedJob(0);
      await runBillingTick(MID);
      expect(await statusOf(job.id)).toBe("QUEUED");
    });

    it("off: saatte bir park edilmiş işi boşaltır (kill-switch), arada tekrar etmez", async () => {
      config.current = { ...config.current, mode: "off" };
      const { job } = await parkedJob(0);
      const t0 = MID;
      expect(await runBillingTick(t0)).toBeGreaterThanOrEqual(1);
      expect(await statusOf(job.id)).toBe("QUEUED");

      // An hour has not passed: nothing is looked at again.
      const { job: second } = await parkedJob(0);
      expect(await runBillingTick(new Date(t0.getTime() + MINUTE))).toBe(0);
      expect(await statusOf(second.id)).toBe("WAITING_BUDGET");
      // The next hour picks it up.
      resetBillingTickThrottle();
      await prisma.systemHeartbeat.deleteMany({
        where: { key: "billing.drain" },
      });
      await runBillingTick(new Date(t0.getTime() + 61 * MINUTE));
      expect(await statusOf(second.id)).toBe("QUEUED");
    });
  });
});
