import {
  parseQuota,
  type GaPropertyQuota,
} from "@/lib/website-analytics/response";

import type { FunnelResult, FunnelStep, FunnelStepResult } from "./types";

// v1alpha runFunnelReport yanıtını okur (GA-F8). Okuyucu hoşgörülüdür: başlıklar
// ADLA aranır, sıra değişse de çalışır; eksik metrik null olur; bozuk girdide
// null döner, asla fırlatmaz. Yanıt şekli kayıtlı fixture'dır
// (__fixtures__/funnel-response.json).

type RawCell = { value?: unknown };
type RawRow = { dimensionValues?: RawCell[]; metricValues?: RawCell[] };
type RawHeader = { name?: unknown };

export type ParsedFunnel = {
  result: FunnelResult;
  quota: GaPropertyQuota | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function headerIndex(headers: unknown, name: string): number {
  if (!Array.isArray(headers)) return -1;
  return headers.findIndex(
    (header: RawHeader) => record(header)?.name === name,
  );
}

function cellNumber(cells: RawCell[] | undefined, index: number): number | null {
  if (index < 0 || !Array.isArray(cells)) return null;
  const raw = record(cells[index])?.value;
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function rate(value: number | null): number | null {
  return value === null ? null : Math.min(1, Math.max(0, value));
}

// Google adım adını "1. Visit" biçiminde döndürür; baştaki sıra numarası atılır.
function plainName(value: string): string {
  return value.replace(/^\s*\d+\.\s*/, "").trim().toLowerCase();
}

function rowName(row: RawRow, nameIndex: number): string | null {
  const raw = record(row.dimensionValues?.[nameIndex])?.value;
  return typeof raw === "string" ? plainName(raw) : null;
}

// Tanımdaki adımlar sırasıyla çözülür. Satır, adım adıyla eşleşirse o satır
// alınır; eşleşmezse aynı sıradaki satır.
export function parseFunnelResponse(
  raw: unknown,
  stepNames: readonly string[],
  through: string,
): ParsedFunnel | null {
  const body = record(raw);
  const table = record(body?.funnelTable);
  if (!body || !table) return null;

  const rows: RawRow[] = Array.isArray(table.rows)
    ? (table.rows as RawRow[]).filter((row) => record(row) !== null)
    : [];
  const nameCol = headerIndex(table.dimensionHeaders, "funnelStepName");
  const usersCol = headerIndex(table.metricHeaders, "activeUsers");
  const completionCol = headerIndex(
    table.metricHeaders,
    "funnelStepCompletionRate",
  );
  const abandonCol = headerIndex(
    table.metricHeaders,
    "funnelStepAbandonments",
  );
  const abandonRateCol = headerIndex(
    table.metricHeaders,
    "funnelStepAbandonmentRate",
  );
  // Kullanıcı sayısı olmayan yanıt bir huni değildir.
  if (usersCol < 0) return null;

  const steps: FunnelStepResult[] = stepNames.map((name, index) => {
    const wanted = plainName(name);
    const byName =
      nameCol >= 0
        ? rows.find((row) => rowName(row, nameCol) === wanted)
        : undefined;
    const row = byName ?? rows[index];
    const users = cellNumber(row?.metricValues, usersCol);
    const abandonments = cellNumber(row?.metricValues, abandonCol);
    return {
      name,
      users: users === null ? 0 : Math.max(0, Math.round(users)),
      completionRate: rate(cellNumber(row?.metricValues, completionCol)),
      abandonments:
        abandonments === null ? null : Math.max(0, Math.round(abandonments)),
      abandonmentRate: rate(cellNumber(row?.metricValues, abandonRateCol)),
    };
  });

  return {
    result: { through, steps },
    quota: parseQuota(
      record(body.propertyQuota) as Parameters<typeof parseQuota>[0],
    ),
  };
}

// Saklanan sonucu (Json) hoşgörüyle okur; bozuksa null.
export function readStoredFunnelResult(value: unknown): FunnelResult | null {
  const body = record(value);
  if (!body || typeof body.through !== "string" || !Array.isArray(body.steps)) {
    return null;
  }
  const steps: FunnelStepResult[] = [];
  for (const item of body.steps) {
    const step = record(item);
    if (!step || typeof step.name !== "string") return null;
    const num = (key: string): number | null =>
      typeof step[key] === "number" && Number.isFinite(step[key])
        ? (step[key] as number)
        : null;
    steps.push({
      name: step.name,
      users: Math.max(0, num("users") ?? 0),
      completionRate: num("completionRate"),
      abandonments: num("abandonments"),
      abandonmentRate: num("abandonmentRate"),
    });
  }
  return { through: body.through, steps };
}

// Saklanan adımları (Json) hoşgörüyle okur; bozuksa null.
export function readStoredFunnelSteps(value: unknown): FunnelStep[] | null {
  if (!Array.isArray(value)) return null;
  const steps: FunnelStep[] = [];
  for (const item of value) {
    const step = record(item);
    if (
      !step ||
      typeof step.name !== "string" ||
      typeof step.value !== "string" ||
      (step.kind !== "event" && step.kind !== "page")
    ) {
      return null;
    }
    steps.push({ name: step.name, kind: step.kind, value: step.value });
  }
  return steps;
}
