import "server-only";

import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";
import {
  planWindow,
  resolveEntitlements,
  type AccessReason,
} from "@/lib/billing/entitlements-core";
import {
  RESERVATION_TTL_MS,
  heldBackPct,
  isUnitSellable,
  sellableUnits,
  type UsageUnit,
} from "@/lib/billing/plans";

import { getBillingConfig } from "./config";
import { getEntitlements, toSubscriptionFacts } from "./entitlements";
import {
  ENSURE_PERIOD_SQL,
  EXPIRED_RESERVATIONS_SQL,
  GRANT_EXTRA_SQL,
  GRANT_LOOKUP_SQL,
  GRANT_PERIOD_SQL,
  LOCK_BALANCE_SQL,
  RELEASE_SQL,
  REPAIR_RESERVED_SQL,
  RESERVATION_LOOKUP_SQL,
  RESERVE_OVERDRAFT_SQL,
  RESERVE_SQL,
  REVOKE_EXTRA_SQL,
  REVOKE_PERIOD_SQL,
  SETTLE_SQL,
} from "./ledger-sql";
import { recordShadowDecision } from "./shadow-log";

// Kullanım hakkı defteri: rezerve → çalıştır → mahsup et (settle) / iade et (release).
//
// Faz 2'de HİÇBİR ücretli çağrıya bağlı değildir (o Faz 3). Varsayılan davranış
// BILLING_MODE=off: tüm girişler veritabanına dokunmadan BYPASS döner.
//
// Anahtar disiplini: reservationKey iş değil DENEME bazlıdır (`${operationId}#${deneme}`).
// Aynı denemenin yinelenen teslimi aynı satırı bulur (REUSED, çift düşüm yok);
// yeniden deneme yeni anahtar alır. reserve YALNIZ giriş noktalarında (iş, sohbet
// turu, tick adımı) çağrılır; iç içe çağrılar yalnız kaydeder (UsageEntry).
//
// Hata politikası: enforce'ta fail-closed (ERROR döner, çağıran işi durdurur);
// off/shadow'da fail-open (BYPASS, hata loglanır).

type Bigish = number | bigint;

export function assertAmount(value: Bigish, name = "amount"): bigint {
  const big =
    typeof value === "bigint"
      ? value
      : Number.isSafeInteger(value)
        ? BigInt(value)
        : null;
  if (big === null || big <= BigInt(0)) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return big;
}

// Mahsup tutarı sıfır olabilir (iş hiçbir şey tüketmedi).
function assertActual(value: Bigish): bigint {
  const big =
    typeof value === "bigint"
      ? value
      : Number.isSafeInteger(value)
        ? BigInt(value)
        : null;
  if (big === null || big < BigInt(0)) {
    throw new RangeError("actual must be a non-negative safe integer");
  }
  return big;
}

export class GrantKeyConflictError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly idempotencyKey: string,
  ) {
    super(
      `Grant key ${idempotencyKey} already used in workspace ${workspaceId} with a different pool or amount`,
    );
    this.name = "GrantKeyConflictError";
  }
}

// ---------------------------------------------------------------------------
// reserve

export type ReserveInput = {
  workspaceId: string;
  unit: UsageUnit;
  amount: Bigish;
  // `${operationId}#${deneme}`: çağıran verir.
  reservationKey: string;
  // UsageEntry satırlarıyla mutabakat için iş kimliği.
  operationId?: string;
  // Kim başlattı (Faz 3C). "system": sistemin kendi başlattığı iş; planın otonomisine
  // göre dönem hakkının bir kısmı kullanıcı için boş bırakılmak zorundadır
  // (plans.ts BACKGROUND_SHARE_PCT). Verilmezse (varsayılan) kullanıcıdır ve paya
  // takılmaz.
  initiator?: "user" | "system";
  ttlMs?: number;
  now?: Date;
};

export type ReserveResult =
  | {
      ok: true;
      kind: "RESERVED";
      reservationKey: string;
      fromPeriod: bigint;
      fromExtra: bigint;
    }
  | {
      ok: true;
      kind: "REUSED";
      reservationKey: string;
      status: "RESERVED" | "SETTLED" | "RELEASED";
      // Aynı anahtar başka bir tutarla kullanılmış (çağıran hatası).
      amountMismatch: boolean;
    }
  | { ok: true; kind: "OVERDRAFT_SHADOW"; reservationKey: string }
  | {
      ok: true;
      kind: "BYPASS";
      reason:
        | "OFF"
        | "UNLIMITED"
        | "SHADOW_NOT_ENTITLED"
        | "SHADOW_UNIT_NOT_SOLD"
        | "SHADOW_NO_BALANCE"
        | "ERROR_OPEN";
    }
  | {
      ok: false;
      reason: "INSUFFICIENT";
      available: bigint;
      // Dönem havuzunun yenileneceği an (bilinmiyorsa null).
      resetsAt: Date | null;
      // Hak bitmedi: sistemin işi kullanıcıya ayrılan payı aşacağı için reddedildi
      // (kullanıcının aynı işi sığardı). Park edilen iş buna göre anlatılır.
      heldBack: boolean;
      // Ücretsiz deneme: pencere "yenilenmez", deneme sonunda biter (müşteriye "yenilenir"
      // denmez, plan seçmesi söylenir).
      trial?: boolean;
    }
  | { ok: false; reason: "NOT_ENTITLED"; entitlement: AccessReason }
  | { ok: false; reason: "UNIT_NOT_SOLD" }
  | { ok: false; reason: "ERROR" };

type ReserveRow = {
  balanceRows: number;
  sufficient: number;
  inserted: number;
  fromPeriod: bigint | null;
  fromExtra: bigint | null;
  periodEnd: Date | null;
  available: bigint | null;
  held: bigint | null;
};

type ReservationRow = {
  status: "RESERVED" | "SETTLED" | "RELEASED";
  amount: bigint;
  settledAmount: bigint | null;
  overdraft: boolean;
};

async function lookupReservation(
  workspaceId: string,
  unit: UsageUnit,
  reservationKey: string,
): Promise<ReservationRow | null> {
  const rows = await prisma.$queryRawUnsafe<ReservationRow[]>(
    RESERVATION_LOOKUP_SQL,
    workspaceId,
    unit,
    reservationKey,
  );
  return rows[0] ?? null;
}

export async function reserveUsage(
  input: ReserveInput,
): Promise<ReserveResult> {
  const now = input.now ?? new Date();
  const config = getBillingConfig();
  // off: doğrulama dahil HİÇBİR şey yapılmaz (varsayılan-kapalı ilkesi): hatalı bir
  // tahmin (0, tamsayı olmayan) kapalıyken ücretli çağrıyı düşüremez.
  if (config.mode === "off") {
    return { ok: true, kind: "BYPASS", reason: "OFF" };
  }
  const enforced = config.mode === "enforce";

  try {
    // Hatalı tutar programcı hatasıdır ama ücretli çağrının önünde FIRLATMAZ:
    // enforce'ta ERROR (iş durur), shadow'da BYPASS (loglanır).
    const amount = assertAmount(input.amount);
    const entitlements = await getEntitlements(input.workspaceId, { now });
    if (entitlements.reason === "DEGRADED") {
      return enforced
        ? { ok: false, reason: "ERROR" }
        : { ok: true, kind: "BYPASS", reason: "ERROR_OPEN" };
    }
    if (entitlements.unlimited) {
      return { ok: true, kind: "BYPASS", reason: "UNLIMITED" };
    }
    if (entitlements.access === "READ_ONLY") {
      if (enforced) {
        return {
          ok: false,
          reason: "NOT_ENTITLED",
          entitlement: entitlements.reason,
        };
      }
      await recordShadowDecision({
        workspaceId: input.workspaceId,
        kind: "not_entitled",
        detail: { unit: input.unit, reason: entitlements.reason },
        now,
      });
      return { ok: true, kind: "BYPASS", reason: "SHADOW_NOT_ENTITLED" };
    }
    if (!isUnitSellable(input.unit)) {
      if (enforced) return { ok: false, reason: "UNIT_NOT_SOLD" };
      await recordShadowDecision({
        workspaceId: input.workspaceId,
        kind: "unit_not_sold",
        detail: { unit: input.unit },
        now,
      });
      return { ok: true, kind: "BYPASS", reason: "SHADOW_UNIT_NOT_SOLD" };
    }

    const expiresAt = new Date(
      now.getTime() + (input.ttlMs ?? RESERVATION_TTL_MS),
    );
    // Sistemin kendi başlattığı iş, kullanıcının payına dokunamaz.
    const heldPct =
      input.initiator === "system" ? heldBackPct(entitlements.autonomy) : 0;
    const tryReserve = async (): Promise<ReserveRow> => {
      const rows = await prisma.$queryRawUnsafe<ReserveRow[]>(
        RESERVE_SQL,
        input.workspaceId,
        input.unit,
        amount,
        randomUUID(),
        input.reservationKey,
        input.operationId ?? null,
        expiresAt,
        now,
        heldPct,
      );
      return rows[0]!;
    };

    let row = await tryReserve();
    if (row.inserted === 0) {
      // Yinelenen teslim, bakiye tam sınırdayken bile "yetersiz" sayılmamalı.
      const existing = await lookupReservation(
        input.workspaceId,
        input.unit,
        input.reservationKey,
      );
      if (existing) {
        return {
          ok: true,
          kind: "REUSED",
          reservationKey: input.reservationKey,
          status: existing.status,
          amountMismatch: existing.amount !== amount,
        };
      }
      // Bakiye satırı yok ya da pencere sönmüş: pencereyi aç, bir kez daha dene.
      const stale =
        row.balanceRows === 0 ||
        row.periodEnd === null ||
        row.periodEnd.getTime() <= now.getTime();
      if (stale) {
        // changed olmasa da yeniden dene: pencereyi eşzamanlı başka bir çağrı açmış
        // olabilir (bu çağrının ensurePeriod'u "zaten güncel" görür).
        await ensurePeriod(input.workspaceId, { now });
        row = await tryReserve();
      }
    }

    if (row.inserted === 1) {
      return {
        ok: true,
        kind: "RESERVED",
        reservationKey: input.reservationKey,
        fromPeriod: row.fromPeriod ?? BigInt(0),
        fromExtra: row.fromExtra ?? BigInt(0),
      };
    }

    // Aynı anahtarla eşzamanlı ikinci teslim araya girmiş olabilir.
    const raced = await lookupReservation(
      input.workspaceId,
      input.unit,
      input.reservationKey,
    );
    if (raced) {
      return {
        ok: true,
        kind: "REUSED",
        reservationKey: input.reservationKey,
        status: raced.status,
        amountMismatch: raced.amount !== amount,
      };
    }

    // Gerçekten yetersiz (ya da bakiye hiç yok).
    const available = row.available ?? BigInt(0);
    const heldBack =
      heldPct > 0 && (row.held ?? BigInt(0)) > BigInt(0) && available >= amount;
    if (enforced) {
      return {
        ok: false,
        reason: "INSUFFICIENT",
        available,
        resetsAt:
          row.periodEnd && row.periodEnd.getTime() > now.getTime()
            ? row.periodEnd
            : null,
        heldBack,
        ...(entitlements.isTrial ? { trial: true } : {}),
      };
    }
    // Başlatıcı ve ayrılan pay kayıtta durur: sistemin pay darlığı, kullanıcının gerçek
    // yetersizliğinin saatlik satırını almasın ve ikisi ayırt edilebilsin.
    await recordShadowDecision({
      workspaceId: input.workspaceId,
      kind: "insufficient",
      initiator: input.initiator ?? "user",
      detail: {
        unit: input.unit,
        amount: amount.toString(),
        initiator: input.initiator ?? "user",
        available: available.toString(),
        held: (row.held ?? BigInt(0)).toString(),
        heldBack,
      },
      now,
    });
    if (row.balanceRows === 0) {
      return { ok: true, kind: "BYPASS", reason: "SHADOW_NO_BALANCE" };
    }
    await prisma.$queryRawUnsafe(
      RESERVE_OVERDRAFT_SQL,
      randomUUID(),
      input.workspaceId,
      input.unit,
      input.reservationKey,
      input.operationId ?? null,
      amount,
      expiresAt,
      now,
    );
    return {
      ok: true,
      kind: "OVERDRAFT_SHADOW",
      reservationKey: input.reservationKey,
    };
  } catch (error) {
    console.error(
      "[billing] reserve failed:",
      error instanceof Error ? error.name : error,
    );
    return enforced
      ? { ok: false, reason: "ERROR" }
      : { ok: true, kind: "BYPASS", reason: "ERROR_OPEN" };
  }
}

// ---------------------------------------------------------------------------
// settle / release (bilinmeyen anahtar FIRLATMAZ: Faz 3 çağıranları koşulsuz çağırır)

export type ReservationRef = {
  workspaceId: string;
  unit: UsageUnit;
  reservationKey: string;
  now?: Date;
};

export type SettleResult =
  | {
      status: "SETTLED";
      chargedPeriod: bigint;
      chargedExtra: bigint;
      // İki havuzda da karşılanamayıp dönem havuzuna borç yazılan kısım.
      overrun: bigint;
    }
  | { status: "ALREADY_SETTLED"; settledAmount: bigint | null }
  | { status: "NOT_FOUND" }
  // Altyapı hatası ya da geçersiz tutar: ücretli çağrı bittikten sonra çağıranın
  // işini DÜŞÜRMEZ (loglanır); süpürücü rezervasyonu zamanla iade eder.
  | { status: "ERROR" };

export async function settleUsage(
  ref: ReservationRef,
  actual: Bigish,
): Promise<SettleResult> {
  // off: veritabanına hiç dokunulmaz (kapalıyken rezervasyon da yazılmaz).
  if (getBillingConfig().mode === "off") return { status: "NOT_FOUND" };
  try {
    return await settleUsageUnchecked(ref, actual);
  } catch (error) {
    console.error(
      "[billing] settle failed:",
      error instanceof Error ? error.name : error,
    );
    return { status: "ERROR" };
  }
}

async function settleUsageUnchecked(
  ref: ReservationRef,
  actual: Bigish,
): Promise<SettleResult> {
  const amount = assertActual(actual);
  const rows = await prisma.$queryRawUnsafe<
    Array<{ chargedPeriod: bigint; chargedExtra: bigint; overrun: bigint }>
  >(
    SETTLE_SQL,
    ref.workspaceId,
    ref.unit,
    ref.reservationKey,
    amount,
    ref.now ?? new Date(),
  );
  const row = rows[0];
  if (row) {
    return {
      status: "SETTLED",
      chargedPeriod: row.chargedPeriod,
      chargedExtra: row.chargedExtra,
      overrun: row.overrun,
    };
  }
  const existing = await lookupReservation(
    ref.workspaceId,
    ref.unit,
    ref.reservationKey,
  );
  if (!existing) return { status: "NOT_FOUND" };
  if (existing.status === "SETTLED") {
    return { status: "ALREADY_SETTLED", settledAmount: existing.settledAmount };
  }
  // RESERVED/RELEASED ama güncellenemedi: bakiye satırı kayıp (tutarsız defter).
  throw new Error(
    `Usage ledger inconsistent: balance row missing for ${ref.workspaceId}/${ref.unit}`,
  );
}

export type ReleaseResult =
  | { status: "RELEASED"; releasedPeriod: bigint; releasedExtra: bigint }
  | { status: "NOT_RESERVED"; current: "SETTLED" | "RELEASED" }
  | { status: "NOT_FOUND" }
  | { status: "ERROR" };

export async function releaseUsage(
  ref: ReservationRef,
): Promise<ReleaseResult> {
  if (getBillingConfig().mode === "off") return { status: "NOT_FOUND" };
  try {
    return await releaseUsageUnchecked(ref);
  } catch (error) {
    console.error(
      "[billing] release failed:",
      error instanceof Error ? error.name : error,
    );
    return { status: "ERROR" };
  }
}

async function releaseUsageUnchecked(
  ref: ReservationRef,
): Promise<ReleaseResult> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ releasedPeriod: bigint; releasedExtra: bigint }>
  >(
    RELEASE_SQL,
    ref.workspaceId,
    ref.unit,
    ref.reservationKey,
    ref.now ?? new Date(),
  );
  const row = rows[0];
  if (row) {
    return {
      status: "RELEASED",
      releasedPeriod: row.releasedPeriod,
      releasedExtra: row.releasedExtra,
    };
  }
  const existing = await lookupReservation(
    ref.workspaceId,
    ref.unit,
    ref.reservationKey,
  );
  if (!existing) return { status: "NOT_FOUND" };
  if (existing.status === "RESERVED") {
    throw new Error(
      `Usage ledger inconsistent: balance row missing for ${ref.workspaceId}/${ref.unit}`,
    );
  }
  return { status: "NOT_RESERVED", current: existing.status };
}

// ---------------------------------------------------------------------------
// grant (satın alma, süreli promosyon): idempotent, kayıp yok

export type GrantReason =
  | "PLAN"
  | "PLAN_CHANGE"
  | "TRIAL"
  | "BONUS"
  | "REFERRAL"
  | "PURCHASE"
  | "ADJUST";

// Ham SQL çalıştırabilen istemci: `prisma` ya da bir işlem içindeki `tx`. Ödeme
// işleyicisi abonelik satırını ve hibeyi AYNI işlemde yazabilsin diye hibe/geri alma
// bir istemci kabul eder (varsayılan: prisma).
export type LedgerClient = Pick<typeof prisma, "$queryRawUnsafe">;

export type GrantInput = {
  workspaceId: string;
  unit: UsageUnit;
  // EXTRA: süresiz (satın alma). PERIOD: yalnız açık pencereye, pencereyle söner.
  pool: "EXTRA" | "PERIOD";
  amount: Bigish;
  reason: GrantReason;
  // Kaynak olayın kimliği (ör. fatura/olay id). (workspace, anahtar, birim, neden) tekildir.
  idempotencyKey: string;
  // pool=PERIOD için çağıranın bildiği açık pencerenin başlangıcı.
  periodStart?: Date;
  now?: Date;
};

export type GrantResult =
  | { applied: true }
  | { applied: false; duplicate: true }
  | { applied: false; windowClosed: true };

export async function grantUsage(
  input: GrantInput,
  client: LedgerClient = prisma,
): Promise<GrantResult> {
  const amount = assertAmount(input.amount);
  const now = input.now ?? new Date();
  let rows: unknown[];
  if (input.pool === "EXTRA") {
    rows = await client.$queryRawUnsafe(
      GRANT_EXTRA_SQL,
      randomUUID(),
      input.workspaceId,
      input.unit,
      amount,
      input.reason,
      input.idempotencyKey,
      now,
      randomUUID(),
    );
  } else {
    if (!input.periodStart) {
      throw new RangeError("periodStart is required for a PERIOD grant");
    }
    rows = await client.$queryRawUnsafe(
      GRANT_PERIOD_SQL,
      randomUUID(),
      input.workspaceId,
      input.unit,
      amount,
      input.reason,
      input.idempotencyKey,
      now,
      input.periodStart,
    );
  }
  if (rows.length > 0) return { applied: true };

  const existing = await client.$queryRawUnsafe<
    Array<{ pool: string; amount: bigint }>
  >(
    GRANT_LOOKUP_SQL,
    input.workspaceId,
    input.unit,
    input.idempotencyKey,
    input.reason,
  );
  const row = existing[0];
  if (row) {
    if (row.pool !== input.pool || row.amount !== amount) {
      throw new GrantKeyConflictError(input.workspaceId, input.idempotencyKey);
    }
    return { applied: false, duplicate: true };
  }
  return { applied: false, windowClosed: true };
}

// ---------------------------------------------------------------------------
// revoke (iade, chargeback): işaretli ters kayıt, taban used + reserved

export type RevokeInput = {
  workspaceId: string;
  unit: UsageUnit;
  pool: "EXTRA" | "PERIOD";
  // Geri alınmak istenen azami miktar; "ALL_UNUSED": havuzda kalan kullanılmamış her şey.
  amount: Bigish | "ALL_UNUSED";
  // Ters kaydın anahtarı (iade/ödeme kimliğinden türer): aynı anahtar ikinci kez düşmez.
  idempotencyKey: string;
  // Tersi alınan hibenin kimliği (biliniyorsa; toplam iade takibi için).
  reverses?: string;
  // pool=PERIOD için çağıranın bildiği açık pencerenin başlangıcı.
  periodStart?: Date;
  now?: Date;
};

export type RevokeResult =
  // revoked: gerçekten düşülen miktar (taban yüzünden istenenden az olabilir).
  { revoked: bigint } | { revoked: bigint; duplicate: true };

const MAX_INT8 = BigInt("9223372036854775807");

export async function revokeUsage(
  input: RevokeInput,
  client: LedgerClient = prisma,
): Promise<RevokeResult> {
  const requested =
    input.amount === "ALL_UNUSED" ? MAX_INT8 : assertAmount(input.amount);
  const now = input.now ?? new Date();
  const base = [
    randomUUID(),
    input.workspaceId,
    input.unit,
    requested,
    input.idempotencyKey,
    input.reverses ?? null,
    now,
  ] as const;
  let rows: Array<{ revoked: bigint }>;
  if (input.pool === "EXTRA") {
    rows = await client.$queryRawUnsafe(REVOKE_EXTRA_SQL, ...base);
  } else {
    if (!input.periodStart) {
      throw new RangeError("periodStart is required for a PERIOD revoke");
    }
    rows = await client.$queryRawUnsafe(
      REVOKE_PERIOD_SQL,
      ...base,
      input.periodStart,
    );
  }
  if (rows.length > 0) return { revoked: rows[0]!.revoked };

  // 0 satır: tekrarlı anahtar mı, yoksa alınacak boşluk mu yok?
  const existing = await client.$queryRawUnsafe<
    Array<{ pool: string; amount: bigint }>
  >(
    GRANT_LOOKUP_SQL,
    input.workspaceId,
    input.unit,
    input.idempotencyKey,
    "REFUND",
  );
  const row = existing[0];
  if (row) return { revoked: -row.amount, duplicate: true };
  return { revoked: BigInt(0) };
}

// ---------------------------------------------------------------------------
// ensurePeriod: abonelik penceresini bakiyeye yansıt

export async function ensurePeriod(
  workspaceId: string,
  options: { now?: Date } = {},
): Promise<{ changed: boolean }> {
  const now = options.now ?? new Date();
  const config = getBillingConfig();
  if (config.mode === "off") return { changed: false };

  return prisma.$transaction(
    async (tx) => {
      // Aynı workspace'in webhook işleyicisi/başka çağrıları ile sıralanır; abonelik
      // KİLİT İÇİNDE okunur (kayıp güncelleme yok).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`usage:${workspaceId}`}, 0))`;
      const row = await tx.subscription.findUnique({ where: { workspaceId } });
      if (!row) return { changed: false };

      const facts = toSubscriptionFacts(row);
      const entitlements = resolveEntitlements({
        workspaceCreatedAt: null,
        subscription: facts,
        config,
        now,
      });
      const plan = planWindow({ subscription: facts, entitlements, now });
      if (!plan) return { changed: false };

      if (plan.appliesPending) {
        // Zamanlanmış düşürme/aralık değişimi pencere sınırında devreye girdi.
        await tx.subscription.update({
          where: { workspaceId },
          data: {
            // Yalnız aralık değişiyorsa plan korunur (pendingPlanKey boş olabilir).
            planKey: row.pendingPlanKey ?? row.planKey,
            interval: row.pendingInterval ?? row.interval,
            pendingPlanKey: null,
            pendingInterval: null,
            pendingEffectiveAt: null,
          },
        });
      }

      const reason = entitlements.isTrial ? "TRIAL" : "PLAN";
      let changed = false;
      for (const unit of sellableUnits()) {
        const quota = plan.quota[unit];
        if (quota <= 0) continue;
        // Önce (ayrı ifadeyle) bakiye satırını tut: sıfırlama ifadesindeki
        // rezervasyon toplamı eşzamanlı bir reserve/settle'ı kaçırmasın.
        await tx.$queryRawUnsafe(LOCK_BALANCE_SQL, workspaceId, unit);
        const written = await tx.$queryRawUnsafe<unknown[]>(
          ENSURE_PERIOD_SQL,
          workspaceId,
          unit,
          randomUUID(),
          plan.start,
          plan.end,
          BigInt(quota),
          now,
          randomUUID(),
          reason,
        );
        if (written.length > 0) changed = true;
      }
      return { changed };
    },
    { maxWait: 10_000, timeout: 20_000 },
  );
}

// ---------------------------------------------------------------------------
// süpürücü ve onarım

// Süresi dolmuş (çökmüş işin tuttuğu) rezervasyonları iade eder; geç gelen
// settle'a RELEASED'dan izin verilir (gerçek maliyet yine used'a yazılır).
export async function reapExpiredReservations(
  options: { now?: Date; limit?: number } = {},
): Promise<{ released: number; repaired: number }> {
  const now = options.now ?? new Date();
  const rows = await prisma.$queryRawUnsafe<
    Array<{ workspaceId: string; unit: UsageUnit; reservationKey: string }>
  >(EXPIRED_RESERVATIONS_SQL, now, options.limit ?? 100);

  let released = 0;
  const touched = new Map<string, { workspaceId: string; unit: UsageUnit }>();
  for (const row of rows) {
    // Başarılı da başarısız da olsa onarım için işaretle (sapma varsa düzelsin).
    touched.set(`${row.workspaceId}:${row.unit}`, {
      workspaceId: row.workspaceId,
      unit: row.unit,
    });
    const result = await releaseUsage({ ...row, now });
    if (result.status === "RELEASED") {
      released += 1;
    } else if (result.status === "ERROR") {
      // Zehirli satır her tick'te kuyruğun başına gelip sonrakileri aç bırakmasın:
      // son kullanma tarihini bir saat ileri al (en iyi çaba).
      await postponeReservation(row, now).catch(() => undefined);
    }
  }

  let repaired = 0;
  for (const { workspaceId, unit } of touched.values()) {
    repaired += await repairReservedCounters(workspaceId, unit, now);
  }
  return { released, repaired };
}

async function postponeReservation(
  row: { workspaceId: string; unit: UsageUnit; reservationKey: string },
  now: Date,
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "UsageReservation"
        SET "expiresAt" = ($4::timestamptz AT TIME ZONE 'UTC') + interval '1 hour'
      WHERE "workspaceId" = $1::text AND "unit" = $2::text
        AND "reservationKey" = $3::text AND "status" = 'RESERVED'`,
    row.workspaceId,
    row.unit,
    row.reservationKey,
    now,
  );
}

// Sayaç = RESERVED satırların toplamı olmalı; sapma varsa (elle müdahale/hata)
// onarır ve loglar. Önce bakiye satırı kilitlenir, SONRA toplam hesaplanır.
export async function repairReservedCounters(
  workspaceId: string,
  unit: UsageUnit,
  now: Date = new Date(),
): Promise<number> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(LOCK_BALANCE_SQL, workspaceId, unit);
      const rows = await tx.$queryRawUnsafe<unknown[]>(
        REPAIR_RESERVED_SQL,
        workspaceId,
        unit,
        now,
      );
      if (rows.length > 0) {
        console.error(
          `[billing] reserved counter drift repaired for ${workspaceId}/${unit}`,
        );
      }
      return rows.length;
    },
    { maxWait: 10_000, timeout: 20_000 },
  );
}

// ---------------------------------------------------------------------------
// görünüm (kullanıcıya/UI'ya): BigInt asla dışarı sızmaz

export type UsageUnitView = {
  unit: UsageUnit;
  period: {
    granted: number;
    used: number;
    reserved: number;
    available: number;
    endsAt: string | null;
  };
  extra: { granted: number; used: number; reserved: number; available: number };
  // Şu an harcanabilir toplam.
  available: number;
};

type BalanceRow = {
  unit: string;
  periodEnd: Date | null;
  periodGranted: bigint;
  periodUsed: bigint;
  periodReserved: bigint;
  extraGranted: bigint;
  extraUsed: bigint;
  extraReserved: bigint;
};

const toNumber = (value: bigint) =>
  value > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(value);
const nonNegative = (value: bigint) => (value < BigInt(0) ? BigInt(0) : value);

export function toUsageView(row: BalanceRow, now: Date): UsageUnitView {
  const periodOpen =
    row.periodEnd !== null && row.periodEnd.getTime() > now.getTime();
  const periodAvailable = periodOpen
    ? nonNegative(row.periodGranted - row.periodUsed - row.periodReserved)
    : BigInt(0);
  const extraAvailable = nonNegative(
    row.extraGranted - row.extraUsed - row.extraReserved,
  );
  return {
    unit: row.unit as UsageUnit,
    period: {
      granted: toNumber(row.periodGranted),
      used: toNumber(row.periodUsed),
      reserved: toNumber(row.periodReserved),
      available: toNumber(periodAvailable),
      endsAt: row.periodEnd ? row.periodEnd.toISOString() : null,
    },
    extra: {
      granted: toNumber(row.extraGranted),
      used: toNumber(row.extraUsed),
      reserved: toNumber(row.extraReserved),
      available: toNumber(extraAvailable),
    },
    available: toNumber(periodAvailable + extraAvailable),
  };
}

export async function getUsageView(
  workspaceId: string,
  options: { now?: Date } = {},
): Promise<UsageUnitView[]> {
  const now = options.now ?? new Date();
  // off: faturalama görünmezdir, veritabanına dokunulmaz.
  if (getBillingConfig().mode === "off") return [];
  const rows = await prisma.usageBalance.findMany({ where: { workspaceId } });
  return rows
    .filter((row) => isUnitSellable(row.unit as UsageUnit))
    .map((row) => toUsageView(row, now));
}
