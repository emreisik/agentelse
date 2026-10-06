import "server-only";

import { Prisma } from "@prisma/client";

import { INSPECTION_QUEUE_MAX } from "@/lib/seo/audit-constants";
import { prisma } from "@/lib/prisma";

// URL Inspection P1 kuyruğu (SeoSite.inspectQueue). Bekçi, kullanıcı
// tıklaması ve inceleme koşucusu aynı anda yazabildiği için kuyruk YALNIZ bu
// dosyadaki tek ifadelik jsonb SQL'leriyle değişir; JS'te oku-değiştir-yaz
// yoktur, eşzamanlı yazımlar birbirinin girdisini kaybettirmez.

export type InspectQueueEntry = {
  url: string;
  urlHash: string;
  requestedAt: string;
  by: "user" | "watchdog";
};

export function parseInspectQueue(value: unknown): InspectQueueEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: InspectQueueEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.url !== "string" ||
      typeof record.urlHash !== "string" ||
      typeof record.requestedAt !== "string" ||
      (record.by !== "user" && record.by !== "watchdog")
    ) {
      continue;
    }
    entries.push({
      url: record.url,
      urlHash: record.urlHash,
      requestedAt: record.requestedAt,
      by: record.by,
    });
  }
  return entries;
}

// Saklı değer dizi değilse (SQL NULL ya da JSON null) boş dizi sayılır.
const QUEUE = Prisma.sql`(CASE WHEN jsonb_typeof("inspectQueue") = 'array' THEN "inspectQueue" ELSE '[]'::jsonb END)`;

function timestamp(value: Date): Prisma.Sql {
  return Prisma.sql`(${value.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

// Kuyruğa ekler ve incelemeyi en erken çalışma aralığına (son koşu + 60 sn)
// kurar. 0 satır: kuyruk dolu ya da adres zaten sırada (ayrımı bir okuma
// yapar).
export async function appendInspectQueue(
  siteId: string,
  entry: { url: string; urlHash: string; by: "user" | "watchdog" },
  now: Date,
): Promise<"queued" | "already_queued" | "full"> {
  const item = Prisma.sql`jsonb_build_object('url', ${entry.url}::text, 'urlHash', ${entry.urlHash}::text, 'requestedAt', ${now.toISOString()}::text, 'by', ${entry.by}::text)`;
  const at = timestamp(now);
  const updated = await prisma.$executeRaw`
    UPDATE "SeoSite"
       SET "inspectQueue" = ${QUEUE} || jsonb_build_array(${item}),
           "inspectNextAt" = GREATEST(${at}, COALESCE("inspectLastRunAt" + interval '60 seconds', ${at})),
           "updatedAt" = ${at}
     WHERE "id" = ${siteId}
       AND jsonb_array_length(${QUEUE}) < ${INSPECTION_QUEUE_MAX}
       AND NOT (${QUEUE} @> jsonb_build_array(jsonb_build_object('urlHash', ${entry.urlHash}::text)))
  `;
  if (updated === 1) return "queued";
  const site = await prisma.seoSite.findUnique({
    where: { id: siteId },
    select: { inspectQueue: true },
  });
  const queue = parseInspectQueue(site?.inspectQueue ?? null);
  if (queue.some((queued) => queued.urlHash === entry.urlHash)) {
    return "already_queued";
  }
  return "full";
}

// İncelenen (ya da artık geçersiz) adresleri tek ifadeyle düşürür.
export async function removeFromInspectQueue(
  siteId: string,
  urlHashes: readonly string[],
): Promise<void> {
  if (urlHashes.length === 0) return;
  const hashes = [...new Set(urlHashes)];
  await prisma.$executeRaw`
    UPDATE "SeoSite"
       SET "inspectQueue" = COALESCE(
             (SELECT jsonb_agg(item ORDER BY position)
                FROM jsonb_array_elements(${QUEUE}) WITH ORDINALITY AS queued(item, position)
               WHERE NOT ((item->>'urlHash') = ANY(${hashes}::text[]))),
             '[]'::jsonb)
     WHERE "id" = ${siteId}
       AND jsonb_typeof("inspectQueue") = 'array'
  `;
}
