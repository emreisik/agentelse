import "server-only";

import { prisma } from "@/lib/prisma";
import type { UsageUnit } from "@/lib/billing/plans";
import { AgentelseError } from "@/server/security/errors";

import { getBillingConfig } from "./config";
import { getEntitlements } from "./entitlements";
import { releaseUsage, reserveUsage, settleUsage } from "./ledger";
import { NoPlanError, QuotaExceededError } from "./quota-errors";
import { recordShadowDecision } from "./shadow-log";
import {
  getUsageScope,
  runWithUsageScope,
  type UsageModule,
  type UsageScope,
} from "./usage-context";
import { UsageMeter } from "./usage-meter";

// Ücretli bir operasyonun (worker işi, sohbet turu, tek bir motor çağrısı)
// yaşam döngüsü: REZERVE → ÇALIŞ → MAHSUP/İADE (docs/billing-tasks.md).
//
//   const op = await beginOperation(spec);   // yetmezse QuotaExceededError / NoPlanError
//   let outcome: OperationOutcome = "aborted";
//   try { result = await op.run(() => ...paid calls...); outcome = "delivered"; return result }
//   finally { await op.finish(outcome) }       // try BEGINOPERATION'DAN HEMEN SONRA başlar
//
// Rezervasyon YALNIZ giriş noktalarında yapılır; operasyonun içindeki ücretli
// çağrılar yalnız ölçülür (UsageMeter + UsageEntry). `runMetered` bu kuralı
// uygular: kapsamda AYNI workspace'in rezervasyonlu bir operasyonu varsa içteki
// çağrı onun parçasıdır.
//
// Mod davranışı (docs/billing-quota.md): off → hiçbir şey (veritabanına dokunmaz,
// yalnız sayaç döner); shadow → hiçbir şey engellenmez; enforce → engeller,
// defter okunamazsa fail-closed (BILLING_UNAVAILABLE, geçici hata).
//
// finish() ASLA fırlatmaz ve idempotenttir: ücretli iş bitmiştir, bir defter
// hatası çağıranın sonucunu bozmamalı.

// Bir operasyonun sonucu mahsubu belirler:
//  - delivered: sonuç müşteriye teslim edildi. Ölçülen gerçek kullanım mahsup edilir
//    (görsel: çizilen adet, rezervasyonu aşmamak üzere; AI: ölçülen maliyet).
//  - failed:    iş koştu ve başarısız oldu. İade edilir; ama AI sınıfında sağlayıcı
//    faturalı bir çağrı yapmışsa (ör. boş yanıt için ikiye katlanan token zinciri)
//    en çok rezervasyon kadar mahsup edilir: başarısızlık bedava hesaplama kapısı
//    olmasın.
//  - aborted:   hiç koşmadı ya da sonucu belirsiz (istisna). Tam iade: teslim
//    edilmemiş çıktıya ücret yazılmaz; yeniden deneme teslim ettiğinde öder.
//  - pending:   sonuç henüz belli değil. Rezervasyon açık kalır; teslim edilmişse
//    uzlaştırıcı (reconcile.ts), değilse süpürücü kapatır.
export type OperationOutcome = "delivered" | "failed" | "aborted" | "pending";

export type OperationReserve = { IMAGE?: number; AI_MICROS?: bigint };

export type OperationSpec = {
  workspaceId: string;
  projectId?: string;
  userId?: string;
  module?: UsageModule;
  source?: string;
  purpose?: string;
  // Mantıksal işin kimliği (ör. `exec:${jobId}`); UsageEntry ile mutabakat anahtarı.
  operationId: string;
  // Bu DENEMEYE özgü ve yeniden teslimde SABİT kalan jeton (worker: olay kimliği +
  // deneme sırası). Aynı jeton = aynı rezervasyon (çift düşüm yok); yeni deneme =
  // yeni jeton. Rezervasyon anahtarı `${operationId}#${attemptToken}`.
  attemptToken: string;
  reserve: OperationReserve;
  // Rezervasyonu olmayan işte de planın geçerli olması gerekir mi (uyarlama,
  // fotoğraflı gönderi: hak yemez ama READ_ONLY çalışma alanında koşmamalı).
  // OPT-IN: yayın/reklam yazması gibi ücretsiz işler plan sorgusu yapmaz.
  requireAccess?: boolean;
  // Operasyon başına azami maliyet (mikro-USD). Sayaca iletilir.
  ceilingMicros?: bigint;
  ttlMs?: number;
  now?: Date;
};

type Held = {
  unit: UsageUnit;
  reservationKey: string;
  amount: bigint;
  // Bu çağrı rezervasyonu OLUŞTURDU (RESERVED). Yeniden teslimde devralınan
  // (REUSED) rezervasyon başkasının/önceki denemenin olabilir: claim kaybedip
  // vazgeçen çağrı onu iade ETMEMELİ (kazananın koruması düşer).
  owned: boolean;
};

const UNITS = ["IMAGE", "AI_MICROS"] as const;

// Anahtar zaten SETTLED/RELEASED ise (aynı jetonla ikinci koşu) yeni bir koşudur:
// taze anahtarla yeniden rezerve edilir, bedava çalışmaz.
const MAX_KEY_REROLLS = 3;

// Defter hatasında mahsup/iade bu kadar denenir (sonuç ERROR ise).
const LEDGER_ATTEMPTS = 3;

// Görsel çizilmeden tamamlanan içerik işinde (ör. görsel moderasyona takıldı, metin
// tamam) ödenmiş metin çalışması AI bütçesine yazılır; üst sınır bir gönderinin
// metin adımının makul payıdır. En iyi çaba: bütçe yoksa yazılmaz.
const TEXT_ONLY_CHARGE_CAP_MICROS = BigInt(100_000);

function ledgerUnavailable(): AgentelseError {
  return new AgentelseError(
    "BILLING_UNAVAILABLE",
    "Usage ledger is temporarily unavailable",
    { retryable: true },
  );
}

export class Operation {
  readonly meter: UsageMeter;
  readonly operationId: string;

  private readonly spec: OperationSpec;
  private readonly held: Held[];
  private finishing: Promise<void> | undefined;

  constructor(spec: OperationSpec, held: Held[]) {
    this.spec = spec;
    this.operationId = spec.operationId;
    this.held = held;
    this.meter = new UsageMeter({
      workspaceId: spec.workspaceId,
      operationId: spec.operationId,
      ceilingMicros: spec.ceilingMicros,
    });
    // İçteki motor çağrıları yalnız rezervasyonlu operasyona katılır.
    this.meter.covered = held.length > 0;
  }

  // Kapsam alanları (sohbet gibi AsyncLocalStorage'ı güvenilir taşımayan akışlar
  // bunu açık `scope` olarak kayıt çağrısına verir).
  scope(): UsageScope {
    return {
      workspaceId: this.spec.workspaceId,
      projectId: this.spec.projectId,
      userId: this.spec.userId,
      module: this.spec.module,
      source: this.spec.source,
      purpose: this.spec.purpose,
      operationId: this.spec.operationId,
      meter: this.meter,
    };
  }

  // Ücretli çağrıları bu operasyonun kapsamında çalıştırır.
  run<T>(fn: () => T): T {
    return runWithUsageScope(this.scope(), fn);
  }

  get holdsReservation(): boolean {
    return this.held.length > 0;
  }

  // İş başlamadan vazgeçildi (ör. claim başkasına gitti): YALNIZ bu çağrının
  // oluşturduğu rezervasyonlar iade edilir; devralınan, kazananındır.
  async abandon(): Promise<void> {
    this.finishing ??= this.settleAll("aborted", true);
    await this.finishing;
  }

  async finish(outcome: OperationOutcome): Promise<void> {
    this.finishing ??= this.settleAll(outcome, false);
    await this.finishing;
  }

  private async settleAll(
    outcome: OperationOutcome,
    ownedOnly: boolean,
  ): Promise<void> {
    try {
      if (outcome === "pending") return;
      for (const held of this.held) {
        if (ownedOnly && !held.owned) continue;
        await this.settleHeld(held, outcome);
      }
      if (!ownedOnly) await this.afterSettle(outcome);
    } catch (error) {
      // Defter fonksiyonları fırlatmaz; yine de iş sonucunu bozmayız.
      console.error(
        "[billing] operation finish failed:",
        error instanceof Error ? error.name : error,
      );
    } finally {
      // Bundan sonra gelen ücretli çağrılar (yarış kaybedenler) mahsup edilmiş
      // sonuca karışmaz; sayaç bunları "geç harcama" diye ayrı sayar.
      if (outcome !== "pending") this.meter.close();
    }
  }

  private async settleHeld(held: Held, outcome: OperationOutcome) {
    const ref = {
      workspaceId: this.spec.workspaceId,
      unit: held.unit,
      reservationKey: held.reservationKey,
    };
    const actual = this.chargeFor(held, outcome);
    for (let attempt = 0; attempt < LEDGER_ATTEMPTS; attempt += 1) {
      const result =
        actual === null
          ? await releaseUsage(ref)
          : await settleUsage(ref, actual);
      if (result.status !== "ERROR") return;
    }
  }

  // Bu rezervasyondan düşülecek miktar; null = tamamen iade.
  private chargeFor(held: Held, outcome: OperationOutcome): bigint | null {
    if (outcome === "aborted") return null;
    if (held.unit === "IMAGE") {
      // Çizilen görsel sayısı, rezerve edileni AŞMAZ: aynı gönderi için tekrarlanan
      // başarılı çizim kayıtları (yeniden render, fal yedeği) iki hak yedirmez.
      if (outcome !== "delivered") return null;
      const drawn = BigInt(this.meter.images);
      return drawn < held.amount ? drawn : held.amount;
    }
    const cost = this.meter.costMicros;
    if (outcome === "delivered") return cost;
    // failed: sağlayıcı faturalı çağrı yaptıysa rezervasyon kadarına kadar öder.
    if (cost <= BigInt(0)) return null;
    return cost < held.amount ? cost : held.amount;
  }

  private async afterSettle(outcome: OperationOutcome): Promise<void> {
    const imageHeld = this.held.some((held) => held.unit === "IMAGE");
    if (
      outcome === "delivered" &&
      imageHeld &&
      this.meter.images === 0 &&
      this.meter.costMicros > BigInt(0)
    ) {
      await this.chargeTextOnly();
    }
    if (
      this.held.length === 0 &&
      this.spec.requireAccess !== true &&
      getBillingConfig().mode !== "off" &&
      this.meter.costMicros > BigInt(0)
    ) {
      // Yeni bir ücretli sağlayıcı usageEstimate beyan etmeyi unutursa sessizce
      // bedava olmasın: ücretsiz sınıfta maliyet çıkarsa görünür kıl.
      console.warn(
        `[billing] ${this.meter.costMicros} micro-USD of paid calls inside a free operation (${this.spec.operationId}): the provider needs a usageEstimate`,
      );
    }
  }

  // Görselsiz tamamlanan içerik işinin metin çalışması AI bütçesinden (en iyi çaba).
  private async chargeTextOnly(): Promise<void> {
    const cost = this.meter.costMicros;
    const amount =
      cost < TEXT_ONLY_CHARGE_CAP_MICROS ? cost : TEXT_ONLY_CHARGE_CAP_MICROS;
    const reservationKey = `${this.spec.operationId}#${this.spec.attemptToken}~text`;
    const reserved = await reserveUsage({
      workspaceId: this.spec.workspaceId,
      unit: "AI_MICROS",
      amount,
      reservationKey,
      operationId: this.spec.operationId,
      ttlMs: this.spec.ttlMs,
    });
    if (
      reserved.ok &&
      (reserved.kind === "RESERVED" || reserved.kind === "OVERDRAFT_SHADOW")
    ) {
      await settleUsage(
        {
          workspaceId: this.spec.workspaceId,
          unit: "AI_MICROS",
          reservationKey,
        },
        amount,
      );
    }
  }
}

// Görsel adedi ya da mikro-USD tamsayı olmalı; kesirli bir tahmin aşağı yuvarlanır
// (defter tamsayı ister) ve en az 1 birim ayrılır.
function toAmount(value: number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isFinite(value) || value <= 0) return BigInt(0);
  return BigInt(Math.max(1, Math.trunc(value)));
}

async function reserveUnit(
  spec: OperationSpec,
  unit: UsageUnit,
  amount: bigint,
  now: Date,
): Promise<Held | null> {
  for (let roll = 0; roll <= MAX_KEY_REROLLS; roll += 1) {
    const reservationKey = `${spec.operationId}#${spec.attemptToken}${roll ? `~${roll}` : ""}`;
    const result = await reserveUsage({
      workspaceId: spec.workspaceId,
      unit,
      amount,
      reservationKey,
      operationId: spec.operationId,
      ttlMs: spec.ttlMs,
      now,
    });

    if (result.ok) {
      if (result.kind === "RESERVED" || result.kind === "OVERDRAFT_SHADOW") {
        return { unit, reservationKey, amount, owned: true };
      }
      if (result.kind === "BYPASS") return null;
      // REUSED: yeniden teslim. Hâlâ tutuluyorsa devral; değilse yeni koşudur.
      if (result.status === "RESERVED") {
        return { unit, reservationKey, amount, owned: false };
      }
      continue;
    }

    if (result.reason === "INSUFFICIENT") {
      throw new QuotaExceededError({
        unit,
        needed: Number(amount),
        available: Number(result.available),
        resetsAt: result.resetsAt,
      });
    }
    if (result.reason === "NOT_ENTITLED") {
      throw new NoPlanError(result.entitlement);
    }
    if (result.reason === "UNIT_NOT_SOLD")
      throw new NoPlanError("UNIT_NOT_SOLD");
    // ERROR: COMMIT'ten sonra kopan bir bağlantı rezervasyonu yazmış olabilir;
    // anahtarı adıyla iade et (yoksa NOT_FOUND, zararsız).
    await releaseUsage({ workspaceId: spec.workspaceId, unit, reservationKey });
    throw ledgerUnavailable();
  }
  throw ledgerUnavailable();
}

// Rezervasyonsuz işte yalnız planın geçerli olduğunu doğrular.
async function assertAccess(spec: OperationSpec, now: Date): Promise<void> {
  const entitlements = await getEntitlements(spec.workspaceId, { now });
  if (entitlements.reason === "DEGRADED") {
    if (getBillingConfig().mode === "enforce") throw ledgerUnavailable();
    return;
  }
  if (entitlements.unlimited || entitlements.access === "FULL") return;
  if (getBillingConfig().mode === "enforce") {
    throw new NoPlanError(entitlements.reason);
  }
  await recordShadowDecision({
    workspaceId: spec.workspaceId,
    kind: "not_entitled",
    detail: { operation: spec.operationId, reason: entitlements.reason },
    now,
  });
}

export async function beginOperation(spec: OperationSpec): Promise<Operation> {
  if (getBillingConfig().mode === "off") return new Operation(spec, []);

  const now = spec.now ?? new Date();
  const held: Held[] = [];

  try {
    let wanted = 0;
    for (const unit of UNITS) {
      const requested = spec.reserve[unit];
      if (requested === undefined) continue;
      const amount = toAmount(requested);
      if (amount <= BigInt(0)) continue;
      wanted += 1;
      const reservation = await reserveUnit(spec, unit, amount, now);
      if (reservation) held.push(reservation);
    }
    if (wanted === 0 && spec.requireAccess === true) {
      await assertAccess(spec, now);
    }
  } catch (error) {
    // Bir birim yetmedi: bu çağrının önceki rezervasyonları iade edilir, iş hiçbir
    // şey tutmadan durur. (Devralınanlar kazananındır; park eden çağıran operasyonun
    // kalan tüm tutuşlarını releaseOperationReservations ile temizler.)
    for (const reservation of held) {
      if (!reservation.owned) continue;
      await releaseUsage({
        workspaceId: spec.workspaceId,
        unit: reservation.unit,
        reservationKey: reservation.reservationKey,
      });
    }
    throw error;
  }
  return new Operation(spec, held);
}

// Bir işin AÇIK kalan tüm rezervasyonlarını iade eder (park edilen işin eski
// denemelerinden kalan hayalet tutuşlar yeni rezervasyonu kendi kendine engellemesin).
// Yalnız iş koşmuyorken çağrılır (park CAS'i QUEUED→WAITING_BUDGET başardıktan sonra).
export async function releaseOperationReservations(input: {
  workspaceId: string;
  operationId: string;
}): Promise<number> {
  if (getBillingConfig().mode === "off") return 0;
  const rows = await prisma.usageReservation.findMany({
    where: {
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      status: "RESERVED",
    },
    select: { unit: true, reservationKey: true },
  });
  let released = 0;
  for (const row of rows) {
    const result = await releaseUsage({
      workspaceId: input.workspaceId,
      unit: row.unit as UsageUnit,
      reservationKey: row.reservationKey,
    });
    if (result.status === "RELEASED") released += 1;
  }
  return released;
}

// Bir denemenin anahtarlarını adıyla iade eder (devam adımının önceden ayırdığı,
// ama hiç başlamayacak işin hakkı). Bulunamayan anahtar sorun değildir.
export async function releaseAttemptReservations(input: {
  workspaceId: string;
  operationId: string;
  attemptToken: string;
}): Promise<void> {
  if (getBillingConfig().mode === "off") return;
  for (const unit of UNITS) {
    await releaseUsage({
      workspaceId: input.workspaceId,
      unit,
      reservationKey: `${input.operationId}#${input.attemptToken}`,
    });
  }
}

// Giriş noktası olmayan tek bir ücretli çağrıyı (ör. motor içi ReasoningService
// çağrısı) ölçülü çalıştırır. Kapsamda AYNI workspace'in, rezervasyonlu ve henüz
// mahsup edilmemiş bir operasyonu varsa çağrı onun parçasıdır (rezerve etmez);
// yoksa kendi operasyonunu açar. Rezervasyonsuz (ücretsiz, kapalı mod) bir
// operasyonun içindeki çağrı sahipsiz kalmasın diye ona KATILMAZ.
export async function runMetered<T>(
  spec: OperationSpec,
  fn: () => Promise<T>,
): Promise<T> {
  if (getBillingConfig().mode === "off") return fn();
  const ambient = getUsageScope()?.meter;
  if (
    ambient &&
    ambient.workspaceId === spec.workspaceId &&
    ambient.covered &&
    !ambient.closed
  ) {
    return fn();
  }
  const operation = await beginOperation(spec);
  let outcome: OperationOutcome = "aborted";
  try {
    const result = await operation.run(fn);
    outcome = "delivered";
    return result;
  } catch (error) {
    // Çağrı koştu ve başarısız oldu (faturalı bir yanıttan sonra bozuk çıktı gibi).
    outcome = "failed";
    throw error;
  } finally {
    await operation.finish(outcome);
  }
}
