import "server-only";

import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { isBrandQuery } from "@/lib/seo/brand-terms";
import { prisma } from "@/lib/prisma";

import type { GscSyncContext } from "./context";

// Sorgu ve sayfa sözlükleri (GscQuery, GscPage): metin bir kez saklanır,
// özet tabloları kimlikle bağlanır. Sorgu×sayfa yanıtı aynı sorguyu ve sayfayı
// birçok satırda tekrarlar; Postgres tek ifadede aynı satırı iki kez
// güncelleyemediği için (ON CONFLICT DO UPDATE) öğeler önce özete göre
// tekilleştirilir. firstSeenWeek/lastSeenWeek saklama budamasında kullanılır.

const ROWS_PER_STATEMENT = 500;

type Returned = { id: string; hash: string };

function unique<T>(items: readonly T[], hashOf: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    const hash = hashOf(item);
    if (!seen.has(hash)) seen.set(hash, item);
  }
  return [...seen.values()];
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) {
    out.push(items.slice(at, at + size));
  }
  return out;
}

export async function upsertQueries(
  ctx: GscSyncContext,
  items: readonly { text: string; hash: string }[],
  seenWeek: string,
  options: { classify: boolean },
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const week = seenWeek;
  const terms = ctx.brand?.terms ?? [];
  const classify = options.classify && ctx.brand !== null;
  for (const part of chunks(
    unique(items, (item) => item.hash),
    ROWS_PER_STATEMENT,
  )) {
    const values = part.map(
      (item) =>
        Prisma.sql`(${randomUUID()}, ${ctx.link.id}, ${ctx.link.projectId}, ${item.text}, ${item.hash}, ${classify ? isBrandQuery(item.text, terms) : false}, ${week}::date, ${week}::date)`,
    );
    const rows = await prisma.$queryRaw<Returned[]>`
      INSERT INTO "GscQuery" ("id", "linkId", "projectId", "text", "textHash", "isBrand", "firstSeenWeek", "lastSeenWeek")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("linkId", "textHash") DO UPDATE SET
        "lastSeenWeek" = GREATEST("GscQuery"."lastSeenWeek", EXCLUDED."lastSeenWeek"),
        "firstSeenWeek" = LEAST("GscQuery"."firstSeenWeek", EXCLUDED."firstSeenWeek")
        ${classify ? Prisma.sql`, "isBrand" = EXCLUDED."isBrand"` : Prisma.empty}
      RETURNING "id", "textHash" AS "hash"
    `;
    for (const row of rows) ids.set(row.hash, row.id);
  }
  return ids;
}

export async function upsertPages(
  ctx: GscSyncContext,
  items: readonly {
    url: string;
    hash: string;
    path: string;
    pageGroup: string;
  }[],
  seenWeek: string,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const week = seenWeek;
  for (const part of chunks(
    unique(items, (item) => item.hash),
    ROWS_PER_STATEMENT,
  )) {
    const values = part.map(
      (item) =>
        Prisma.sql`(${randomUUID()}, ${ctx.link.id}, ${ctx.link.projectId}, ${item.url}, ${item.hash}, ${item.path}, ${item.pageGroup}, ${week}::date, ${week}::date)`,
    );
    const rows = await prisma.$queryRaw<Returned[]>`
      INSERT INTO "GscPage" ("id", "linkId", "projectId", "url", "urlHash", "path", "pageGroup", "firstSeenWeek", "lastSeenWeek")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("linkId", "urlHash") DO UPDATE SET
        "lastSeenWeek" = GREATEST("GscPage"."lastSeenWeek", EXCLUDED."lastSeenWeek"),
        "firstSeenWeek" = LEAST("GscPage"."firstSeenWeek", EXCLUDED."firstSeenWeek")
      RETURNING "id", "urlHash" AS "hash"
    `;
    for (const row of rows) ids.set(row.hash, row.id);
  }
  return ids;
}
