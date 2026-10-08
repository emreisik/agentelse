import { describe, expect, it } from "vitest";

import {
  BILLING_OFF,
  planWindow,
  resolveEntitlements,
  type BillingConfig,
  type SubscriptionFacts,
} from "./entitlements-core";
import { RENEWAL_LAG_MS } from "./plans";

const d = (iso: string) => new Date(iso);
const NOW = d("2026-11-15T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const enforce: BillingConfig = { ...BILLING_OFF, mode: "enforce" };
const shadow: BillingConfig = { ...BILLING_OFF, mode: "shadow" };

function sub(overrides: Partial<SubscriptionFacts> = {}): SubscriptionFacts {
  return {
    planKey: "growth",
    interval: "MONTH",
    status: "ACTIVE",
    quotaAnchor: d("2026-11-01T00:00:00.000Z"),
    paidThrough: d("2026-12-01T00:00:00.000Z"),
    trialEndsAt: null,
    graceUntil: null,
    legacyUntil: null,
    cancelAtPeriodEnd: false,
    periodIndex: 1,
    introOffer: false,
    pendingPlanKey: null,
    pendingInterval: null,
    pendingEffectiveAt: null,
    exempt: false,
    ...overrides,
  };
}

function resolve(
  subscription: SubscriptionFacts | null,
  config: BillingConfig = enforce,
  extra: { createdAt?: Date | null; now?: Date } = {},
) {
  return resolveEntitlements({
    workspaceCreatedAt: extra.createdAt ?? null,
    subscription,
    config,
    now: extra.now ?? NOW,
  });
}

describe("resolveEntitlements: mod", () => {
  it("off: aboneliğe bakmadan tam erişim, sınırsız, engellenmez", () => {
    const ent = resolve(null, BILLING_OFF);
    expect(ent).toMatchObject({
      access: "FULL",
      reason: "OFF",
      unlimited: true,
      enforced: false,
      brandLimit: null,
    });
  });

  it("shadow: karar hesaplanır ama enforced=false", () => {
    const ent = resolve(null, shadow);
    expect(ent.access).toBe("READ_ONLY");
    expect(ent.reason).toBe("NO_SUBSCRIPTION");
    expect(ent.enforced).toBe(false);
  });

  it("enforce: engelleme uygulanır", () => {
    expect(resolve(null, enforce).enforced).toBe(true);
    expect(resolve(null, shadow).enforced).toBe(false);
    expect(resolve(null, BILLING_OFF).enforced).toBe(false);
  });

  it("muaf hesap her modda tam erişim ve sınırsız", () => {
    const ent = resolve(sub({ exempt: true, status: "CANCELED" }));
    expect(ent).toMatchObject({
      access: "FULL",
      reason: "EXEMPT",
      unlimited: true,
    });
  });
});

describe("resolveEntitlements: satırsız workspace", () => {
  const cfg: BillingConfig = {
    ...enforce,
    legacyBefore: d("2026-10-01T00:00:00.000Z"),
    legacyUntil: d("2026-11-20T00:00:00.000Z"),
  };

  it("eşikten önce açılmış = mevcut müşteri (LEGACY), süre dolana kadar sınırsız", () => {
    const ent = resolve(null, cfg, {
      createdAt: d("2026-09-01T00:00:00.000Z"),
    });
    expect(ent).toMatchObject({
      access: "FULL",
      reason: "LEGACY",
      unlimited: true,
    });
  });

  it("LEGACY süresi dolunca salt-okunur ve yeni marka yok", () => {
    const ent = resolve(null, cfg, {
      createdAt: d("2026-09-01T00:00:00.000Z"),
      now: d("2026-11-20T00:00:00.000Z"),
    });
    expect(ent).toMatchObject({
      access: "READ_ONLY",
      reason: "LEGACY_ENDED",
      brandLimit: 0,
    });
  });

  it("eşikten sonra açılmış: önce deneme/plan gerekir (NO_SUBSCRIPTION)", () => {
    const ent = resolve(null, cfg, {
      createdAt: d("2026-10-02T00:00:00.000Z"),
    });
    expect(ent).toMatchObject({
      access: "READ_ONLY",
      reason: "NO_SUBSCRIPTION",
      brandLimit: 0,
    });
  });

  it("eşik tanımsızsa kimse LEGACY sayılmaz", () => {
    const ent = resolve(null, enforce, {
      createdAt: d("2020-01-01T00:00:00.000Z"),
    });
    expect(ent.reason).toBe("NO_SUBSCRIPTION");
  });

  it("LEGACY satırı kendi legacyUntil'ini ayar tarihine tercih eder", () => {
    const row = sub({
      status: "LEGACY",
      planKey: null,
      quotaAnchor: null,
      paidThrough: null,
      legacyUntil: d("2026-11-10T00:00:00.000Z"),
    });
    expect(resolve(row, cfg).reason).toBe("LEGACY_ENDED");
  });
});

describe("resolveEntitlements: deneme", () => {
  const trial = sub({
    status: "TRIALING",
    planKey: null,
    quotaAnchor: d("2026-11-10T00:00:00.000Z"),
    paidThrough: null,
    trialEndsAt: d("2026-11-17T00:00:00.000Z"),
  });

  it("deneme süresince tam erişim, tek marka, sınırlı otonomi", () => {
    const ent = resolve(trial);
    expect(ent).toMatchObject({
      access: "FULL",
      reason: "TRIAL",
      isTrial: true,
      brandLimit: 1,
      autonomy: "limited",
      canOpenNewWindows: false,
    });
    expect(ent.spendThrough).toEqual(d("2026-11-17T00:00:00.000Z"));
  });

  it("deneme bitince salt-okunur", () => {
    const ent = resolve(trial, enforce, { now: d("2026-11-17T00:00:00.000Z") });
    expect(ent).toMatchObject({ access: "READ_ONLY", reason: "TRIAL_ENDED" });
  });

  it("trialEndsAt yoksa deneme geçersiz sayılır", () => {
    expect(resolve({ ...trial, trialEndsAt: null }).reason).toBe("TRIAL_ENDED");
  });
});

describe("resolveEntitlements: aktif abonelik", () => {
  it("ödenmiş süre içinde plan hakları", () => {
    const ent = resolve(sub());
    expect(ent).toMatchObject({
      access: "FULL",
      reason: "ACTIVE",
      planKey: "growth",
      brandLimit: 1,
      autonomy: "full",
      canOpenNewWindows: true,
    });
  });

  it("yenileme gecikmesi payı: dönem bitti, webhook henüz gelmedi", () => {
    const paidThrough = d("2026-12-01T00:00:00.000Z");
    const row = sub({ paidThrough });
    expect(
      resolve(row, enforce, {
        now: new Date(paidThrough.getTime() + 5 * 60_000),
      }).access,
    ).toBe("FULL");
    expect(
      resolve(row, enforce, { now: new Date(paidThrough.getTime() + 5 * HOUR) })
        .access,
    ).toBe("FULL");
    const late = resolve(row, enforce, {
      now: new Date(paidThrough.getTime() + RENEWAL_LAG_MS + 1),
    });
    expect(late).toMatchObject({
      access: "READ_ONLY",
      reason: "PAST_DUE_ENDED",
    });
  });

  it("iptal edilmiş (dönem sonunda biter) abonelikte yenileme payı yok", () => {
    const paidThrough = d("2026-12-01T00:00:00.000Z");
    const row = sub({ paidThrough, cancelAtPeriodEnd: true });
    expect(
      resolve(row, enforce, { now: new Date(paidThrough.getTime() - 1) })
        .access,
    ).toBe("FULL");
    expect(
      resolve(row, enforce, { now: new Date(paidThrough.getTime() + 1) }),
    ).toMatchObject({ access: "READ_ONLY", reason: "CANCELED" });
  });

  it("plansız, çapasız ya da paidThrough'suz ACTIVE satırı güvenli tarafta salt-okunur ve AYIRT EDİLİR", () => {
    for (const broken of [
      sub({ planKey: null }),
      sub({ paidThrough: null }),
      sub({ quotaAnchor: null }),
      sub({ planKey: "platinum" }),
    ]) {
      expect(resolve(broken)).toMatchObject({
        access: "READ_ONLY",
        reason: "INCOMPLETE_SUBSCRIPTION",
      });
    }
  });

  it("marka limiti ve otonomi plana göre", () => {
    expect(resolve(sub({ planKey: "starter" }))).toMatchObject({
      brandLimit: 1,
      autonomy: "limited",
    });
    expect(resolve(sub({ planKey: "business" })).brandLimit).toBe(3);
    expect(resolve(sub({ planKey: "agency" })).brandLimit).toBe(10);
  });
});

describe("resolveEntitlements: ödeme sorunları ve iptal", () => {
  it("PAST_DUE ek süresinde erişim sürer ama yeni pencere açılmaz", () => {
    const row = sub({
      status: "PAST_DUE",
      graceUntil: d("2026-11-18T00:00:00.000Z"),
    });
    expect(resolve(row)).toMatchObject({
      access: "FULL",
      reason: "PAST_DUE_GRACE",
      canOpenNewWindows: false,
    });
    expect(
      resolve(row, enforce, { now: d("2026-11-18T00:00:00.000Z") }),
    ).toMatchObject({ access: "READ_ONLY", reason: "PAST_DUE_ENDED" });
  });

  it("CANCELED: ödenmiş süre bitene kadar (yıllıkta kalan aylar dahil) kullanım", () => {
    const row = sub({
      status: "CANCELED",
      interval: "YEAR",
      paidThrough: d("2027-03-01T00:00:00.000Z"),
    });
    expect(resolve(row)).toMatchObject({
      access: "FULL",
      reason: "CANCELED_GRACE",
      canOpenNewWindows: true,
    });
    expect(
      resolve(row, enforce, { now: d("2027-03-01T00:00:00.000Z") }),
    ).toMatchObject({ access: "READ_ONLY", reason: "CANCELED" });
  });

  it("bilinmeyen durum güvenli tarafta salt-okunur", () => {
    expect(resolve(sub({ status: "WEIRD" })).reason).toBe(
      "INCOMPLETE_SUBSCRIPTION",
    );
  });

  it("CANCELED ama çapasız ve ödenmiş süresi sürüyor: sessiz geçilmez", () => {
    const row = sub({
      status: "CANCELED",
      quotaAnchor: null,
      paidThrough: d("2027-03-01T00:00:00.000Z"),
    });
    expect(resolve(row).reason).toBe("INCOMPLETE_SUBSCRIPTION");
  });
});

describe("planWindow", () => {
  const fullEnt = (row: SubscriptionFacts, now = NOW) =>
    resolve(row, enforce, { now });

  it("aktif aylık: pencere çapadan, plan kotası, pencere sonu ödenmiş süreyi aşmaz", () => {
    const row = sub();
    const plan = planWindow({
      subscription: row,
      entitlements: fullEnt(row),
      now: NOW,
    })!;
    expect(plan.start).toEqual(d("2026-11-01T00:00:00.000Z"));
    expect(plan.end).toEqual(d("2026-12-01T00:00:00.000Z"));
    // Harcama ufku ödenmiş süre + yenileme payı (6 saat).
    expect(plan.spendThrough).toEqual(d("2026-12-01T06:00:00.000Z"));
    expect(plan.quota).toMatchObject({
      IMAGE: 50,
      VIDEO: 0,
      AI_MICROS: 8_000_000,
    });
    expect(plan.firstMonth).toBe(false);
  });

  it("yıllık abonede pencere yine aylık, kota yine aylık", () => {
    const row = sub({
      interval: "YEAR",
      quotaAnchor: d("2026-03-05T00:00:00.000Z"),
      paidThrough: d("2027-03-05T00:00:00.000Z"),
    });
    const plan = planWindow({
      subscription: row,
      entitlements: fullEnt(row),
      now: NOW,
    })!;
    expect(plan.start).toEqual(d("2026-11-05T00:00:00.000Z"));
    expect(plan.end).toEqual(d("2026-12-05T00:00:00.000Z"));
    expect(plan.quota.IMAGE).toBe(50);
  });

  it("ödenmiş süre pencerenin sonunu DEĞİŞTİRMEZ, yalnız harcama ufkunu belirler", () => {
    const row = sub({
      status: "CANCELED",
      paidThrough: d("2026-11-20T00:00:00.000Z"),
    });
    const plan = planWindow({
      subscription: row,
      entitlements: fullEnt(row),
      now: NOW,
    })!;
    expect(plan.end).toEqual(d("2026-12-01T00:00:00.000Z"));
    expect(plan.spendThrough).toEqual(d("2026-11-20T00:00:00.000Z"));
  });

  it("ilk ay kampanyası: yalnız ilk pencere, ilk fatura döneminde, kota %75 (Business)", () => {
    const row = sub({
      planKey: "business",
      introOffer: true,
      quotaAnchor: d("2026-11-10T00:00:00.000Z"),
      paidThrough: d("2026-12-10T00:00:00.000Z"),
    });
    const first = planWindow({
      subscription: row,
      entitlements: fullEnt(row),
      now: NOW,
    })!;
    expect(first.firstMonth).toBe(true);
    expect(first.quota.IMAGE).toBe(90);

    // İkinci pencere (ödeme yenilenmiş): tam kota.
    const renewed = sub({
      planKey: "business",
      introOffer: true,
      periodIndex: 2,
      quotaAnchor: d("2026-10-10T00:00:00.000Z"),
      paidThrough: d("2026-12-10T00:00:00.000Z"),
    });
    const second = planWindow({
      subscription: renewed,
      entitlements: fullEnt(renewed),
      now: NOW,
    })!;
    expect(second.firstMonth).toBe(false);
    expect(second.quota.IMAGE).toBe(120);
  });

  it("zamanlanmış düşürme pencere sınırında devreye girer, ortasında değil", () => {
    const row = sub({
      planKey: "business",
      pendingPlanKey: "starter",
      pendingEffectiveAt: d("2026-12-01T00:00:00.000Z"),
      paidThrough: d("2026-12-31T00:00:00.000Z"),
    });
    const before = planWindow({
      subscription: row,
      entitlements: fullEnt(row),
      now: NOW,
    })!;
    expect(before.planKey).toBe("business");
    expect(before.appliesPending).toBe(false);

    const nowDec = d("2026-12-02T00:00:00.000Z");
    const after = planWindow({
      subscription: row,
      entitlements: fullEnt(row, nowDec),
      now: nowDec,
    })!;
    expect(after.planKey).toBe("starter");
    expect(after.appliesPending).toBe(true);
    expect(after.quota.IMAGE).toBe(20);
  });

  it("yalnız aralık değişimi (aynı plan) pencere sınırında uygulanır, plan korunur", () => {
    const row = sub({
      planKey: "growth",
      interval: "MONTH",
      pendingInterval: "YEAR",
      pendingEffectiveAt: d("2026-12-01T00:00:00.000Z"),
      paidThrough: d("2027-12-01T00:00:00.000Z"),
    });
    const dec = d("2026-12-02T00:00:00.000Z");
    const plan = planWindow({
      subscription: row,
      entitlements: fullEnt(row, dec),
      now: dec,
    })!;
    expect(plan.appliesPending).toBe(true);
    expect(plan.planKey).toBe("growth");
    expect(plan.quota.IMAGE).toBe(50);
  });

  it("yürürlüğe giren düşürme, pencere yazılmadan da marka limiti ve otonomiye yansır", () => {
    const row = sub({
      planKey: "business",
      pendingPlanKey: "starter",
      pendingEffectiveAt: d("2026-11-10T00:00:00.000Z"),
    });
    expect(resolve(row)).toMatchObject({
      planKey: "starter",
      brandLimit: 1,
      autonomy: "limited",
    });
  });

  it("deneme: tek pencere, deneme kotası", () => {
    const row = sub({
      status: "TRIALING",
      planKey: null,
      quotaAnchor: d("2026-11-10T00:00:00.000Z"),
      paidThrough: null,
      trialEndsAt: d("2026-11-17T00:00:00.000Z"),
    });
    const plan = planWindow({
      subscription: row,
      entitlements: fullEnt(row),
      now: NOW,
    })!;
    expect(plan.quota).toEqual({ IMAGE: 5, VIDEO: 0, AI_MICROS: 1_000_000 });
    expect(plan.end).toEqual(d("2026-11-17T00:00:00.000Z"));
  });

  it("PAST_DUE, LEGACY, salt-okunur ve sınırsız hallerde pencere açılmaz", () => {
    for (const row of [
      sub({ status: "PAST_DUE", graceUntil: d("2026-11-18T00:00:00.000Z") }),
      sub({
        status: "LEGACY",
        planKey: null,
        paidThrough: null,
        quotaAnchor: null,
      }),
      sub({
        paidThrough: d("2026-11-01T00:00:00.000Z"),
        cancelAtPeriodEnd: true,
      }),
    ]) {
      expect(
        planWindow({ subscription: row, entitlements: fullEnt(row), now: NOW }),
      ).toBeNull();
    }
    const off = resolve(sub(), BILLING_OFF);
    expect(
      planWindow({ subscription: sub(), entitlements: off, now: NOW }),
    ).toBeNull();
  });

  it("yenileme payı içinde erişim sürer ama YENİ pencere açılmaz; ödeme gelince açılır", () => {
    const row = sub({ paidThrough: d("2026-12-01T00:00:00.000Z") });
    const during = d("2026-12-01T02:00:00.000Z");
    const ent = fullEnt(row, during);
    expect(ent.access).toBe("FULL");
    expect(planWindow({ subscription: row, entitlements: ent, now: during })).toBeNull();

    // Webhook geldi: ödenmiş süre ilerledi, Aralık penceresi açılır (geçmişten başlar).
    const paid = sub({ paidThrough: d("2027-01-01T00:00:00.000Z") });
    const opened = planWindow({
      subscription: paid,
      entitlements: fullEnt(paid, during),
      now: during,
    })!;
    expect(opened.start).toEqual(d("2026-12-01T00:00:00.000Z"));
    expect(opened.end).toEqual(d("2027-01-01T00:00:00.000Z"));
  });

  it("çapa gelecekteyse pencere yok", () => {
    const row = sub({ quotaAnchor: d("2026-12-01T00:00:00.000Z") });
    expect(
      planWindow({ subscription: row, entitlements: fullEnt(row), now: NOW }),
    ).toBeNull();
  });
});
