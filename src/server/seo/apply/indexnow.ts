import "server-only";

import { randomBytes } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  applyMockMode,
  seoApplyEnabledFor,
  seoApplyRestrictedProjects,
  seoIndexNowEnabled,
} from "@/lib/seo/apply/flags";
import {
  INDEXNOW_ENDPOINT,
  INDEXNOW_MAX_URLS_PER_CHANGE,
  INDEXNOW_MIN_GAP_MS,
  buildIndexNowBody,
  generateIndexNowKey,
  indexNowKeyUrl,
  indexNowOutcome,
  isValidIndexNowKey,
  keyFileMatches,
} from "@/lib/seo/apply/indexnow";
import type { IndexNowView } from "@/lib/seo/apply/view-types";
import { loadCmsSite } from "@/server/integrations/wordpress/connection";
import {
  WORDPRESS_USER_AGENT,
  guardedWpTransport,
  type WpTransport,
} from "@/server/integrations/wordpress/transport";

import { indexNowViewOf } from "./settings";

// SC-F8 IndexNow (docs/website-apply.md "IndexNow"): isteğe bağlı alt bayrak
// (SEO_INDEXNOW, SEO_APPLY ister). WordPress REST kök dizine dosya yazamaz;
// kullanıcı {anahtar}.txt dosyasını kendisi oluşturur, "Check the file" bunu
// https://host/{anahtar}.txt adresinden okuyup içeriği anahtara eşitse
// doğrulanmış sayar. Bildirimler yalnız herkese açık adreslere (taslak asla)
// ve yalnız IndexNow ortaklarına (Bing, Yandex...; Google'a değil) gider.
// Sitede yazma değildir; durum satırına yalnız durum, zaman ve adres sayısı
// yazılır (adresin kendisi saklanmaz, zaten değişiklikte durur). Mock kipinde
// ağ çağrısı yoktur.

const FETCH_TIMEOUT_MS = 8_000;
const FETCH_MAX_BYTES = 4_096;
const PING_TIMEOUT_MS = 10_000;
const PING_MAX_BYTES = 64 * 1024;
// Bildirim bu süre içinde gönderilemezse (hız sınırı, ağ hatası) bırakılır.
const PENDING_STALE_MS = 24 * 3_600_000;
const SCAN_LIMIT = 200;
const PROJECT_LIMIT = 25;
const PUBLIC_KINDS: readonly string[] = [
  "PUBLISH_LIVE",
  "TITLE_META",
  "INTERNAL_LINKS",
];

type IndexNowState = "PENDING" | "SENT" | "SKIPPED" | "FAILED";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

// Bildirilecek herkese açık adres. Taslak makale (PUBLISH_ARTICLE) hiçbir
// zaman bildirilmez; yayınlanmış yazı liveUrl'den, sayfa değişiklikleri
// params.url'den gelir.
function publicUrlOf(row: {
  kind: string;
  liveUrl: string | null;
  params: unknown;
}): string | null {
  if (!PUBLIC_KINDS.includes(row.kind)) return null;
  const params = isRecord(row.params) ? row.params : {};
  const candidate =
    row.kind === "PUBLISH_LIVE"
      ? (row.liveUrl ?? (typeof params.link === "string" ? params.link : null))
      : typeof params.url === "string"
        ? params.url
        : null;
  return candidate && candidate.startsWith("https://") ? candidate : null;
}

function sameHost(url: string, host: string): boolean {
  try {
    return new URL(url).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function pendingAtOf(row: { indexNow: unknown; updatedAt: Date }): Date {
  if (isRecord(row.indexNow) && typeof row.indexNow.at === "string") {
    const at = new Date(row.indexNow.at);
    if (!Number.isNaN(at.getTime())) return at;
  }
  return row.updatedAt;
}

async function pingIndexNow(
  body: NonNullable<ReturnType<typeof buildIndexNowBody>>,
  transport: WpTransport,
): Promise<ReturnType<typeof indexNowOutcome>> {
  try {
    const response = await transport({
      method: "POST",
      url: new URL(INDEXNOW_ENDPOINT),
      headers: {
        "content-type": "application/json; charset=utf-8",
        "user-agent": WORDPRESS_USER_AGENT,
        accept: "*/*",
      },
      body: JSON.stringify(body),
      timeoutMs: PING_TIMEOUT_MS,
      maxBytes: PING_MAX_BYTES,
    });
    return indexNowOutcome(response.status);
  } catch {
    // Ağ ya da SSRF koruması hatası: geçici sayılır, sonraki turda denenir.
    return "FAILED";
  }
}

async function markRows(
  ids: string[],
  state: IndexNowState,
  now: Date,
  urls: number,
  code?: string,
): Promise<number> {
  if (ids.length === 0) return 0;
  const value: Prisma.InputJsonObject = {
    state,
    at: now.toISOString(),
    urls,
    ...(code ? { code } : {}),
  };
  const result = await prisma.seoChange.updateMany({
    where: {
      id: { in: ids },
      indexNow: { path: ["state"], equals: "PENDING" },
    },
    data: { indexNow: value },
  });
  return result.count;
}

export async function isIndexNowReady(projectId: string): Promise<boolean> {
  if (!seoIndexNowEnabled() || !seoApplyEnabledFor(projectId)) return false;
  const row = await prisma.seoApplySetting.findUnique({
    where: { projectId },
    select: {
      indexNowEnabled: true,
      indexNowKey: true,
      indexNowVerifiedAt: true,
    },
  });
  return Boolean(
    row?.indexNowEnabled &&
    isValidIndexNowKey(row.indexNowKey) &&
    row.indexNowVerifiedAt,
  );
}

export const SeoIndexNow = {
  // Anahtarı üretir (yoksa), host'u bağlı WordPress sitesinden alır. Host
  // değiştiyse (site yeniden bağlandı) doğrulama düşer.
  async enable(
    projectId: string,
    workspaceId: string,
    // Kullanıcı kimliği imzada kalır (çağıranlar geçirir); satırda saklanmaz.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    userId: string,
  ): Promise<IndexNowView> {
    if (!seoIndexNowEnabled() || !seoApplyEnabledFor(projectId)) {
      return indexNowViewOf(null);
    }
    const site = await loadCmsSite(projectId);
    const host = site ? hostOf(site.origin) : null;
    if (!site || !host) return indexNowViewOf(null);

    const existing = await prisma.seoApplySetting.findUnique({
      where: { projectId },
      select: {
        indexNowKey: true,
        indexNowHost: true,
        indexNowVerifiedAt: true,
      },
    });
    const keepKey = isValidIndexNowKey(existing?.indexNowKey);
    const key = keepKey
      ? (existing?.indexNowKey as string)
      : generateIndexNowKey(randomBytes);
    const verifiedAt =
      keepKey && existing?.indexNowHost === host
        ? existing.indexNowVerifiedAt
        : null;

    const row = await prisma.seoApplySetting.upsert({
      where: { projectId },
      create: {
        workspaceId,
        projectId,
        indexNowEnabled: true,
        indexNowKey: key,
        indexNowHost: host,
        indexNowVerifiedAt: null,
      },
      update: {
        indexNowEnabled: true,
        indexNowKey: key,
        indexNowHost: host,
        indexNowVerifiedAt: verifiedAt,
      },
    });
    return indexNowViewOf(row);
  },

  // https://host/{anahtar}.txt dosyasını korumalı taşıma ile okur; gövde
  // anahtara eşitse doğrulanmış sayar. Mock kipinde ağ yok: doğrulanır.
  async verify(
    projectId: string,
    userId: string,
    deps: { transport?: WpTransport } = {},
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!seoIndexNowEnabled() || !seoApplyEnabledFor(projectId)) {
      return { ok: false, message: "IndexNow is not switched on." };
    }
    const setting = await prisma.seoApplySetting.findUnique({
      where: { projectId },
      select: { indexNowEnabled: true, indexNowKey: true },
    });
    const key = setting?.indexNowKey;
    if (!setting?.indexNowEnabled || !isValidIndexNowKey(key)) {
      return { ok: false, message: "Switch IndexNow on first." };
    }
    const site = await loadCmsSite(projectId);
    const host = site ? hostOf(site.origin) : null;
    if (!host) {
      return { ok: false, message: "Connect your WordPress site first." };
    }

    const now = new Date();
    if (applyMockMode()) {
      await prisma.seoApplySetting.update({
        where: { projectId },
        data: { indexNowHost: host, indexNowVerifiedAt: now },
      });
      return { ok: true };
    }

    const transport = deps.transport ?? guardedWpTransport;
    let matches = false;
    try {
      const response = await transport({
        method: "GET",
        url: new URL(indexNowKeyUrl(host, key)),
        headers: { accept: "text/plain", "user-agent": WORDPRESS_USER_AGENT },
        timeoutMs: FETCH_TIMEOUT_MS,
        maxBytes: FETCH_MAX_BYTES,
      });
      matches =
        response.status === 200 &&
        !response.truncated &&
        keyFileMatches(response.body, key);
    } catch {
      return {
        ok: false,
        message: "Agentelse could not reach the key file. Try again later.",
      };
    }
    if (!matches) {
      return {
        ok: false,
        message:
          "The key file was not found or does not contain the key. Create it and check again.",
      };
    }
    await prisma.seoApplySetting.update({
      where: { projectId },
      data: { indexNowHost: host, indexNowVerifiedAt: now },
    });
    return { ok: true };
  },

  // Anahtar saklanır (dosya sitede kalabilir); bekleyen bildirimler bir
  // sonraki turda SKIPPED olur.
  async disable(
    projectId: string,
    // Kullanıcı kimliği imzada kalır (çağıranlar geçirir); satırda saklanmaz.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    userId: string,
  ): Promise<void> {
    await prisma.seoApplySetting.updateMany({
      where: { projectId },
      data: { indexNowEnabled: false },
    });
  },

  // Proje başına en çok bir POST (INDEXNOW_MIN_GAP_MS), çağrı başına en çok
  // 5 adres. Aralık SeoApplySetting.indexNowLastPingAt üzerinde CAS ile
  // alınır; böylece iki süreç aynı anda göndermez. Dönüş: sonuçlanan satır
  // sayısı.
  async flushDue(
    now: Date = new Date(),
    deps: { transport?: WpTransport } = {},
  ): Promise<number> {
    if (!seoIndexNowEnabled()) return 0;
    const restricted = seoApplyRestrictedProjects();
    const mock = applyMockMode();

    const rows = await prisma.seoChange.findMany({
      where: {
        isMock: mock,
        status: { in: ["VERIFIED", "UNDONE"] },
        indexNow: { path: ["state"], equals: "PENDING" },
        ...(restricted ? { projectId: { in: restricted } } : {}),
      },
      orderBy: { updatedAt: "asc" },
      take: SCAN_LIMIT,
      select: {
        id: true,
        projectId: true,
        kind: true,
        liveUrl: true,
        params: true,
        indexNow: true,
        updatedAt: true,
      },
    });
    if (rows.length === 0) return 0;

    const byProject = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byProject.get(row.projectId) ?? [];
      list.push(row);
      byProject.set(row.projectId, list);
    }

    let settled = 0;
    let handled = 0;
    for (const [projectId, projectRows] of byProject) {
      if (handled >= PROJECT_LIMIT) break;
      handled += 1;

      // Çok uzun bekleyenler bırakılır.
      const stale = projectRows.filter(
        (row) => now.getTime() - pendingAtOf(row).getTime() > PENDING_STALE_MS,
      );
      settled += await markRows(
        stale.map((row) => row.id),
        "FAILED",
        now,
        0,
        "stale",
      );
      const fresh = projectRows.filter((row) => !stale.includes(row));
      if (fresh.length === 0) continue;

      const setting = await prisma.seoApplySetting.findUnique({
        where: { projectId },
        select: {
          indexNowEnabled: true,
          indexNowKey: true,
          indexNowHost: true,
          indexNowVerifiedAt: true,
        },
      });
      const key = setting?.indexNowKey;
      const host = setting?.indexNowHost?.toLowerCase() ?? null;
      if (
        !setting?.indexNowEnabled ||
        !setting.indexNowVerifiedAt ||
        !isValidIndexNowKey(key) ||
        !host
      ) {
        settled += await markRows(
          fresh.map((row) => row.id),
          "SKIPPED",
          now,
          0,
        );
        continue;
      }

      // Taslak, https dışı ya da başka host'taki adresler bildirilmez.
      const eligible: { id: string; url: string }[] = [];
      const skipped: string[] = [];
      for (const row of fresh) {
        const url = publicUrlOf(row);
        if (url && sameHost(url, host)) eligible.push({ id: row.id, url });
        else skipped.push(row.id);
      }
      settled += await markRows(skipped, "SKIPPED", now, 0);
      if (eligible.length === 0) continue;

      // Aralık kilidi: bu proje için son bildirimden en az MIN_GAP geçmiş olmalı.
      const claimed = await prisma.seoApplySetting.updateMany({
        where: {
          projectId,
          indexNowEnabled: true,
          indexNowVerifiedAt: { not: null },
          OR: [
            { indexNowLastPingAt: null },
            {
              indexNowLastPingAt: {
                lte: new Date(now.getTime() - INDEXNOW_MIN_GAP_MS),
              },
            },
          ],
        },
        data: { indexNowLastPingAt: now },
      });
      if (claimed.count !== 1) continue;

      const batch = eligible.slice(0, INDEXNOW_MAX_URLS_PER_CHANGE);
      const body = buildIndexNowBody({
        host,
        key,
        urls: batch.map((item) => item.url),
      });
      const ids = batch.map((item) => item.id);
      if (!body) {
        settled += await markRows(ids, "SKIPPED", now, 0);
        continue;
      }

      const outcome = mock
        ? "SENT"
        : await pingIndexNow(body, deps.transport ?? guardedWpTransport);
      if (outcome === "SENT") {
        settled += await markRows(ids, "SENT", now, 1);
      } else if (outcome === "KEY_INVALID") {
        // Anahtar reddedildi: dosya değişmiş ya da silinmiş olabilir; yeniden
        // doğrulama gerekir.
        await prisma.seoApplySetting.updateMany({
          where: { projectId },
          data: { indexNowVerifiedAt: null },
        });
        settled += await markRows(ids, "FAILED", now, 0, "key_invalid");
      } else if (outcome === "URL_MISMATCH") {
        settled += await markRows(ids, "FAILED", now, 0, "url_mismatch");
      }
      // RATE_LIMITED / FAILED: satırlar PENDING kalır; son bildirim zamanı
      // geri çekilme görevi görür, bir sonraki aralıkta yeniden denenir.
    }
    return settled;
  },
};
