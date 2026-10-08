// Aylık kota pencereleri: saf, UTC. Faturalama aralığı (aylık/yıllık) ne olursa
// olsun kota HER AY verilir; pencereler aboneliğin çapasından (quotaAnchor) sayılır:
// pencere n = [çapa + n ay, çapa + (n+1) ay).
//
// Ay sonu çapalarında gün kelepçelenir (31 Ocak çapası: Şubat'ta ayın son günü,
// Mart'ta yine 31) ve her pencere DOĞRUDAN çapadan hesaplanır, önceki pencereden
// değil, böylece kayma birikmez. Stripe'ın billing_cycle_anchor takvimiyle aynı
// kuraldır.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysInMonthUTC(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

// anchor + months ay; gün ayın uzunluğuna kelepçelenir, gün içi saat korunur.
export function addMonthsUTC(anchor: Date, months: number): Date {
  const total = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const day = Math.min(anchor.getUTCDate(), daysInMonthUTC(year, month));
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

export type QuotaWindow = {
  // Çapadan kaçıncı pencere (0 = ilk).
  index: number;
  start: Date;
  end: Date;
};

// now'ı içeren pencere; now çapadan önceyse null.
export function quotaWindowAt(anchor: Date, now: Date): QuotaWindow | null {
  if (now.getTime() < anchor.getTime()) return null;
  let index =
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - anchor.getUTCMonth());
  // Kelepçe ve gün içi saat yüzünden tahmin en fazla bir pencere sapar.
  while (index > 0 && addMonthsUTC(anchor, index).getTime() > now.getTime()) {
    index -= 1;
  }
  while (addMonthsUTC(anchor, index + 1).getTime() <= now.getTime()) {
    index += 1;
  }
  return {
    index,
    start: addMonthsUTC(anchor, index),
    end: addMonthsUTC(anchor, index + 1),
  };
}

// Pencerenin kalan oranı [0, 1] (yükseltme farkını orantılamak için).
export function remainingFraction(window: QuotaWindow, now: Date): number {
  const total = window.end.getTime() - window.start.getTime();
  if (total <= 0) return 0;
  const remaining = window.end.getTime() - now.getTime();
  return Math.min(1, Math.max(0, remaining / total));
}

export function addDaysUTC(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}
