// Abonelik paketleri ve kullanım hakları: TEK doğruluk kaynağı (sürümlü kod).
// Saf ve izomorfik (server-only DEĞİL): fiyat sayfası, checkout ve sunucu aynı
// sabitleri okur, ekranda görülen ile tahsil edilen ayrışmaz. Veritabanında plan
// tablosu YOK; fiyat/kota değişikliği bu dosyada bir commit'tir.
//
// Sahip kararları (8 Eki 2026, ~/.claude/plans/billing-usage-plan.md bölüm H):
// - AI video satışta YOK (video motoru yok); VIDEO birimi veri modelinde hazır.
// - 1 görsel hakkı = bir post'un ana görseli; uyarlamalar hak yemez.
// - Temel (Starter) pakette otonom arka plan döngüleri sınırlı, diğerlerinde tam.
//   Dört modülün hepsi tüm paketlerde açıktır; fark yalnız otonomidir.
// - Business ve Agency'de ilk ay kotası %75.
// Rakamlar BAŞLANGIÇ HİPOTEZİDİR: gerçek maliyet (db:report:cost) ile doğrulanmadan
// canlı fiyatlandırmaya uygulanmaz.

export const PLANS_VERSION = "2026-10-09";

export const PLAN_KEYS = ["starter", "growth", "business", "agency"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export function isPlanKey(value: unknown): value is PlanKey {
  return (
    typeof value === "string" &&
    (PLAN_KEYS as readonly string[]).includes(value)
  );
}

// IMAGE: görsel adedi, VIDEO: 10 sn'lik video adedi, AI_MICROS: diğer AI
// işlemleri için hedef API maliyet bütçesi (mikro-dolar, 1 USD = 1_000_000).
export const USAGE_UNITS = ["IMAGE", "VIDEO", "AI_MICROS"] as const;
export type UsageUnit = (typeof USAGE_UNITS)[number];

export function isUsageUnit(value: unknown): value is UsageUnit {
  return (
    typeof value === "string" &&
    (USAGE_UNITS as readonly string[]).includes(value)
  );
}

export type Quota = Record<UsageUnit, number>;

// "limited": otonom arka plan döngüleri kapalı ya da haftalık (Faz 3 uygular).
export type Autonomy = "limited" | "full";

export type PlanDef = {
  key: PlanKey;
  label: string;
  // Cent (USD minor unit).
  monthlyCents: number;
  firstMonthCents: number;
  brandLimit: number;
  quota: Quota;
  autonomy: Autonomy;
  // İlk ay kampanyasında kota çarpanı (1 = tam).
  firstMonthQuotaFactor: number;
};

const usd = (dollars: number) => Math.round(dollars * 1_000_000);

export const PLANS: Readonly<Record<PlanKey, PlanDef>> = {
  starter: {
    key: "starter",
    label: "Starter",
    monthlyCents: 7_900,
    firstMonthCents: 3_900,
    brandLimit: 1,
    quota: { IMAGE: 20, VIDEO: 2, AI_MICROS: usd(3) },
    autonomy: "limited",
    firstMonthQuotaFactor: 1,
  },
  growth: {
    key: "growth",
    label: "Growth",
    monthlyCents: 14_900,
    firstMonthCents: 7_900,
    brandLimit: 1,
    quota: { IMAGE: 50, VIDEO: 5, AI_MICROS: usd(8) },
    autonomy: "full",
    firstMonthQuotaFactor: 1,
  },
  business: {
    key: "business",
    label: "Business",
    monthlyCents: 29_900,
    firstMonthCents: 14_900,
    brandLimit: 3,
    quota: { IMAGE: 120, VIDEO: 12, AI_MICROS: usd(18) },
    autonomy: "full",
    firstMonthQuotaFactor: 0.75,
  },
  agency: {
    key: "agency",
    label: "Agency",
    monthlyCents: 59_900,
    firstMonthCents: 39_900,
    brandLimit: 10,
    quota: { IMAGE: 300, VIDEO: 30, AI_MICROS: usd(40) },
    autonomy: "full",
    firstMonthQuotaFactor: 0.75,
  },
};

// Video motoru yok: satılmaz, kota kartında gösterilmez, rezervasyonu reddedilir.
// Motor kurulunca true yapılır (ayrıca bir proje).
export const VIDEO_SELLABLE = false;

export function sellableUnits(): readonly UsageUnit[] {
  return VIDEO_SELLABLE ? USAGE_UNITS : ["IMAGE", "AI_MICROS"];
}

export function isUnitSellable(unit: UsageUnit): boolean {
  return unit !== "VIDEO" || VIDEO_SELLABLE;
}

// Yıllık abonelikte aylık fiyata göre indirim yüzdesi (fatura yılda bir, KOTA
// yine her ay verilir).
export const YEARLY_DISCOUNT_PCT = 20;

// İlk abonelikte bonus kullanım (Faz 5 verir; ilk ay kampanyası ve yıllıkla
// YIĞILMAZ).
export const FIRST_SUBSCRIPTION_BONUS_PCT = 25;
// Bonus havuzunun ömrü (gün). Sahip onayı bekliyor; promosyon kredisi sonsuz
// yükümlülüğe dönmesin diye süreli.
export const BONUS_TTL_DAYS = 60;

// 7 günlük sınırlı ücretsiz deneme (tek kez: Subscription.trialEndsAt bir kez
// yazılır, "daha önce deneme aldı" = trialEndsAt dolu).
export const TRIAL = {
  days: 7,
  brandLimit: 1,
  autonomy: "limited" as Autonomy,
  quota: { IMAGE: 5, VIDEO: 0, AI_MICROS: usd(1) } as Quota,
} as const;

// Ek kullanım paketleri: maliyetin üstünde, ≈%75 marj (asgari ≥%70).
export const EXTRA_PACKS = {
  images20: { unit: "IMAGE", amount: 20, priceCents: 1_200 },
  ai250: { unit: "AI_MICROS", amount: usd(2.5), priceCents: 1_000 },
} as const satisfies Record<
  string,
  { unit: UsageUnit; amount: number; priceCents: number }
>;
export type ExtraPackKey = keyof typeof EXTRA_PACKS;

// Yenileme gecikmesi payı: dönem sonundan sonra webhook gelene kadar kullanıcı
// karartılmaz (ödeme genelde birkaç dakikada işlenir).
export const RENEWAL_LAG_MS = 6 * 60 * 60 * 1000;
// Ödeme başarısızlığından sonra ek süre.
export const PAST_DUE_GRACE_DAYS = 3;

// Rezervasyon ömrü varsayılanı: çökmüş bir işin tuttuğu hak bu süre sonra
// süpürücüyle geri verilir.
export const RESERVATION_TTL_MS = 45 * 60 * 1000;

// Yürütme işi (görsel/metin üretimi) rezervasyonu: sağlayıcı yeniden denemeleri
// (token ikiye katlama zinciri, 4 deneme x ~2 dk) bir işi 45 dakikanın üstüne
// uzatabilir; süpürücü hâlâ koşan işin hakkını geri vermesin. Çökmüş iş en çok bu
// kadar tutar (self-healing 30 dk'da zaten FAILED yapar).
export const JOB_RESERVATION_TTL_MS = 90 * 60 * 1000;

// Görev başına azami maliyet ("her göreve maksimum bütçe", Faz 3): bir işin
// gerçek maliyeti bu tavanı aşarsa SONRAKİ ücretli çağrı başlamaz. Tavan
// rezervasyondan bağımsız bir emniyet kemeridir (sağlayıcı yeniden denemeleri,
// token ikiye katlama zinciri); normal işler tavanın çok altında kalır.
//  - perImageUsd: içerik işinde her görsel hakkı için (metin + art direction +
//    çizim yüksek kalitede bile ≈ $0,4);
//  - noImageUsd: görsel hakkı yemeyen içerik işi (uyarlama, fotoğraflı gönderi);
//  - aiMultiplier: AI işinde rezervasyonun katı.
export const TASK_CEILING = {
  perImageUsd: 0.75,
  noImageUsd: 0.5,
  aiMultiplier: 3,
} as const;

// Revizyon politikası (Faz 3): bir gönderinin görselini düzenlemek ya da yeniden
// üretmek (Studio, "revize et") bir görsel modeli çağırır ve gerçek maliyet
// doğurur. Açık ve maliyeti sınırlı kural: gönderi başına ilk `freePerPost`
// görsel revizyon ek hak yemez (deneme yanılma payı); sonrakilerin her biri 1
// IMAGE hakkı yer. Kalite varsayılanı DEĞİŞMEZ (maliyeti düşürmek için kaliteyi
// kontrolsüz azaltmak şartnameye aykırı); gerçek maliyet verisiyle sahip karar verir.
export const REVISION_POLICY = {
  freePerPost: 2,
} as const;

// `currentVersion`: gönderinin şu anki (en yeni) sürüm numarası, 1'den başlar.
// Yapılacak revizyon bir sonraki sürümü üretir; ilk `freePerPost` revizyon
// (sürüm 2, 3) ücretsizdir, 4. sürümden itibaren her revizyon 1 hak yer.
export function revisionCostsRight(currentVersion: number): boolean {
  return currentVersion > REVISION_POLICY.freePerPost;
}

export function getPlan(key: PlanKey): PlanDef {
  return PLANS[key];
}

// Bir pencere için plan kotası. Satılmayan birimler 0'dır. firstMonth: ilk ücretli
// dönemin ilk ay kampanyası penceresi (yalnız kota çarpanı olan planlarda fark eder).
export function quotaFor(
  planKey: PlanKey,
  options: { firstMonth?: boolean } = {},
): Quota {
  const plan = PLANS[planKey];
  const factor = options.firstMonth ? plan.firstMonthQuotaFactor : 1;
  const scaled = (unit: UsageUnit) =>
    isUnitSellable(unit) ? Math.floor(plan.quota[unit] * factor) : 0;
  return {
    IMAGE: scaled("IMAGE"),
    VIDEO: scaled("VIDEO"),
    AI_MICROS: scaled("AI_MICROS"),
  };
}

export function trialQuota(): Quota {
  return {
    IMAGE: isUnitSellable("IMAGE") ? TRIAL.quota.IMAGE : 0,
    VIDEO: isUnitSellable("VIDEO") ? TRIAL.quota.VIDEO : 0,
    AI_MICROS: isUnitSellable("AI_MICROS") ? TRIAL.quota.AI_MICROS : 0,
  };
}

// Yıllık toplam (cent): aylık x 12 x (1 - indirim).
export function yearlyCents(planKey: PlanKey): number {
  return Math.round(
    (PLANS[planKey].monthlyCents * 12 * (100 - YEARLY_DISCOUNT_PCT)) / 100,
  );
}

export function yearlyPerMonthCents(planKey: PlanKey): number {
  return Math.round(yearlyCents(planKey) / 12);
}

// Orantılı yükseltme kotası: yükseltmede fark, kalan pencere oranıyla verilir
// (Stripe ücreti de kalan süreye orantılar; ay sonunda yükselt-tam kullan-düşür
// hilesi kapanır). Birim bazında floor; negatif fark 0.
export function upgradeDelta(
  from: Quota,
  to: Quota,
  remainingFraction: number,
): Quota {
  const fraction = Math.min(1, Math.max(0, remainingFraction));
  const delta = (unit: UsageUnit) =>
    Math.floor(Math.max(0, to[unit] - from[unit]) * fraction);
  return {
    IMAGE: delta("IMAGE"),
    VIDEO: delta("VIDEO"),
    AI_MICROS: delta("AI_MICROS"),
  };
}
