import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Meta Ads webhook'ları (docs/meta-ads-plan.md F7): imza doğrulama, olay
// ayrıştırma ve tekilleştirme. Saf (yalnız node:crypto). Olay gövdesinde
// olay kimliği yoktur ve yük anahtarları belgede kesin değildir: nesne
// kimliği ve düzeyi birkaç olası anahtardan toleranslı okunur, yeni değer
// asla gövdeden alınmaz (işleyici nesneyi hedefli okur).

// Abone olunan alanlar (Meta: "Ads webhooks overview", Temmuz 2026).
export const WEBHOOK_FIELDS = [
  "effective_status",
  "with_issues_ad_objects",
  "in_process_ad_objects",
  "creative_fatigue",
  "ad_recommendations",
] as const;

// Sunucu tarafında bir isteğin okunacağı en çok bayt (oturumsuz uç).
export const MAX_WEBHOOK_BODY_BYTES = 512 * 1024;
const MAX_ENTRIES = 200;
const MAX_CHANGES = 500;

export type WebhookLevel = "CAMPAIGN" | "ADSET" | "AD";

export type ParsedWebhookEvent = {
  // "act_<id>"
  adAccountExternalId: string;
  field: string;
  objectExternalId: string | null;
  objectLevel: WebhookLevel | null;
  payload: { time: string | number | null; value: Record<string, unknown> };
  dedupeKey: string;
};

// X-Hub-Signature-256: "sha256=" + HMAC-SHA256(uygulama sırrı, ham gövde).
// Ham baytlar üzerinden hesaplanır (Meta'nın imzaladığı tam olarak odur).
export function verifyWebhookSignature(
  rawBody: Buffer,
  header: string | null,
  appSecret: string,
): boolean {
  if (!header || !appSecret) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(match[1]!, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Doğrulama jetonu karşılaştırması (sabit zamanlı).
export function sameToken(given: string | null, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function idOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value))
    return String(value);
  return typeof value === "string" && /^\d{1,32}$/.test(value) ? value : null;
}

function firstId(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const id = idOf(value[key]);
    if (id) return id;
  }
  return null;
}

export function webhookLevel(
  raw: unknown,
  value: Record<string, unknown> = {},
): WebhookLevel | null {
  const text =
    typeof raw === "string" ? raw.toUpperCase().replace(/[^A-Z]/g, "") : "";
  if (text === "AD") return "AD";
  if (text === "ADSET") return "ADSET";
  if (text === "CAMPAIGN") return "CAMPAIGN";
  if (idOf(value.ad_id)) return "AD";
  if (idOf(value.adset_id)) return "ADSET";
  if (idOf(value.campaign_id)) return "CAMPAIGN";
  return null;
}

// Anahtar sırasından bağımsız JSON (aynı olayın yeniden gönderimi aynı
// anahtarı üretir).
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function webhookDedupeKey(input: {
  entryId: string;
  time: unknown;
  field: string;
  objectId: string | null;
  value: Record<string, unknown>;
}): string {
  return createHash("sha256")
    .update(
      [
        input.entryId,
        String(input.time ?? ""),
        input.field,
        input.objectId ?? "",
        stableJson(input.value),
      ].join("|"),
    )
    .digest("hex");
}

// { object: "ad_account", entry: [{ id, time, changes: [{ field, value }] }] }
export function parseWebhookBody(body: unknown): ParsedWebhookEvent[] {
  if (
    !isRecord(body) ||
    body.object !== "ad_account" ||
    !Array.isArray(body.entry)
  ) {
    return [];
  }
  const out: ParsedWebhookEvent[] = [];
  for (const entry of body.entry.slice(0, MAX_ENTRIES)) {
    if (!isRecord(entry)) continue;
    const rawId =
      typeof entry.id === "string" ? entry.id.replace(/^act_/, "") : entry.id;
    const accountId = idOf(rawId);
    if (!accountId) continue;
    const time =
      typeof entry.time === "number" || typeof entry.time === "string"
        ? entry.time
        : null;
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes.slice(0, MAX_CHANGES)) {
      if (
        !isRecord(change) ||
        typeof change.field !== "string" ||
        !change.field
      )
        continue;
      const value = isRecord(change.value) ? change.value : {};
      const objectId = firstId(value, [
        "ad_object_id",
        "object_id",
        "id",
        "ad_id",
        "adset_id",
        "campaign_id",
      ]);
      out.push({
        adAccountExternalId: `act_${accountId}`,
        field: change.field.slice(0, 64),
        objectExternalId: objectId,
        objectLevel: webhookLevel(
          value.ad_object_type ?? value.object_type ?? value.level,
          value,
        ),
        payload: { time, value },
        dedupeKey: webhookDedupeKey({
          entryId: accountId,
          time,
          field: change.field,
          objectId,
          value,
        }),
      });
    }
  }
  return out;
}
