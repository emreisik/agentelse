// Hak kararı: saf ve izomorfik. Girdi: abonelik satırı (ya da yok), workspace'in
// açılış tarihi, faturalama ayarı ve "şimdi". Çıktı: erişim, plan, marka limiti,
// otonomi, kota penceresi. Veritabanı/ortam okumaz; tüm karar tablosu burada
// birim testlidir (entitlements-core.test.ts). DB sarmalayıcısı: server/billing.
//
// Üç mod:
//  - off     : hiçbir şey değişmez (hepsi tam erişim, sınırsız), DB'ye dokunulmaz.
//  - shadow  : karar hesaplanır ve loglanır, ASLA engellenmez (enforced=false).
//  - enforce : engellenir. Kohort veriyle yönetilir (LEGACY sınırsız; geçenler
//              TRIALING/ACTIVE), ayrı bir izin listesi yoktur.
//
// "Hak" kararı yalnız ödeme olaylarının yazdığı alanlardan verilir: paidThrough,
// trialEndsAt, graceUntil, legacyUntil. Sağlayıcının dönem alanları yalnız UI
// aynasıdır; ödenmemiş bir yenileme bedava pencere açmaz.

import {
  PAST_DUE_GRACE_DAYS,
  PLANS,
  RENEWAL_LAG_MS,
  TRIAL,
  isPlanKey,
  quotaFor,
  trialQuota,
  type Autonomy,
  type PlanKey,
  type Quota,
} from "./plans";
import { quotaWindowAt } from "./windows";

export type BillingMode = "off" | "shadow" | "enforce";

export type SubscriptionStatus =
  "LEGACY" | "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELED";

export type BillingConfig = {
  mode: BillingMode;
  // Bundan önce açılmış, aboneliği olmayan workspace'ler LEGACY sayılır.
  legacyBefore: Date | null;
  // LEGACY tam erişimin sonu (7 günlük ücretsiz geçişin bitişi); null = süresiz.
  legacyUntil: Date | null;
};

export const BILLING_OFF: BillingConfig = {
  mode: "off",
  legacyBefore: null,
  legacyUntil: null,
};

// Subscription satırının karar için gereken alanları.
export type SubscriptionFacts = {
  planKey: string | null;
  interval: string | null;
  status: string;
  quotaAnchor: Date | null;
  paidThrough: Date | null;
  trialEndsAt: Date | null;
  graceUntil: Date | null;
  legacyUntil: Date | null;
  cancelAtPeriodEnd: boolean;
  periodIndex: number;
  introOffer: boolean;
  pendingPlanKey: string | null;
  pendingInterval: string | null;
  pendingEffectiveAt: Date | null;
  exempt: boolean;
};

export type AccessReason =
  | "OFF"
  | "EXEMPT"
  | "LEGACY"
  | "ACTIVE"
  | "TRIAL"
  | "CANCELED_GRACE"
  | "PAST_DUE_GRACE"
  | "NO_SUBSCRIPTION"
  | "TRIAL_ENDED"
  | "LEGACY_ENDED"
  | "CANCELED"
  | "PAST_DUE_ENDED"
  // Satır tutarsız (ACTIVE/CANCELED ama plan, çapa ya da ödenmiş süre eksik; bilinmeyen
  // durum): ödeyen biri hak almadan kalmasın diye sessiz geçilmez, güvenli tarafta
  // salt-okunur ve sarmalayıcı yüksek sesle loglar.
  | "INCOMPLETE_SUBSCRIPTION"
  // Abonelik okunamadı (veritabanı hatası): enforce'ta güvenli tarafta kapalı,
  // aksi halde açık (bkz. degradedEntitlements).
  | "DEGRADED";

export type Entitlements = {
  mode: BillingMode;
  // Bu workspace için engelleme gerçekten uygulanır mı (yalnız enforce + kohort).
  enforced: boolean;
  // FULL: yeni ücretli iş, marka, otonom döngü serbest. READ_ONLY: görüntüleme,
  // dışa aktarma, silme, bağlantı kesme; yeni ücretli AI/marka yok. Gölge modda
  // READ_ONLY "engellenirdi" demektir, kimse engellenmez.
  access: "FULL" | "READ_ONLY";
  reason: AccessReason;
  // true: kota uygulanmaz ve bakiye tutulmaz (kapalı, muaf, LEGACY).
  unlimited: boolean;
  isTrial: boolean;
  // Kota kaynağı plan (deneme ve sınırsız hallerde null).
  planKey: PlanKey | null;
  autonomy: Autonomy;
  // null: sınırsız.
  brandLimit: number | null;
  // Yeni harcamanın en geç sürebileceği an; null: sınırsız.
  spendThrough: Date | null;
  // Yeni aylık kota penceresi açılabilir mi (PAST_DUE ek süresinde hayır).
  canOpenNewWindows: boolean;
  // Yeni pencere YALNIZ başlangıcı bu andan önceyse açılır: ÖDENMİŞ sürenin sonu.
  // Yenileme payı (RENEWAL_LAG) yalnız ERİŞİM toleransıdır; ödenmemiş yenileme bedava
  // pencere açmaz. null: pencere açılmaz ya da sınır yok.
  windowHorizon: Date | null;
};

function unlimitedFull(
  mode: BillingMode,
  enforced: boolean,
  reason: AccessReason,
): Entitlements {
  return {
    mode,
    enforced,
    access: "FULL",
    reason,
    unlimited: true,
    isTrial: false,
    planKey: null,
    autonomy: "full",
    brandLimit: null,
    spendThrough: null,
    canOpenNewWindows: false,
    windowHorizon: null,
  };
}

function readOnly(
  mode: BillingMode,
  enforced: boolean,
  reason: AccessReason,
  planKey: PlanKey | null = null,
): Entitlements {
  return {
    mode,
    enforced,
    access: "READ_ONLY",
    reason,
    unlimited: false,
    isTrial: false,
    planKey,
    autonomy: "limited",
    brandLimit: 0,
    spendThrough: null,
    canOpenNewWindows: false,
    windowHorizon: null,
  };
}

function planEntitlements(
  mode: BillingMode,
  enforced: boolean,
  reason: AccessReason,
  planKey: PlanKey,
  spendThrough: Date | null,
  canOpenNewWindows: boolean,
  windowHorizon: Date | null,
): Entitlements {
  const plan = PLANS[planKey];
  return {
    mode,
    enforced,
    access: "FULL",
    reason,
    unlimited: false,
    isTrial: false,
    planKey,
    autonomy: plan.autonomy,
    brandLimit: plan.brandLimit,
    spendThrough,
    canOpenNewWindows,
    windowHorizon,
  };
}

// Zamanlanmış plan ve/veya aralık değişikliği `at` anında yürürlükte mi? (Düşürme
// pencere sınırında devreye girer: pendingEffectiveAt <= pencere başı.)
function pendingApplies(sub: SubscriptionFacts, at: Date): boolean {
  return (
    (isPlanKey(sub.pendingPlanKey) || sub.pendingInterval !== null) &&
    sub.pendingEffectiveAt !== null &&
    sub.pendingEffectiveAt.getTime() <= at.getTime()
  );
}

// `at` anında geçerli plan: yürürlüğe girmiş zamanlanmış değişiklik varsa o.
function effectivePlanKey(sub: SubscriptionFacts, at: Date): PlanKey | null {
  if (isPlanKey(sub.pendingPlanKey) && pendingApplies(sub, at)) {
    return sub.pendingPlanKey;
  }
  return isPlanKey(sub.planKey) ? sub.planKey : null;
}

// Abonelik okunamayınca verilen karar. Politika: enforce'ta fail-closed (kota
// delinmesin), off/shadow'da fail-open (faturalama hatası ürünü düşürmesin).
export function degradedEntitlements(mode: BillingMode): Entitlements {
  return mode === "enforce"
    ? readOnly(mode, true, "DEGRADED")
    : unlimitedFull(mode, false, "DEGRADED");
}

export function resolveEntitlements(input: {
  // Aboneliği olmayan workspace'in LEGACY sayılması için gerekir.
  workspaceCreatedAt: Date | null;
  subscription: SubscriptionFacts | null;
  config: BillingConfig;
  now: Date;
}): Entitlements {
  const { subscription: sub, config, now } = input;
  const mode = config.mode;
  if (mode === "off") return unlimitedFull(mode, false, "OFF");

  // Kohort veriyle yönetilir: LEGACY sınırsızdır, kohort LEGACY'den TRIALING/ACTIVE'e
  // geçirilen workspace'lerdir (ayrı bir izin listesi gerekmez).
  const enforced = mode === "enforce";

  if (sub?.exempt) return unlimitedFull(mode, enforced, "EXEMPT");

  const legacy = (until: Date | null): Entitlements =>
    until && now.getTime() >= until.getTime()
      ? readOnly(mode, enforced, "LEGACY_ENDED")
      : unlimitedFull(mode, enforced, "LEGACY");

  if (!sub) {
    const isExisting =
      config.legacyBefore !== null &&
      input.workspaceCreatedAt !== null &&
      input.workspaceCreatedAt.getTime() < config.legacyBefore.getTime();
    return isExisting
      ? legacy(config.legacyUntil)
      : readOnly(mode, enforced, "NO_SUBSCRIPTION");
  }

  switch (sub.status) {
    case "LEGACY":
      return legacy(sub.legacyUntil ?? config.legacyUntil);

    case "TRIALING": {
      if (!sub.trialEndsAt || now.getTime() >= sub.trialEndsAt.getTime()) {
        return readOnly(mode, enforced, "TRIAL_ENDED");
      }
      return {
        mode,
        enforced,
        access: "FULL",
        reason: "TRIAL",
        unlimited: false,
        isTrial: true,
        planKey: isPlanKey(sub.planKey) ? sub.planKey : null,
        autonomy: TRIAL.autonomy,
        brandLimit: TRIAL.brandLimit,
        spendThrough: sub.trialEndsAt,
        // Deneme tek pencere: kota denemenin sonunda söner.
        canOpenNewWindows: false,
        windowHorizon: null,
      };
    }

    case "ACTIVE": {
      if (!isPlanKey(sub.planKey) || !sub.paidThrough || !sub.quotaAnchor) {
        return readOnly(mode, enforced, "INCOMPLETE_SUBSCRIPTION");
      }
      // İptal edilmiş (dönem sonunda biter) abonelikte yenileme payı yok.
      const spendThrough = sub.cancelAtPeriodEnd
        ? sub.paidThrough
        : new Date(sub.paidThrough.getTime() + RENEWAL_LAG_MS);
      if (now.getTime() >= spendThrough.getTime()) {
        return readOnly(
          mode,
          enforced,
          sub.cancelAtPeriodEnd ? "CANCELED" : "PAST_DUE_ENDED",
          sub.planKey,
        );
      }
      return planEntitlements(
        mode,
        enforced,
        "ACTIVE",
        effectivePlanKey(sub, now) ?? sub.planKey,
        spendThrough,
        true,
        sub.paidThrough,
      );
    }

    case "PAST_DUE": {
      if (
        !isPlanKey(sub.planKey) ||
        !sub.graceUntil ||
        now.getTime() >= sub.graceUntil.getTime()
      ) {
        return readOnly(
          mode,
          enforced,
          "PAST_DUE_ENDED",
          isPlanKey(sub.planKey) ? sub.planKey : null,
        );
      }
      // Ek süre: mevcut kalan harcanır, YENİ pencere açılmaz (bedava ay yok).
      return planEntitlements(
        mode,
        enforced,
        "PAST_DUE_GRACE",
        effectivePlanKey(sub, now) ?? sub.planKey,
        sub.graceUntil,
        false,
        null,
      );
    }

    case "CANCELED": {
      if (isPlanKey(sub.planKey) && sub.paidThrough && !sub.quotaAnchor) {
        // Ödenmiş süresi var ama pencere hiç açılamaz: sessiz geçme.
        if (now.getTime() < sub.paidThrough.getTime()) {
          return readOnly(mode, enforced, "INCOMPLETE_SUBSCRIPTION", sub.planKey);
        }
      }
      if (
        !isPlanKey(sub.planKey) ||
        !sub.paidThrough ||
        now.getTime() >= sub.paidThrough.getTime()
      ) {
        return readOnly(
          mode,
          enforced,
          "CANCELED",
          isPlanKey(sub.planKey) ? sub.planKey : null,
        );
      }
      // Ödenmiş süre bitene kadar (yıllıkta kalan aylar dahil) kullanım sürer.
      return planEntitlements(
        mode,
        enforced,
        "CANCELED_GRACE",
        effectivePlanKey(sub, now) ?? sub.planKey,
        sub.paidThrough,
        true,
        sub.paidThrough,
      );
    }

    default:
      return readOnly(mode, enforced, "INCOMPLETE_SUBSCRIPTION");
  }
}

// ---------------------------------------------------------------------------
// Aylık kota penceresi: hangi pencere, hangi plan, ne kadar kota.

export type WindowPlan = {
  start: Date;
  // Pencerenin kendi sonu (periodEnd). Ödenmiş süre sınırı buraya YAZILMAZ: harcama
  // ufku ayrıca spendThrough'dur ve erişim kararı (entitlements) tarafından uygulanır.
  end: Date;
  spendThrough: Date | null;
  quota: Quota;
  // Pencerede geçerli plan (zamanlanmış düşürme pencere sınırında uygulanmıştır).
  planKey: PlanKey | null;
  firstMonth: boolean;
  // Zamanlanmış plan/aralık değişikliği bu pencerede devreye girdi mi (kalıcı
  // yazılmalı: Subscription.planKey/interval = pending*, pending* temizlenir).
  appliesPending: boolean;
};

// Bir aboneliğin `now` için pencere planı; pencere açılmayacaksa null.
export function planWindow(input: {
  subscription: SubscriptionFacts;
  entitlements: Entitlements;
  now: Date;
}): WindowPlan | null {
  const { subscription: sub, entitlements: ent, now } = input;
  if (ent.unlimited || ent.access !== "FULL") return null;

  if (ent.isTrial) {
    if (!sub.quotaAnchor || !sub.trialEndsAt) return null;
    return {
      start: sub.quotaAnchor,
      end: sub.trialEndsAt,
      spendThrough: sub.trialEndsAt,
      quota: trialQuota(),
      planKey: null,
      firstMonth: false,
      appliesPending: false,
    };
  }

  if (!ent.canOpenNewWindows || !sub.quotaAnchor || !ent.spendThrough) {
    return null;
  }
  const window = quotaWindowAt(sub.quotaAnchor, now);
  if (!window) return null;
  // Ödenmemiş yenileme: pencere paidThrough'da bitiyorsa yenisi ödeme gelene
  // (paidThrough ilerleyene) kadar açılmaz.
  if (
    ent.windowHorizon &&
    window.start.getTime() >= ent.windowHorizon.getTime()
  ) {
    return null;
  }

  const appliesPending = pendingApplies(sub, window.start);
  const planKey = effectivePlanKey(sub, window.start);
  if (!planKey) return null;

  const firstMonth =
    window.index === 0 && sub.periodIndex === 1 && sub.introOffer;
  return {
    start: window.start,
    end: window.end,
    spendThrough: ent.spendThrough,
    quota: quotaFor(planKey, { firstMonth }),
    planKey,
    firstMonth,
    appliesPending,
  };
}

// Ödeme başarısızlığı ek süresinin bitişi (Faz 4 PAST_DUE yazarken kullanır).
export function pastDueGraceEnd(pastDueSince: Date): Date {
  return new Date(
    pastDueSince.getTime() + PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000,
  );
}

// Ödenmiş bir plan şu an SÜRÜYOR mu? Faturalama kipinden bağımsız (kapalıyken de ek paket
// alınabilir mi / ikinci abonelik açılabilir mi sorusunun cevabı); ACTIVE, PAST_DUE ve
// CANCELED kollarının erişim kurallarıyla aynıdır (yenileme payı, ek süre, ödenmiş süre).
export function paidPlanRunning(
  sub: Pick<
    SubscriptionFacts,
    "planKey" | "status" | "paidThrough" | "graceUntil" | "cancelAtPeriodEnd"
  >,
  now: Date,
): boolean {
  if (!isPlanKey(sub.planKey)) return false;
  const t = now.getTime();
  switch (sub.status) {
    case "ACTIVE": {
      if (!sub.paidThrough) return false;
      const end = sub.cancelAtPeriodEnd
        ? sub.paidThrough.getTime()
        : sub.paidThrough.getTime() + RENEWAL_LAG_MS;
      return t < end;
    }
    case "PAST_DUE":
      return sub.graceUntil !== null && t < sub.graceUntil.getTime();
    case "CANCELED":
      return sub.paidThrough !== null && t < sub.paidThrough.getTime();
    default:
      return false;
  }
}
