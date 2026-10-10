import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

// Faturalama ayarı test başına belirlenir (env önbelleğine bağımlı değil).
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
import { quotaFor, trialQuota } from "@/lib/billing/plans";
import { ProjectDeletionService } from "@/server/projects/project-deletion.service";
import { ProjectRepository } from "@/server/repositories/project.repository";
import { describeIntegration } from "@/test-support/integration-suite";

import { getEntitlements } from "./entitlements";
import {
  GrantKeyConflictError,
  ensurePeriod,
  getUsageView,
  grantUsage,
  reapExpiredReservations,
  releaseUsage,
  reserveUsage,
  settleUsage,
} from "./ledger";
import { RESERVE_SQL } from "./ledger-sql";
import { resetShadowLogThrottle } from "./shadow-log";
import { startTrial } from "./subscription";

// Kullanım hakkı defteri GERÇEK Postgres'e karşı (yalnız CI/yerel tek kullanımlık
// veritabanı; paylaşılan Neon'a asla). Her test kendi workspace'ini kullanır.

const B = (value: number) => BigInt(value);
const runId = randomUUID().slice(0, 8);
let counter = 0;
const newWs = () => `ws_bill_${runId}_${++counter}`;

// Beklenen kotalar plans.ts'ten gelir: "başlangıç hipotezi" rakamları değişince
// testler kırılmaz, davranışı doğrular.
const STARTER = quotaFor("starter");
const GROWTH = quotaFor("growth");
const BUSINESS = quotaFor("business");
const TRIAL_QUOTA = trialQuota();

const NOW = new Date("2026-11-15T12:00:00.000Z");
const WINDOW_START = new Date("2026-11-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-12-01T00:00:00.000Z");

async function activeSubscription(
  workspaceId: string,
  overrides: Partial<{
    planKey: string;
    status: string;
    paidThrough: Date;
    quotaAnchor: Date;
    cancelAtPeriodEnd: boolean;
    introOffer: boolean;
  }> = {},
) {
  return prisma.subscription.create({
    data: {
      workspaceId,
      planKey: "growth",
      interval: "MONTH",
      status: "ACTIVE",
      quotaAnchor: WINDOW_START,
      paidThrough: WINDOW_END,
      ...overrides,
    },
  });
}

// Bakiye satırını doğrudan kur (kota hesabından bağımsız, kapasite kontrollü).
async function seedBalance(
  workspaceId: string,
  unit: "IMAGE" | "AI_MICROS",
  values: Partial<{
    periodGranted: number;
    periodUsed: number;
    extraGranted: number;
    extraUsed: number;
    periodEnd: Date | null;
  }> = {},
) {
  return prisma.usageBalance.create({
    data: {
      id: randomUUID(),
      workspaceId,
      unit,
      periodStart: WINDOW_START,
      periodEnd: values.periodEnd === undefined ? WINDOW_END : values.periodEnd,
      periodGranted: B(values.periodGranted ?? 0),
      periodUsed: B(values.periodUsed ?? 0),
      extraGranted: B(values.extraGranted ?? 0),
      extraUsed: B(values.extraUsed ?? 0),
      updatedAt: NOW,
    },
  });
}

async function balanceOf(workspaceId: string, unit: "IMAGE" | "AI_MICROS") {
  const row = await prisma.usageBalance.findUniqueOrThrow({
    where: { workspaceId_unit: { workspaceId, unit } },
  });
  return {
    pg: Number(row.periodGranted),
    pu: Number(row.periodUsed),
    pr: Number(row.periodReserved),
    eg: Number(row.extraGranted),
    eu: Number(row.extraUsed),
    er: Number(row.extraReserved),
  };
}

// Değişmez I1: sayaçlar = RESERVED rezervasyonların toplamı (hiçbir test sonrası kaymaz).
async function expectCountersMatchReservations(workspaceId: string) {
  const balances = await prisma.usageBalance.findMany({
    where: { workspaceId },
  });
  for (const balance of balances) {
    const reserved = await prisma.usageReservation.aggregate({
      where: { workspaceId, unit: balance.unit, status: "RESERVED" },
      _sum: { fromPeriod: true, fromExtra: true },
    });
    expect(balance.periodReserved).toBe(reserved._sum.fromPeriod ?? B(0));
    expect(balance.extraReserved).toBe(reserved._sum.fromExtra ?? B(0));
  }
}

// Geniş havuzlu özel istemci (olumsuz kontrolün gücü eşzamanlı ifade sayısına bağlı).
function wideClient(): PrismaClient {
  const [base, query = ""] = (process.env.DATABASE_URL ?? "").split("?");
  // URL'deki havuz ayarı ne olursa olsun (CI'da yok, yerelde 3 ya da 40 olabilir) bu
  // istemci KENDİ havuzunu belirler; diğer parametreler (host, schema...) olduğu gibi kalır.
  const params = query
    .split("&")
    .filter(
      (param) =>
        param !== "" &&
        !param.startsWith("connection_limit=") &&
        !param.startsWith("pool_timeout="),
    );
  params.push("connection_limit=30", "pool_timeout=60");
  return new PrismaClient({ datasourceUrl: `${base}?${params.join("&")}` });
}

const usedWorkspaces: string[] = [];
const track = (ws: string) => {
  usedWorkspaces.push(ws);
  return ws;
};

describeIntegration("usage ledger (UsageBalance / Reservation / Grant)", () => {
  afterEach(async () => {
    for (const ws of usedWorkspaces) {
      await expectCountersMatchReservations(ws);
    }
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
    resetShadowLogThrottle();
  });

  afterAll(async () => {
    const where = { workspaceId: { startsWith: `ws_bill_${runId}` } };
    await prisma.usageReservation.deleteMany({ where });
    await prisma.usageGrant.deleteMany({ where });
    await prisma.usageBalance.deleteMany({ where });
    await prisma.subscription.deleteMany({ where });
    await prisma.auditLog.deleteMany({ where });
  });

  // -------------------------------------------------------------------------
  describe("rezervasyon: eşzamanlılık kapısı", () => {
    // Kapı: dış işlem bakiye satırını FOR UPDATE ile tutar, N istek başlar, hepsinin
    // hâlâ bekliyor olduğu doğrulanır, kilit bırakılır. Sıra assert edilmez, toplamlar kesindir.
    async function runUnderGate<T>(
      workspaceId: string,
      unit: "IMAGE" | "AI_MICROS",
      start: () => Promise<T>[],
      holderClient: PrismaClient = prisma,
    ): Promise<{ results: T[]; pendingWhileHeld: number }> {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let lockedResolve!: () => void;
      const locked = new Promise<void>((resolve) => (lockedResolve = resolve));
      const holder = holderClient.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(
            `SELECT "id" FROM "UsageBalance" WHERE "workspaceId" = $1::text AND "unit" = $2::text FOR UPDATE`,
            workspaceId,
            unit,
          );
          lockedResolve();
          await held;
        },
        { timeout: 30_000 },
      );
      await locked;
      const calls = start();
      let settled = 0;
      calls.forEach((call) => void call.then(() => (settled += 1)));
      await new Promise((resolve) => setTimeout(resolve, 400));
      const pendingWhileHeld = calls.length - settled;
      release();
      await holder;
      return { results: await Promise.all(calls), pendingWhileHeld };
    }

    it("40 paralel rezervasyon, kapasite 12 dönem + 8 extra: tam 20 kabul, hiçbiri aşamaz", async () => {
      const ws = track(newWs());
      await activeSubscription(ws);
      await seedBalance(ws, "IMAGE", { periodGranted: 12, extraGranted: 8 });

      const { results, pendingWhileHeld } = await runUnderGate(
        ws,
        "IMAGE",
        () =>
          Array.from({ length: 40 }, (_, index) =>
            reserveUsage({
              workspaceId: ws,
              unit: "IMAGE",
              amount: 1,
              reservationKey: `job-${index}#1`,
              now: NOW,
            }),
          ),
      );

      // Kapı gerçekten tuttu: kilit bırakılana kadar hiçbiri bitmedi.
      expect(pendingWhileHeld).toBe(40);
      const accepted = results.filter((r) => r.ok && r.kind === "RESERVED");
      const refused = results.filter(
        (r) => !r.ok && r.reason === "INSUFFICIENT",
      );
      expect(accepted).toHaveLength(20);
      expect(refused).toHaveLength(20);
      expect(await balanceOf(ws, "IMAGE")).toMatchObject({ pr: 12, er: 8 });
      // Önce dönem havuzu, sonra extra.
      const fromPeriod = accepted.reduce(
        (sum, r) =>
          sum + (r.ok && r.kind === "RESERVED" ? Number(r.fromPeriod) : 0),
        0,
      );
      expect(fromPeriod).toBe(12);
    }, 60_000);

    it("AI bütçesi: 3.000.000 mikro-dolara 30 x 500.000 istek, tam 6 kabul", async () => {
      const ws = track(newWs());
      await activeSubscription(ws);
      await seedBalance(ws, "AI_MICROS", { periodGranted: 3_000_000 });

      const { results } = await runUnderGate(ws, "AI_MICROS", () =>
        Array.from({ length: 30 }, (_, index) =>
          reserveUsage({
            workspaceId: ws,
            unit: "AI_MICROS",
            amount: 500_000,
            reservationKey: `ai-${index}#1`,
            now: NOW,
          }),
        ),
      );
      expect(results.filter((r) => r.ok && r.kind === "RESERVED")).toHaveLength(
        6,
      );
      expect((await balanceOf(ws, "AI_MICROS")).pr).toBe(3_000_000);
    }, 60_000);

    it("OLUMSUZ KONTROL: FOR UPDATE'siz çıplak ifade aynı kapı altında kapasiteyi AŞAR (kapı güçlü)", async () => {
      const ws = track(newWs());
      await seedBalance(ws, "IMAGE", { periodGranted: 2 });
      const bare = RESERVE_SQL.replace("\n     FOR UPDATE", "");
      expect(bare).not.toBe(RESERVE_SQL);

      // Bu kontrolün gücü eşzamanlı ifade sayısına bağlıdır; CI'ın varsayılan küçük
      // Prisma havuzuna (2 vCPU: 3 bağlantı) güvenmemek için geniş havuzlu özel istemci.
      const wide = wideClient();
      try {
        const { results } = await runUnderGate(
          ws,
          "IMAGE",
          () =>
            Array.from({ length: 12 }, (_, index) =>
              wide.$queryRawUnsafe<Array<{ inserted: number }>>(
                bare,
                ws,
                "IMAGE",
                B(1),
                randomUUID(),
                `bare-${index}`,
                null,
                new Date("2026-11-15T14:00:00.000Z"),
                NOW,
                0,
              ),
            ),
          wide,
        );
        const accepted = results.filter((rows) => rows[0]?.inserted === 1).length;
        // Kapasite 2'ydi; kilitsiz sürüm hepsini eski durumdan okuyup fazla ayırır.
        expect(accepted).toBeGreaterThan(2);
      } finally {
        await wide.$disconnect();
      }
      // (Defter bu test için bilerek bozuldu: sayaç değişmezi beklenmez.)
      usedWorkspaces.splice(usedWorkspaces.indexOf(ws), 1);
      await prisma.usageReservation.deleteMany({ where: { workspaceId: ws } });
      await prisma.usageBalance.deleteMany({ where: { workspaceId: ws } });
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe("rezervasyon: idempotency ve geçişler", () => {
    it("pencere henüz yokken 10 paralel İLK rezervasyon: hepsi başarılı (pencereyi başkası açsa da yeniden dener)", async () => {
      const ws = track(newWs());
      await activeSubscription(ws);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          reserveUsage({
            workspaceId: ws,
            unit: "IMAGE",
            amount: 1,
            reservationKey: `first-${index}#1`,
            now: NOW,
          }),
        ),
      );
      expect(results.filter((r) => r.ok && r.kind === "RESERVED")).toHaveLength(10);
      expect(await balanceOf(ws, "IMAGE")).toMatchObject({ pg: GROWTH.IMAGE, pr: 10 });
    }, 60_000);

    it("sıkı bakiyede yinelenen anahtar YETERSİZ değil REUSED döner; sayaç bir kez artar", async () => {
      const ws = track(newWs());
      await activeSubscription(ws);
      await seedBalance(ws, "IMAGE", { periodGranted: 3 });
      const input = {
        workspaceId: ws,
        unit: "IMAGE" as const,
        amount: 3,
        reservationKey: "job-1#1",
        now: NOW,
      };
      const first = await reserveUsage(input);
      expect(first).toMatchObject({ ok: true, kind: "RESERVED" });
      // Bakiye tükendi; aynı teslim yeniden gelir.
      const again = await reserveUsage(input);
      expect(again).toMatchObject({
        ok: true,
        kind: "REUSED",
        status: "RESERVED",
        amountMismatch: false,
      });
      expect((await balanceOf(ws, "IMAGE")).pr).toBe(3);
      // Farklı tutarla aynı anahtar işaretlenir.
      expect(await reserveUsage({ ...input, amount: 2 })).toMatchObject({
        kind: "REUSED",
        amountMismatch: true,
      });
    });

    it("20 paralel yinelenen teslim: hepsi kabul/REUSED, sayaç tam bir kez artmış", async () => {
      const ws = track(newWs());
      await activeSubscription(ws);
      await seedBalance(ws, "IMAGE", { periodGranted: 5 });
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          reserveUsage({
            workspaceId: ws,
            unit: "IMAGE",
            amount: 4,
            reservationKey: "dup#1",
            now: NOW,
          }),
        ),
      );
      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.filter((r) => r.ok && r.kind === "RESERVED")).toHaveLength(
        1,
      );
      expect((await balanceOf(ws, "IMAGE")).pr).toBe(4);
      expect(
        await prisma.usageReservation.count({ where: { workspaceId: ws } }),
      ).toBe(1);
    }, 60_000);

    it("settle: tam, eksik ve fazla tutar dağılımı", async () => {
      const ws = track(newWs());
      await activeSubscription(ws);
      await seedBalance(ws, "IMAGE", { periodGranted: 10, extraGranted: 5 });

      // 12 ayır (10 dönem + 2 extra), 12 harca.
      await reserveUsage({
        workspaceId: ws,
        unit: "IMAGE",
        amount: 12,
        reservationKey: "a#1",
        now: NOW,
      });
      expect(
        await settleUsage(
          { workspaceId: ws, unit: "IMAGE", reservationKey: "a#1", now: NOW },
          12,
        ),
      ).toMatchObject({
        status: "SETTLED",
        chargedPeriod: B(10),
        chargedExtra: B(2),
        overrun: B(0),
      });
      expect(await balanceOf(ws, "IMAGE")).toMatchObject({
        pu: 10,
        pr: 0,
        eu: 2,
        er: 0,
      });

      // 3 ayır (extra'dan), yalnız 1 harca: kalan 2 iade.
      await reserveUsage({
        workspaceId: ws,
        unit: "IMAGE",
        amount: 3,
        reservationKey: "b#1",
        now: NOW,
      });
      await settleUsage(
        { workspaceId: ws, unit: "IMAGE", reservationKey: "b#1", now: NOW },
        1,
      );
      expect(await balanceOf(ws, "IMAGE")).toMatchObject({
        eu: 3,
        er: 0,
        pr: 0,
      });

      // 1 ayır (extra), 4 harca: fazlası boşluktan; boşluk bitince borç dönem havuzuna.
      await reserveUsage({
        workspaceId: ws,
        unit: "IMAGE",
        amount: 1,
        reservationKey: "c#1",
        now: NOW,
      });
      const over = await settleUsage(
        { workspaceId: ws, unit: "IMAGE", reservationKey: "c#1", now: NOW },
        4,
      );
      // Extra'da kalan: 5 - 3 = 2, bunlardan 1'i rezerveydi (1 + fazla 1 extra'dan), 2 fazla daha: borç.
      expect(over).toMatchObject({ status: "SETTLED" });
      const after = await balanceOf(ws, "IMAGE");
      expect(after.eu).toBe(5);
      // Toplam harcama 12 + 1 + 4 = 17; havuzlar 15: 2 borç dönem havuzunda.
      expect(after.pu + after.eu).toBe(17);
      expect(after.pu).toBe(12);
    });

    it("çift settle: ikinci çağrı ALREADY_SETTLED, bakiye değişmez; bilinmeyen anahtar NOT_FOUND", async () => {
      const ws = track(newWs());
      await activeSubscription(ws);
      await seedBalance(ws, "IMAGE", { periodGranted: 10 });
      await reserveUsage({
        workspaceId: ws,
        unit: "IMAGE",
        amount: 5,
        reservationKey: "x#1",
        now: NOW,
      });
      const ref = {
        workspaceId: ws,
        unit: "IMAGE" as const,
        reservationKey: "x#1",
        now: NOW,
      };
      await settleUsage(ref, 4);
      const before = await balanceOf(ws, "IMAGE");
      expect(await settleUsage(ref, 4)).toEqual({
        status: "ALREADY_SETTLED",
        settledAmount: B(4),
      });
      expect(await balanceOf(ws, "IMAGE")).toEqual(before);
      expect(await settleUsage({ ...ref, reservationKey: "yok#1" }, 1)).toEqual(
        { status: "NOT_FOUND" },
      );
      expect(await releaseUsage({ ...ref, reservationKey: "yok#1" })).toEqual({
        status: "NOT_FOUND",
      });
    });

    it("release: rezerve iade edilir, ikinci release NOT_RESERVED, SETTLED satır serbest bırakılamaz", async () => {
      const ws = track(newWs());
      await activeSubscription(ws);
      await seedBalance(ws, "IMAGE", { periodGranted: 4, extraGranted: 4 });
      await reserveUsage({
        workspaceId: ws,
        unit: "IMAGE",
        amount: 6,
        reservationKey: "r#1",
        now: NOW,
      });
      expect(await balanceOf(ws, "IMAGE")).toMatchObject({ pr: 4, er: 2 });
      const ref = {
        workspaceId: ws,
        unit: "IMAGE" as const,
        reservationKey: "r#1",
        now: NOW,
      };
      expect(await releaseUsage(ref)).toMatchObject({
        status: "RELEASED",
        releasedPeriod: B(4),
        releasedExtra: B(2),
      });
      expect(await balanceOf(ws, "IMAGE")).toMatchObject({ pr: 0, er: 0 });
      expect(await releaseUsage(ref)).toEqual({
        status: "NOT_RESERVED",
        current: "RELEASED",
      });

      await reserveUsage({
        workspaceId: ws,
        unit: "IMAGE",
        amount: 1,
        reservationKey: "s#1",
        now: NOW,
      });
      await settleUsage({ ...ref, reservationKey: "s#1" }, 1);
      expect(await releaseUsage({ ...ref, reservationKey: "s#1" })).toEqual({
        status: "NOT_RESERVED",
        current: "SETTLED",
      });
    });

    it("her iş yeni deneme anahtarıyla yeniden ayırır (RELEASED yeniden açılmaz)", async () => {
      const ws = track(newWs());
      await activeSubscription(ws);
      await seedBalance(ws, "IMAGE", { periodGranted: 2 });
      const base = {
        workspaceId: ws,
        unit: "IMAGE" as const,
        amount: 2,
        now: NOW,
      };
      await reserveUsage({ ...base, reservationKey: "job#1" });
      await releaseUsage({
        workspaceId: ws,
        unit: "IMAGE",
        reservationKey: "job#1",
        now: NOW,
      });
      // Aynı (serbest bırakılmış) anahtar tekrar RESERVED OLMAZ...
      expect(
        await reserveUsage({ ...base, reservationKey: "job#1" }),
      ).toMatchObject({
        kind: "REUSED",
        status: "RELEASED",
      });
      // ...ikinci deneme yeni anahtarla ayırır.
      expect(
        await reserveUsage({ ...base, reservationKey: "job#2" }),
      ).toMatchObject({
        ok: true,
        kind: "RESERVED",
      });
    });

    it("geçersiz tutar ücretli çağrıyı DÜŞÜRMEZ: enforce'ta ERROR, shadow'da BYPASS, off'ta BYPASS; bakiyeye dokunulmaz", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const ws = track(newWs());
      await activeSubscription(ws);
      await seedBalance(ws, "IMAGE", { periodGranted: 5 });
      for (const amount of [0, -5, 1.5, Number.NaN]) {
        expect(
          await reserveUsage({ workspaceId: ws, unit: "IMAGE", amount, reservationKey: "bad#1", now: NOW }),
        ).toEqual({ ok: false, reason: "ERROR" });
      }
      config.current = { ...config.current, mode: "shadow" };
      expect(
        await reserveUsage({ workspaceId: ws, unit: "IMAGE", amount: 0, reservationKey: "bad#2", now: NOW }),
      ).toEqual({ ok: true, kind: "BYPASS", reason: "ERROR_OPEN" });
      config.current = { ...config.current, mode: "off" };
      expect(
        await reserveUsage({ workspaceId: ws, unit: "IMAGE", amount: 0, reservationKey: "bad#3", now: NOW }),
      ).toEqual({ ok: true, kind: "BYPASS", reason: "OFF" });
      config.current = { ...config.current, mode: "enforce" };
      expect(
        await settleUsage({ workspaceId: ws, unit: "IMAGE", reservationKey: "bad#1" }, -1),
      ).toEqual({ status: "ERROR" });
      expect(await balanceOf(ws, "IMAGE")).toMatchObject({ pr: 0, pu: 0 });
      expect(await prisma.usageReservation.count({ where: { workspaceId: ws } })).toBe(0);
      spy.mockRestore();
    });

    it("off: settle, release ve görünüm veritabanına dokunmaz (mevcut rezervasyon olduğu gibi kalır)", async () => {
      const ws = track(newWs());
      await activeSubscription(ws);
      await seedBalance(ws, "IMAGE", { periodGranted: 5 });
      await reserveUsage({ workspaceId: ws, unit: "IMAGE", amount: 2, reservationKey: "off#1", now: NOW });
      const ref = { workspaceId: ws, unit: "IMAGE" as const, reservationKey: "off#1", now: NOW };
      config.current = { ...config.current, mode: "off" };
      expect(await settleUsage(ref, 2)).toEqual({ status: "NOT_FOUND" });
      expect(await releaseUsage(ref)).toEqual({ status: "NOT_FOUND" });
      expect(await getUsageView(ws, { now: NOW })).toEqual([]);
      config.current = { ...config.current, mode: "enforce" };
      expect(
        (await prisma.usageReservation.findFirstOrThrow({ where: { workspaceId: ws } })).status,
      ).toBe("RESERVED");
    });
  });

  // -------------------------------------------------------------------------
  describe("hak kararı ve modlar", () => {
    it("off: veritabanına dokunmadan BYPASS", async () => {
      config.current = { ...config.current, mode: "off" };
      const ws = newWs();
      expect(
        await reserveUsage({
          workspaceId: ws,
          unit: "IMAGE",
          amount: 1,
          reservationKey: "k#1",
        }),
      ).toEqual({ ok: true, kind: "BYPASS", reason: "OFF" });
      expect(
        await prisma.usageReservation.count({ where: { workspaceId: ws } }),
      ).toBe(0);
    });

    it("enforce: satırsız workspace NOT_ENTITLED, video satılmıyor, süre dolunca ret", async () => {
      const none = newWs();
      expect(
        await reserveUsage({
          workspaceId: none,
          unit: "IMAGE",
          amount: 1,
          reservationKey: "k#1",
          now: NOW,
        }),
      ).toMatchObject({
        ok: false,
        reason: "NOT_ENTITLED",
        entitlement: "NO_SUBSCRIPTION",
      });

      const ws = track(newWs());
      await activeSubscription(ws);
      await seedBalance(ws, "IMAGE", { periodGranted: 5 });
      expect(
        await reserveUsage({
          workspaceId: ws,
          unit: "VIDEO",
          amount: 1,
          reservationKey: "v#1",
          now: NOW,
        }),
      ).toEqual({ ok: false, reason: "UNIT_NOT_SOLD" });

      // Ödenmiş süre + yenileme payı geçti: harcama kapanır (bakiye dursa da).
      const late = new Date(WINDOW_END.getTime() + 7 * 60 * 60 * 1000);
      expect(
        await reserveUsage({
          workspaceId: ws,
          unit: "IMAGE",
          amount: 1,
          reservationKey: "late#1",
          now: late,
        }),
      ).toMatchObject({
        ok: false,
        reason: "NOT_ENTITLED",
        entitlement: "PAST_DUE_ENDED",
      });
      // Yenileme payı (5 saat) içinde sönmüş pencere harcanmaz ama erişim sürer.
      const lag = new Date(WINDOW_END.getTime() + 5 * 60 * 60 * 1000);
      const refused = await reserveUsage({
        workspaceId: ws,
        unit: "IMAGE",
        amount: 1,
        reservationKey: "lag#1",
        now: lag,
      });
      expect(refused).toMatchObject({ ok: false, reason: "INSUFFICIENT" });
      // A paid plan renews; only the free trial's refusal says it does not.
      expect(refused).not.toHaveProperty("trial");
    });

    it("shadow: hiçbir şey engellenmez; yetersizlik 'olsaydı engellenirdi' kaydı bırakır", async () => {
      config.current = { ...config.current, mode: "shadow" };
      const none = newWs();
      expect(
        await reserveUsage({
          workspaceId: none,
          unit: "IMAGE",
          amount: 1,
          reservationKey: "k#1",
          now: NOW,
        }),
      ).toEqual({ ok: true, kind: "BYPASS", reason: "SHADOW_NOT_ENTITLED" });
      expect(
        await prisma.auditLog.count({
          where: { workspaceId: none, action: "billing.shadow.not_entitled" },
        }),
      ).toBe(1);

      const ws = track(newWs());
      await activeSubscription(ws);
      await seedBalance(ws, "IMAGE", { periodGranted: 1 });
      const second = await reserveUsage({
        workspaceId: ws,
        unit: "IMAGE",
        amount: 5,
        reservationKey: "o#1",
        now: NOW,
      });
      expect(second).toMatchObject({ ok: true, kind: "OVERDRAFT_SHADOW" });
      // Sayaçlara dokunulmadı; satır overdraft=true ve settle de yazmaz.
      expect(await balanceOf(ws, "IMAGE")).toMatchObject({ pr: 0, pu: 0 });
      await settleUsage(
        { workspaceId: ws, unit: "IMAGE", reservationKey: "o#1", now: NOW },
        5,
      );
      expect(await balanceOf(ws, "IMAGE")).toMatchObject({
        pr: 0,
        pu: 0,
        eu: 0,
      });
      expect(
        (
          await prisma.usageReservation.findFirstOrThrow({
            where: { workspaceId: ws },
          })
        ).overdraft,
      ).toBe(true);
    });

    it("LEGACY (satırsız, eşikten önce açılmış) sınırsız: bakiye tutulmaz", async () => {
      const fixture: AgencyFixture = await createAgencyFixture(
        `bill-legacy-${runId}`,
      );
      try {
        config.current = {
          mode: "enforce",
          legacyBefore: new Date(Date.now() + 60_000),
          legacyUntil: null,
        };
        expect(await getEntitlements(fixture.workspaceId)).toMatchObject({
          access: "FULL",
          reason: "LEGACY",
          unlimited: true,
        });
        expect(
          await reserveUsage({
            workspaceId: fixture.workspaceId,
            unit: "IMAGE",
            amount: 1,
            reservationKey: "l#1",
          }),
        ).toEqual({ ok: true, kind: "BYPASS", reason: "UNLIMITED" });
        // Süre dolunca salt-okunur.
        config.current = {
          ...config.current,
          legacyUntil: new Date(Date.now() - 60_000),
        };
        expect(await getEntitlements(fixture.workspaceId)).toMatchObject({
          access: "READ_ONLY",
          reason: "LEGACY_ENDED",
        });
      } finally {
        await teardownAgencyFixture(fixture.workspaceId);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("pencere (ensurePeriod)", () => {
    it("ilk çağrı pencereyi açar, PLAN hibesi deftere yazılır; ikinci çağrı değişiklik yapmaz", async () => {
      const ws = track(newWs());
      await activeSubscription(ws);
      expect(await ensurePeriod(ws, { now: NOW })).toEqual({ changed: true });
      expect(await balanceOf(ws, "IMAGE")).toMatchObject({ pg: GROWTH.IMAGE, pu: 0 });
      expect(await balanceOf(ws, "AI_MICROS")).toMatchObject({ pg: GROWTH.AI_MICROS });
      // VIDEO satılmıyor: satır yok.
      expect(
        await prisma.usageBalance.count({
          where: { workspaceId: ws, unit: "VIDEO" },
        }),
      ).toBe(0);
      expect(await ensurePeriod(ws, { now: NOW })).toEqual({ changed: false });
      expect(
        await prisma.usageGrant.count({ where: { workspaceId: ws } }),
      ).toBe(2);
    });

    it("10 paralel ensurePeriod: PLAN hibesi birim başına tam 1 satır", async () => {
      const ws = track(newWs());
      await activeSubscription(ws);
      await Promise.all(
        Array.from({ length: 10 }, () => ensurePeriod(ws, { now: NOW })),
      );
      expect(
        await prisma.usageGrant.count({
          where: { workspaceId: ws, unit: "IMAGE", reason: "PLAN" },
        }),
      ).toBe(1);
      expect(await balanceOf(ws, "IMAGE")).toMatchObject({ pg: GROWTH.IMAGE });
    }, 60_000);

    it("bayat 'şimdi' pencereyi GERİ SARMAZ ve kotayı tekrar vermez", async () => {
      const ws = track(newWs());
      await activeSubscription(ws, {
        paidThrough: new Date("2027-02-01T00:00:00.000Z"),
      });
      await ensurePeriod(ws, { now: new Date("2026-12-05T00:00:00.000Z") });
      await seedUsed(ws, 20);
      // Bayat çağrı (önceki pencere): sıfırlama yok.
      await ensurePeriod(ws, { now: new Date("2026-11-20T00:00:00.000Z") });
      expect(await balanceOf(ws, "IMAGE")).toMatchObject({ pg: GROWTH.IMAGE, pu: 20 });
    });

    it("YARIŞ: pencere yenilenirken commit olmamış bir reserve beklenirse sayaç o rezervasyonu KAÇIRMAZ", async () => {
      const ws = track(newWs());
      await activeSubscription(ws, { paidThrough: new Date("2027-02-01T00:00:00.000Z") });
      await ensurePeriod(ws, { now: NOW });

      // Uçuştaki reserve: bakiye satırı kilitli, rezervasyon yazıldı, henüz commit yok.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let lockedResolve!: () => void;
      const locked = new Promise<void>((resolve) => (lockedResolve = resolve));
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(
            `SELECT "id" FROM "UsageBalance" WHERE "workspaceId" = $1::text AND "unit" = 'IMAGE' FOR UPDATE`,
            ws,
          );
          await tx.usageReservation.create({
            data: {
              id: randomUUID(),
              workspaceId: ws,
              unit: "IMAGE",
              reservationKey: "inflight#1",
              amount: B(3),
              fromPeriod: B(3),
              fromExtra: B(0),
              status: "RESERVED",
              overdraft: false,
              expiresAt: new Date("2026-12-02T02:00:00.000Z"),
              createdAt: NOW,
            },
          });
          await tx.usageBalance.update({
            where: { workspaceId_unit: { workspaceId: ws, unit: "IMAGE" } },
            data: { periodReserved: B(3) },
          });
          lockedResolve();
          await held;
        },
        { timeout: 30_000 },
      );
      await locked;
      // Yeni pencere başlıyor; sıfırlama kilitte bekler.
      const ensure = ensurePeriod(ws, { now: new Date("2026-12-02T00:00:00.000Z") });
      await new Promise((resolve) => setTimeout(resolve, 400));
      release();
      await holder;
      await expect(ensure).resolves.toEqual({ changed: true });

      // Yeni pencerede kullanım sıfır, ama commit olan rezervasyon sayaçta tutulu.
      expect(await balanceOf(ws, "IMAGE")).toMatchObject({ pg: GROWTH.IMAGE, pu: 0, pr: 3 });
    }, 60_000);

    it("yeni pencerede kullanım sıfırlanır, uçuştaki rezervasyon sayaçta kalır, extra korunur", async () => {
      const ws = track(newWs());
      await activeSubscription(ws, {
        paidThrough: new Date("2027-02-01T00:00:00.000Z"),
      });
      await ensurePeriod(ws, { now: NOW });
      await grantUsage({
        workspaceId: ws,
        unit: "IMAGE",
        pool: "EXTRA",
        amount: 20,
        reason: "PURCHASE",
        idempotencyKey: "inv_1",
        now: NOW,
      });
      await reserveUsage({
        workspaceId: ws,
        unit: "IMAGE",
        amount: 7,
        reservationKey: "fly#1",
        now: NOW,
      });
      await settleUsage(
        { workspaceId: ws, unit: "IMAGE", reservationKey: "fly#1", now: NOW },
        7,
      );
      await reserveUsage({
        workspaceId: ws,
        unit: "IMAGE",
        amount: 3,
        reservationKey: "inflight#1",
        now: NOW,
      });
      expect(await balanceOf(ws, "IMAGE")).toMatchObject({
        pu: 7,
        pr: 3,
        eg: 20,
      });

      await ensurePeriod(ws, { now: new Date("2026-12-02T00:00:00.000Z") });
      expect(await balanceOf(ws, "IMAGE")).toMatchObject({
        pg: GROWTH.IMAGE,
        pu: 0,
        pr: 3,
        eg: 20,
      });
    });

    it("ödenmemiş yenileme yeni pencere AÇMAZ (bedava ay yok)", async () => {
      const ws = track(newWs());
      await activeSubscription(ws);
      await ensurePeriod(ws, { now: NOW });
      // Kasım penceresi bitti, paidThrough hâlâ 1 Aralık (webhook gelmedi), 2 saat sonra.
      const result = await ensurePeriod(ws, {
        now: new Date("2026-12-01T02:00:00.000Z"),
      });
      expect(result).toEqual({ changed: false });
      const row = await prisma.usageBalance.findUniqueOrThrow({
        where: { workspaceId_unit: { workspaceId: ws, unit: "IMAGE" } },
      });
      expect(row.periodStart).toEqual(WINDOW_START);
    });

    it("zamanlanmış düşürme pencere sınırında uygulanır ve kalıcı yazılır", async () => {
      const ws = track(newWs());
      await prisma.subscription.create({
        data: {
          workspaceId: ws,
          planKey: "business",
          interval: "MONTH",
          status: "ACTIVE",
          quotaAnchor: WINDOW_START,
          paidThrough: new Date("2027-02-01T00:00:00.000Z"),
          pendingPlanKey: "starter",
          pendingEffectiveAt: WINDOW_END,
        },
      });
      await ensurePeriod(ws, { now: NOW });
      expect((await balanceOf(ws, "IMAGE")).pg).toBe(BUSINESS.IMAGE);
      await ensurePeriod(ws, { now: new Date("2026-12-02T00:00:00.000Z") });
      expect((await balanceOf(ws, "IMAGE")).pg).toBe(STARTER.IMAGE);
      const sub = await prisma.subscription.findUniqueOrThrow({
        where: { workspaceId: ws },
      });
      expect(sub).toMatchObject({
        planKey: "starter",
        pendingPlanKey: null,
        pendingEffectiveAt: null,
      });
    });

    async function seedUsed(ws: string, used: number) {
      await prisma.usageBalance.update({
        where: { workspaceId_unit: { workspaceId: ws, unit: "IMAGE" } },
        data: { periodUsed: B(used) },
      });
    }
  });

  // -------------------------------------------------------------------------
  describe("deneme", () => {
    it("7 günlük deneme: kota 5 görsel + 1 USD, bitince ret, ikinci deneme yok", async () => {
      const ws = track(newWs());
      const started = await startTrial(ws, { now: NOW });
      expect(started).toMatchObject({ ok: true });
      expect(await balanceOf(ws, "IMAGE")).toMatchObject({ pg: TRIAL_QUOTA.IMAGE });
      expect(await balanceOf(ws, "AI_MICROS")).toMatchObject({ pg: TRIAL_QUOTA.AI_MICROS });
      expect(
        await prisma.usageGrant.count({
          where: { workspaceId: ws, reason: "TRIAL" },
        }),
      ).toBe(2);

      expect(
        await reserveUsage({
          workspaceId: ws,
          unit: "IMAGE",
          amount: TRIAL_QUOTA.IMAGE,
          reservationKey: "t#1",
          now: NOW,
        }),
      ).toMatchObject({ ok: true, kind: "RESERVED" });
      expect(
        await reserveUsage({
          workspaceId: ws,
          unit: "IMAGE",
          amount: 1,
          reservationKey: "t#2",
          now: NOW,
        }),
      ).toMatchObject({ ok: false, reason: "INSUFFICIENT", trial: true });

      const after = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000 + 1000);
      expect(
        await reserveUsage({
          workspaceId: ws,
          unit: "IMAGE",
          amount: 1,
          reservationKey: "t#3",
          now: after,
        }),
      ).toMatchObject({
        ok: false,
        reason: "NOT_ENTITLED",
        entitlement: "TRIAL_ENDED",
      });
      expect(await startTrial(ws, { now: after })).toEqual({
        ok: false,
        reason: "ALREADY_TRIALED",
      });
    });

    it("ücretli abonelikte deneme verilmez; LEGACY satırı denemeye dönüşür", async () => {
      const paid = track(newWs());
      await activeSubscription(paid);
      expect(await startTrial(paid, { now: NOW })).toEqual({
        ok: false,
        reason: "ALREADY_SUBSCRIBED",
      });

      const legacy = track(newWs());
      await prisma.subscription.create({
        data: { workspaceId: legacy, status: "LEGACY", interval: "MONTH" },
      });
      expect(await startTrial(legacy, { now: NOW })).toMatchObject({ ok: true });
      const row = await prisma.subscription.findUniqueOrThrow({
        where: { workspaceId: legacy },
      });
      expect(row).toMatchObject({ status: "TRIALING" });
      expect(row.trialEndsAt).not.toBeNull();
    });

    it("eşzamanlı çift çağrı: tam bir deneme, öteki ALREADY_TRIALED, bakiye bir kez kurulur", async () => {
      const ws = track(newWs());
      const results = await Promise.all([
        startTrial(ws, { now: NOW }),
        startTrial(ws, { now: NOW }),
        startTrial(ws, { now: NOW }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(
        results.filter((r) => !r.ok && r.reason === "ALREADY_TRIALED"),
      ).toHaveLength(2);
      expect(
        await prisma.usageGrant.count({
          where: { workspaceId: ws, unit: "IMAGE", reason: "TRIAL" },
        }),
      ).toBe(1);
      expect((await balanceOf(ws, "IMAGE")).pg).toBe(5);
    }, 60_000);

    it("BILLING_MODE=off iken deneme başlatılmaz", async () => {
      config.current = { ...config.current, mode: "off" };
      expect(await startTrial(newWs(), { now: NOW })).toEqual({
        ok: false,
        reason: "BILLING_OFF",
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("hibe (grant)", () => {
    const base = (ws: string) => ({
      workspaceId: ws,
      pool: "EXTRA" as const,
      reason: "PURCHASE" as const,
      now: NOW,
    });

    it("aynı fatura iki birimi birden verir; aynı (anahtar, birim, neden) yalnız bir kez", async () => {
      const ws = track(newWs());
      expect(
        await grantUsage({
          ...base(ws),
          unit: "IMAGE",
          amount: 20,
          idempotencyKey: "inv_9",
        }),
      ).toEqual({ applied: true });
      expect(
        await grantUsage({
          ...base(ws),
          unit: "AI_MICROS",
          amount: 2_500_000,
          idempotencyKey: "inv_9",
        }),
      ).toEqual({ applied: true });
      expect(
        await grantUsage({
          ...base(ws),
          unit: "IMAGE",
          amount: 20,
          idempotencyKey: "inv_9",
        }),
      ).toEqual({ applied: false, duplicate: true });
      expect((await balanceOf(ws, "IMAGE")).eg).toBe(20);
      expect((await balanceOf(ws, "AI_MICROS")).eg).toBe(2_500_000);
    });

    it("aynı anahtar farklı tutarla: sessiz no-op değil, GrantKeyConflictError", async () => {
      const ws = track(newWs());
      await grantUsage({
        ...base(ws),
        unit: "IMAGE",
        amount: 20,
        idempotencyKey: "inv_c",
      });
      await expect(
        grantUsage({
          ...base(ws),
          unit: "IMAGE",
          amount: 40,
          idempotencyKey: "inv_c",
        }),
      ).rejects.toBeInstanceOf(GrantKeyConflictError);
      expect((await balanceOf(ws, "IMAGE")).eg).toBe(20);
    });

    it("bakiye satırı yokken 10 paralel hibe: tek satır, toplam doğru, hak kaybolmaz", async () => {
      const ws = track(newWs());
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          grantUsage({
            ...base(ws),
            unit: "IMAGE",
            amount: 3_000_000_000 / 10,
            idempotencyKey: `race_${index}`,
          }),
        ),
      );
      expect(
        await prisma.usageBalance.count({ where: { workspaceId: ws } }),
      ).toBe(1);
      // int4 sınırının üstü gidiş-dönüş (BigInt).
      expect((await balanceOf(ws, "IMAGE")).eg).toBe(3_000_000_000);
    }, 60_000);

    it("PERIOD hibesi yalnız açık pencereye yazılır; pencere değiştiyse windowClosed", async () => {
      const ws = track(newWs());
      await activeSubscription(ws);
      await ensurePeriod(ws, { now: NOW });
      const ok = await grantUsage({
        workspaceId: ws,
        unit: "IMAGE",
        pool: "PERIOD",
        amount: 5,
        reason: "PLAN_CHANGE",
        idempotencyKey: "upg_1",
        periodStart: WINDOW_START,
        now: NOW,
      });
      expect(ok).toEqual({ applied: true });
      expect((await balanceOf(ws, "IMAGE")).pg).toBe(GROWTH.IMAGE + 5);
      const stale = await grantUsage({
        workspaceId: ws,
        unit: "IMAGE",
        pool: "PERIOD",
        amount: 5,
        reason: "PLAN_CHANGE",
        idempotencyKey: "upg_2",
        periodStart: new Date("2026-10-01T00:00:00.000Z"),
        now: NOW,
      });
      expect(stale).toEqual({ applied: false, windowClosed: true });
      expect((await balanceOf(ws, "IMAGE")).pg).toBe(GROWTH.IMAGE + 5);
    });

    it("EXTRA hakkı süresiz kalır ve tam erişimde harcanır", async () => {
      const ws = track(newWs());
      await activeSubscription(ws);
      await ensurePeriod(ws, { now: NOW });
      await grantUsage({
        ...base(ws),
        unit: "IMAGE",
        amount: 10,
        idempotencyKey: "pack_1",
      });
      // Dönem havuzunu tüket, sonra extra'dan ayrılır.
      await prisma.usageBalance.update({
        where: { workspaceId_unit: { workspaceId: ws, unit: "IMAGE" } },
        data: { periodUsed: B(50) },
      });
      expect(
        await reserveUsage({
          workspaceId: ws,
          unit: "IMAGE",
          amount: 4,
          reservationKey: "e#1",
          now: NOW,
        }),
      ).toMatchObject({
        ok: true,
        kind: "RESERVED",
        fromPeriod: B(0),
        fromExtra: B(4),
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("veritabanı değişmezleri (CHECK)", () => {
    it("negatif sayaç ve geçersiz birim reddedilir (23514)", async () => {
      const ws = track(newWs());
      await seedBalance(ws, "IMAGE", { periodGranted: 5 });
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "UsageBalance" SET "periodReserved" = -1 WHERE "workspaceId" = $1::text`,
          ws,
        ),
      ).rejects.toThrow(/23514|check/i);
      await expect(
        prisma.usageBalance.create({
          data: { id: randomUUID(), workspaceId: ws, unit: "STORAGE", updatedAt: NOW },
        }),
      ).rejects.toThrow(/23514|check/i);
    });

    it("rezervasyon, hibe ve abonelik kısıtları: 0 tutar, bilinmeyen durum/havuz/aralık reddedilir", async () => {
      const ws = track(newWs());
      const reservation = {
        id: randomUUID(),
        workspaceId: ws,
        unit: "IMAGE",
        reservationKey: "check#1",
        amount: B(1),
        fromPeriod: B(1),
        fromExtra: B(0),
        status: "RESERVED",
        overdraft: false,
        expiresAt: NOW,
        createdAt: NOW,
      };
      await expect(
        prisma.usageReservation.create({ data: { ...reservation, amount: B(0) } }),
      ).rejects.toThrow(/23514|check/i);
      await expect(
        prisma.usageReservation.create({ data: { ...reservation, status: "LOST" } }),
      ).rejects.toThrow(/23514|check/i);
      await expect(
        prisma.usageReservation.create({ data: { ...reservation, fromExtra: B(-1) } }),
      ).rejects.toThrow(/23514|check/i);

      const grant = {
        id: randomUUID(),
        workspaceId: ws,
        unit: "IMAGE",
        pool: "EXTRA",
        amount: B(1),
        reason: "PURCHASE",
        idempotencyKey: "check_grant",
        createdAt: NOW,
      };
      await expect(
        prisma.usageGrant.create({ data: { ...grant, amount: B(0) } }),
      ).rejects.toThrow(/23514|check/i);
      await expect(
        prisma.usageGrant.create({ data: { ...grant, pool: "BONUS" } }),
      ).rejects.toThrow(/23514|check/i);

      await expect(
        prisma.subscription.create({ data: { workspaceId: ws, status: "ZOMBIE" } }),
      ).rejects.toThrow(/23514|check/i);
      await expect(
        prisma.subscription.create({
          data: { workspaceId: ws, status: "ACTIVE", interval: "WEEK" },
        }),
      ).rejects.toThrow(/23514|check/i);
    });
  });

  // -------------------------------------------------------------------------
  describe("süpürücü", () => {
    it("süresi dolan rezervasyon iade edilir; geç gelen settle yine used'a yazılır", async () => {
      const ws = track(newWs());
      await activeSubscription(ws);
      await seedBalance(ws, "IMAGE", { periodGranted: 5 });
      await reserveUsage({
        workspaceId: ws,
        unit: "IMAGE",
        amount: 4,
        reservationKey: "zombie#1",
        now: NOW,
        ttlMs: 60_000,
      });
      await reserveUsage({
        workspaceId: ws,
        unit: "IMAGE",
        amount: 1,
        reservationKey: "fresh#1",
        now: NOW,
        ttlMs: 60 * 60_000,
      });
      expect((await balanceOf(ws, "IMAGE")).pr).toBe(5);

      const later = new Date(NOW.getTime() + 10 * 60_000);
      const swept = await reapExpiredReservations({ now: later });
      expect(swept.released).toBeGreaterThanOrEqual(1);
      expect(await balanceOf(ws, "IMAGE")).toMatchObject({ pr: 1 });

      // Zombi iş sonunda yine de tüketmişti.
      const late = await settleUsage(
        {
          workspaceId: ws,
          unit: "IMAGE",
          reservationKey: "zombie#1",
          now: later,
        },
        3,
      );
      expect(late).toMatchObject({ status: "SETTLED", chargedPeriod: B(3) });
      expect(await balanceOf(ws, "IMAGE")).toMatchObject({ pu: 3, pr: 1 });
    });
  });

  // -------------------------------------------------------------------------
  describe("kiracı izolasyonu", () => {
    it("aynı reservationKey iki workspace'te ayrı rezervasyondur; biri ötekinin bakiyesine dokunmaz", async () => {
      const a = track(newWs());
      const b = track(newWs());
      for (const ws of [a, b]) {
        await activeSubscription(ws);
        await seedBalance(ws, "IMAGE", { periodGranted: 3 });
      }
      await reserveUsage({
        workspaceId: a,
        unit: "IMAGE",
        amount: 3,
        reservationKey: "same#1",
        now: NOW,
      });
      expect(
        await reserveUsage({
          workspaceId: b,
          unit: "IMAGE",
          amount: 2,
          reservationKey: "same#1",
          now: NOW,
        }),
      ).toMatchObject({ ok: true, kind: "RESERVED" });
      // B'nin settle'ı A'nın anahtarını göremez.
      await settleUsage(
        { workspaceId: b, unit: "IMAGE", reservationKey: "same#1", now: NOW },
        2,
      );
      expect(await balanceOf(a, "IMAGE")).toMatchObject({ pr: 3, pu: 0 });
      expect(await balanceOf(b, "IMAGE")).toMatchObject({ pr: 0, pu: 2 });
    });
  });

  // -------------------------------------------------------------------------
  describe("görünüm", () => {
    it("BigInt dışarı sızmaz: JSON'a çevrilebilir sayılar", async () => {
      const ws = track(newWs());
      await activeSubscription(ws);
      await ensurePeriod(ws, { now: NOW });
      const view = await getUsageView(ws, { now: NOW });
      expect(() => JSON.stringify(view)).not.toThrow();
      expect(view.find((u) => u.unit === "IMAGE")).toMatchObject({
        period: { granted: 50, available: 50 },
        available: 50,
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("marka limiti (createWithinLimit)", () => {
    let fixture: AgencyFixture;
    beforeAll(async () => {
      fixture = await createAgencyFixture(`bill-brand-${runId}`);
    }, 60_000);
    afterAll(async () => {
      await teardownAgencyFixture(fixture?.workspaceId);
    });

    const input = (workspaceId: string, slug: string) => ({
      workspaceId,
      name: `Brand ${slug}`,
      slug,
      language: "en",
      country: "US",
    });

    it("limit 2, fixture'da 1 proje: 8 paralel oluşturma tam 1 kabul, 7 ret", async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          ProjectRepository.createWithinLimit(
            input(fixture.workspaceId, `lim-${runId}-${index}`),
            2,
          ),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toHaveLength(7);
      expect(
        await prisma.project.count({
          where: { workspaceId: fixture.workspaceId },
        }),
      ).toBe(2);
    }, 60_000);

    it("limit 0 'sınırsız' değil yasaktır; sayım durumdan bağımsızdır", async () => {
      const refused = await ProjectRepository.createWithinLimit(
        input(fixture.workspaceId, `zero-${runId}`),
        0,
      );
      expect(refused).toMatchObject({ ok: false, limit: 0 });
      await prisma.project.updateMany({
        where: { workspaceId: fixture.workspaceId },
        data: { status: "PAUSED" },
      });
      expect(
        await ProjectRepository.createWithinLimit(
          input(fixture.workspaceId, `paused-${runId}`),
          2,
        ),
      ).toMatchObject({ ok: false, current: 2 });
    });
  });

  // -------------------------------------------------------------------------
  describe("marka silme defteri etkilemez", () => {
    it("ProjectDeletionService sonrası beş defter tablosu durur ve hiçbirinde projectId kolonu yok", async () => {
      const fixture = await createAgencyFixture(`bill-del-${runId}`);
      try {
        await activeSubscription(fixture.workspaceId);
        await ensurePeriod(fixture.workspaceId, { now: NOW });
        await reserveUsage({
          workspaceId: fixture.workspaceId,
          unit: "IMAGE",
          amount: 1,
          reservationKey: "del#1",
          now: NOW,
        });
        await grantUsage({
          workspaceId: fixture.workspaceId,
          unit: "IMAGE",
          pool: "EXTRA",
          amount: 5,
          reason: "PURCHASE",
          idempotencyKey: "del_pack",
          now: NOW,
        });
        await prisma.usageEntry.create({
          data: {
            workspaceId: fixture.workspaceId,
            projectRef: fixture.projectId,
            callId: `del_${runId}`,
            kind: "TEXT",
            purpose: "x",
            provider: "openai",
            model: "m",
            costMicros: B(1),
            costEstimated: false,
            success: true,
            durationMs: 1,
            priceTable: "t",
          },
        });
        const count = async () => ({
          balance: await prisma.usageBalance.count({
            where: { workspaceId: fixture.workspaceId },
          }),
          reservation: await prisma.usageReservation.count({
            where: { workspaceId: fixture.workspaceId },
          }),
          grant: await prisma.usageGrant.count({
            where: { workspaceId: fixture.workspaceId },
          }),
          entry: await prisma.usageEntry.count({
            where: { workspaceId: fixture.workspaceId },
          }),
          subscription: await prisma.subscription.count({
            where: { workspaceId: fixture.workspaceId },
          }),
        });
        const before = await count();
        await ProjectDeletionService.delete(fixture.projectId);
        expect(await count()).toEqual(before);

        const columns = await prisma.$queryRawUnsafe<
          Array<{ table_name: string }>
        >(
          `SELECT table_name FROM information_schema.columns
            WHERE table_schema = current_schema() AND column_name = 'projectId'
              AND table_name IN ('UsageBalance','UsageReservation','UsageGrant','UsageEntry','Subscription')`,
        );
        expect(columns).toEqual([]);
      } finally {
        await prisma.usageEntry.deleteMany({
          where: { workspaceId: fixture.workspaceId },
        });
        await prisma.usageReservation.deleteMany({
          where: { workspaceId: fixture.workspaceId },
        });
        await prisma.usageGrant.deleteMany({
          where: { workspaceId: fixture.workspaceId },
        });
        await prisma.usageBalance.deleteMany({
          where: { workspaceId: fixture.workspaceId },
        });
        await prisma.subscription.deleteMany({
          where: { workspaceId: fixture.workspaceId },
        });
        await teardownAgencyFixture(fixture.workspaceId);
      }
    });
  });
});
