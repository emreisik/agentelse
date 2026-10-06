import type { GaTableRow } from "@/lib/website-analytics/slices";

import type {
  GaDecomposition,
  GaDecompositionComponent,
  GaDecompositionMetric,
} from "./types";

// AN2 çekirdeği: bir metriğin iki dönem arasındaki farkını boyut satırlarına
// (kanal, giriş sayfası) ayırır (docs/google-analytics-plan.md §6.2; ayrıntı
// docs/website-insights.md "İstatistik"). Satır başına
//   hacim = (S_sonra − S_önce) · r_önce   (oturum değişimi)
//   oran  = S_sonra · (r_sonra − r_önce)  (oturum başına değer değişimi)
// ve bileşen toplamı = hacim + oran. İlk `top` bileşen dışındakiler "other"
// olur; residual = fark − Σbileşen − other, yani bileşenler + other +
// residual her zaman toplam farka eşittir (kırpılmış satırlar ve rapor dışı
// oturumlar residual'a düşer). Saf; veri yoksa boş sonuç döner, atmaz.

export type GaDecomposeRow = {
  key: string;
  label: string;
  sessionsBefore: number;
  sessionsAfter: number;
  valueBefore: number;
  valueAfter: number;
};

const DEFAULT_TOP = 10;

function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// Satır anahtarı: tek boyutta değerin kendisi (registry "Organic Search" ile
// karşılaştırır), çok boyutta JSON.
function rowKey(parts: readonly string[]): string {
  return parts.length === 1 ? (parts[0] ?? "") : JSON.stringify(parts);
}

// İki tabloyu anahtar üzerinden dış birleştirir; aynı anahtar birden çok kez
// gelirse toplanır. `index` metrik sütunlarıdır (oturum ve değer).
export function decompositionRows(
  before: readonly GaTableRow[],
  after: readonly GaTableRow[],
  index: { sessions: number; value: number },
  label?: (key: string[]) => string,
): GaDecomposeRow[] {
  const rows = new Map<string, { parts: string[]; row: GaDecomposeRow }>();
  const entry = (parts: string[]) => {
    const joinKey = JSON.stringify(parts);
    let found = rows.get(joinKey);
    if (!found) {
      found = {
        parts,
        row: {
          key: rowKey(parts),
          label: label ? label(parts) : parts.join(" / "),
          sessionsBefore: 0,
          sessionsAfter: 0,
          valueBefore: 0,
          valueAfter: 0,
        },
      };
      rows.set(joinKey, found);
    }
    return found.row;
  };
  for (const source of before) {
    const row = entry(source.key);
    row.sessionsBefore += finite(source.values[index.sessions]);
    row.valueBefore += finite(source.values[index.value]);
  }
  for (const source of after) {
    const row = entry(source.key);
    row.sessionsAfter += finite(source.values[index.sessions]);
    row.valueAfter += finite(source.values[index.value]);
  }
  return [...rows.values()].map(({ row }) => row);
}

function componentOf(
  row: GaDecomposeRow,
  metric: GaDecompositionMetric,
  divisor: { before: number; after: number },
): GaDecompositionComponent {
  const sB = finite(row.sessionsBefore) / divisor.before;
  const sA = finite(row.sessionsAfter) / divisor.after;
  const vB =
    metric === "sessions" ? sB : finite(row.valueBefore) / divisor.before;
  const vA =
    metric === "sessions" ? sA : finite(row.valueAfter) / divisor.after;
  const rb = sB > 0 ? vB / sB : 0;
  const ra = sA > 0 ? vA / sA : 0;
  // Oturum metriğinde oran bileşeni yoktur: bütün fark hacimdir.
  // `+ 0`: -0 kanıta yazılmasın.
  const volume = (metric === "sessions" ? sA - sB : (sA - sB) * rb) + 0;
  const rate = (metric === "sessions" ? 0 : sA * (ra - rb)) + 0;
  return {
    key: row.key,
    label: row.label,
    sessionsBefore: sB,
    sessionsAfter: sA,
    valueBefore: vB,
    valueAfter: vA,
    rateBefore: sB > 0 ? rb : null,
    rateAfter: sA > 0 ? ra : null,
    volume,
    rate,
    total: volume + rate,
    share: null,
  };
}

export function decompose(input: {
  metric: GaDecompositionMetric;
  dimension: "channel" | "landingPage";
  rows: readonly GaDecomposeRow[];
  totalBefore: number;
  totalAfter: number;
  top?: number;
  perDay?: { before: number; after: number };
}): GaDecomposition {
  // Gün başına normalleştirme bütün hesaptan önce yapılır (MoM: 30 ve 31 gün).
  const divisor = {
    before: input.perDay && input.perDay.before > 0 ? input.perDay.before : 1,
    after: input.perDay && input.perDay.after > 0 ? input.perDay.after : 1,
  };
  const before = finite(input.totalBefore) / divisor.before;
  const after = finite(input.totalAfter) / divisor.after;
  const delta = after - before;
  const top = Math.max(0, Math.floor(input.top ?? DEFAULT_TOP));

  const all = input.rows
    .filter(
      (row) =>
        finite(row.sessionsBefore) !== 0 ||
        finite(row.sessionsAfter) !== 0 ||
        finite(row.valueBefore) !== 0 ||
        finite(row.valueAfter) !== 0,
    )
    .map((row) => componentOf(row, input.metric, divisor))
    .sort(
      (a, b) =>
        Math.abs(b.total) - Math.abs(a.total) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );

  const components = all.slice(0, top).map((component) => ({
    ...component,
    share: delta !== 0 ? component.total / delta : null,
  }));
  const rest = all.slice(top);
  const other =
    rest.length > 0
      ? rest.reduce(
          (sum, component) => ({
            count: sum.count + 1,
            volume: sum.volume + component.volume,
            rate: sum.rate + component.rate,
            total: sum.total + component.total,
          }),
          { count: 0, volume: 0, rate: 0, total: 0 },
        )
      : null;
  const explained =
    components.reduce((sum, component) => sum + component.total, 0) +
    (other?.total ?? 0);

  return {
    metric: input.metric,
    dimension: input.dimension,
    before,
    after,
    delta,
    perDay: input.perDay !== undefined,
    components,
    other,
    residual: delta - explained,
  };
}
