import { describe, expect, it } from "vitest";

import {
  EXTRA_PACKS,
  PLAN_KEYS,
  PLANS,
  REVISION_POLICY,
  TRIAL,
  VIDEO_SELLABLE,
  isUnitSellable,
  quotaFor,
  revisionCostsRight,
  sellableUnits,
  trialQuota,
  upgradeDelta,
  yearlyCents,
  yearlyPerMonthCents,
} from "./plans";
import { ASSUMED_COST, TARGET_GROSS_MARGIN, grossMargin } from "./economics";

describe("paketler (sahip tablosu)", () => {
  it("dört paket, sahibin fiyatları ve ilk ay kampanyası", () => {
    expect(PLAN_KEYS).toEqual(["starter", "growth", "business", "agency"]);
    expect(PLAN_KEYS.map((key) => PLANS[key].monthlyCents)).toEqual([
      7_900, 14_900, 29_900, 59_900,
    ]);
    expect(PLAN_KEYS.map((key) => PLANS[key].firstMonthCents)).toEqual([
      3_900, 7_900, 14_900, 39_900,
    ]);
    expect(PLAN_KEYS.map((key) => PLANS[key].brandLimit)).toEqual([
      1, 1, 3, 10,
    ]);
  });

  it("kotalar: görsel, video ve diğer AI bütçesi (mikro-dolar)", () => {
    expect(PLANS.starter.quota).toEqual({
      IMAGE: 20,
      VIDEO: 2,
      AI_MICROS: 3_000_000,
    });
    expect(PLANS.agency.quota).toEqual({
      IMAGE: 300,
      VIDEO: 30,
      AI_MICROS: 40_000_000,
    });
  });

  it("video satılmıyor: kotası 0, birim satılabilir değil", () => {
    expect(VIDEO_SELLABLE).toBe(false);
    expect(isUnitSellable("VIDEO")).toBe(false);
    expect(sellableUnits()).toEqual(["IMAGE", "AI_MICROS"]);
    for (const key of PLAN_KEYS) {
      expect(quotaFor(key).VIDEO).toBe(0);
    }
    expect(trialQuota().VIDEO).toBe(0);
  });

  it("otonomi yalnız Starter'da sınırlı", () => {
    expect(PLANS.starter.autonomy).toBe("limited");
    expect(PLANS.growth.autonomy).toBe("full");
    expect(PLANS.business.autonomy).toBe("full");
    expect(PLANS.agency.autonomy).toBe("full");
  });
});

describe("kota, ilk ay ve yıllık", () => {
  it("ilk ay kotası yalnız Business ve Agency'de %75", () => {
    expect(quotaFor("starter", { firstMonth: true })).toEqual(
      quotaFor("starter"),
    );
    expect(quotaFor("growth", { firstMonth: true })).toEqual(
      quotaFor("growth"),
    );
    expect(quotaFor("business", { firstMonth: true })).toMatchObject({
      IMAGE: 90,
      AI_MICROS: 13_500_000,
    });
    expect(quotaFor("agency", { firstMonth: true })).toMatchObject({
      IMAGE: 225,
      AI_MICROS: 30_000_000,
    });
  });

  it("yıllık = aylık x 12 x %80, tam sayı cent", () => {
    expect(yearlyCents("starter")).toBe(75_840);
    expect(yearlyCents("growth")).toBe(143_040);
    expect(yearlyCents("business")).toBe(287_040);
    expect(yearlyCents("agency")).toBe(575_040);
    for (const key of PLAN_KEYS) {
      expect(Number.isInteger(yearlyCents(key))).toBe(true);
      expect(yearlyPerMonthCents(key)).toBeLessThan(PLANS[key].monthlyCents);
    }
  });

  it("deneme: 7 gün, 5 görsel, 1 USD AI, tek marka, sınırlı otonomi", () => {
    expect(TRIAL.days).toBe(7);
    expect(trialQuota()).toEqual({ IMAGE: 5, VIDEO: 0, AI_MICROS: 1_000_000 });
    expect(TRIAL.brandLimit).toBe(1);
    expect(TRIAL.autonomy).toBe("limited");
  });
});

describe("orantılı yükseltme", () => {
  const from = quotaFor("starter");
  const to = quotaFor("growth");

  it("pencerenin tamamı kaldıysa fark tam, yarısı kaldıysa yarısı", () => {
    expect(upgradeDelta(from, to, 1)).toEqual({
      IMAGE: 30,
      VIDEO: 0,
      AI_MICROS: 5_000_000,
    });
    expect(upgradeDelta(from, to, 0.5)).toEqual({
      IMAGE: 15,
      VIDEO: 0,
      AI_MICROS: 2_500_000,
    });
  });

  it("son gün neredeyse hiç hak vermez; negatif fark ve aralık dışı oran güvenli", () => {
    expect(upgradeDelta(from, to, 1 / 30).IMAGE).toBe(1);
    expect(upgradeDelta(to, from, 1)).toEqual({
      IMAGE: 0,
      VIDEO: 0,
      AI_MICROS: 0,
    });
    expect(upgradeDelta(from, to, -1).IMAGE).toBe(0);
    expect(upgradeDelta(from, to, 7).IMAGE).toBe(30);
  });
});

describe("ek paketler", () => {
  it("asgari fiyat: maliyet / 0,30 (≥%70 marj)", () => {
    const pack = EXTRA_PACKS.images20;
    const costUsd = pack.amount * ASSUMED_COST.imageUsd;
    expect(pack.priceCents / 100).toBeGreaterThanOrEqual(costUsd / 0.3);
    const ai = EXTRA_PACKS.ai250;
    expect(ai.priceCents / 100).toBeGreaterThanOrEqual(
      ai.amount / 1_000_000 / 0.3,
    );
  });
});

describe("pazarlık koruması: satılan teklifte brüt marj ≥ %70", () => {
  // Varsayım maliyetlerle (economics.ts) ve kotanın TAMAMI kullanılırsa.
  // Gerçek maliyet ölçüldükçe economics.ts güncellenir; bu test, fiyat ya da kota
  // değişikliği marjı hedefin altına düşürürse kırılır.
  for (const key of PLAN_KEYS) {
    for (const scenario of ["normal", "firstMonth", "yearly"] as const) {
      it(`${key} / ${scenario}`, () => {
        expect(grossMargin(key, scenario)).toBeGreaterThanOrEqual(
          TARGET_GROSS_MARGIN,
        );
      });
    }
  }

  it("ilk ay indirimi + bonus yığılırsa hedefin altına inen paket olurdu (yığma yasağının nedeni)", () => {
    // %25 bonus = kota x 1,25 (ilk ay fiyatıyla): Business %100 kullanımda <%70.
    const business = PLANS.business;
    const quota = quotaFor("business", { firstMonth: true });
    const cost =
      quota.IMAGE * 1.25 * ASSUMED_COST.imageUsd +
      (quota.AI_MICROS * 1.25) / 1_000_000 +
      business.brandLimit * ASSUMED_COST.infraPerBrandUsd;
    const revenue = business.firstMonthCents / 100;
    expect((revenue - cost) / revenue).toBeLessThan(TARGET_GROSS_MARGIN + 0.1);
    expect(grossMargin("business", "firstMonth", 1.25)).toBeLessThan(
      grossMargin("business", "firstMonth", 1),
    );
  });
});

describe("revizyon politikası", () => {
  it("ilk revizyonlar ücretsiz, sonrakiler 1 görsel hakkı yer", () => {
    expect(REVISION_POLICY.freePerPost).toBe(2);
    // Sürüm 1 = ilk görsel: 1. ve 2. revizyon (sürüm 2 ve 3'ü üretir) bedava.
    expect(revisionCostsRight(1)).toBe(false);
    expect(revisionCostsRight(2)).toBe(false);
    // 3. revizyon (sürüm 4'ü üretir) hak yer.
    expect(revisionCostsRight(3)).toBe(true);
    expect(revisionCostsRight(10)).toBe(true);
  });
});
