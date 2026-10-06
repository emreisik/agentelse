import "server-only";

import { prisma } from "@/lib/prisma";

import type { MetaLane } from "./call-context";
import { MetaApiError } from "./errors";
import {
  blockedUntilAfter,
  laneDecision,
  type AccountUsage,
  usageFromHeaders,
} from "./usage";

// Hesap başına kota yöneticisi (docs/meta-ads-plan.md §3.1). Anahtar her
// zaman Meta `act_` kimliğidir. Durum süreç belleğinde değil AdsAccount
// satırlarında tutulur (lastUsage, rateLimitedUntil): deploy örtüşmesindeki
// iki kopya, GitHub cron tetiği ve süreç içi tick aynı kovayı görür. Okuma
// 5 sn bellekte önbelleklenir; yazım yalnız anlamlı değişimde yapılır.
// Governor asla çağrıyı kendi arızası yüzünden durdurmaz (fail-open).

export class MetaRateLimitedError extends MetaApiError {
  readonly retryAt: Date;
  constructor(message: string, retryAt: Date) {
    // Kod 4: katalogda RATE_LIMIT; kısa tekrar yapılmaz.
    super(message, 4, undefined, { httpStatus: 429 });
    this.name = "MetaRateLimitedError";
    this.retryAt = retryAt;
  }
}

type AccountState = {
  usage: AccountUsage | null;
  blockedUntil: Date | null;
  readAt: number;
  writtenPct: number | null;
  writtenAt: number;
};

const READ_CACHE_MS = 5_000;
const WRITE_EVERY_MS = 60_000;
const state = new Map<string, AccountState>();

// Birim testlerinde (vitest) veritabanına gidilmez; governor testleri
// deposunu kendisi sağlar.
let dbEnabled = !process.env.VITEST || process.env.META_GOVERNOR_DB === "1";

function normalize(account: string): string {
  return account.startsWith("act_") ? account : `act_${account}`;
}

async function readState(account: string, now: Date): Promise<AccountState> {
  const cached = state.get(account);
  if (cached && now.getTime() - cached.readAt < READ_CACHE_MS) return cached;
  let usage = cached?.usage ?? null;
  let blockedUntil = cached?.blockedUntil ?? null;
  if (dbEnabled) {
    try {
      // Aynı hesap birden çok workspace'e bağlı olabilir: en kısıtlayıcısı.
      const rows = await prisma.adsAccount.findMany({
        where: { externalId: account },
        select: { lastUsage: true, rateLimitedUntil: true },
        take: 5,
      });
      for (const row of rows) {
        const rowUsage = row.lastUsage as AccountUsage | null;
        if (rowUsage && (!usage || rowUsage.pct > usage.pct)) usage = rowUsage;
        if (
          row.rateLimitedUntil &&
          (!blockedUntil || row.rateLimitedUntil > blockedUntil)
        ) {
          blockedUntil = row.rateLimitedUntil;
        }
      }
    } catch {
      // Okunamadıysa bellekteki son bilgiyle devam: governor işi durdurmaz.
    }
  }
  const next: AccountState = {
    usage,
    blockedUntil,
    readAt: now.getTime(),
    writtenPct: cached?.writtenPct ?? null,
    writtenAt: cached?.writtenAt ?? 0,
  };
  state.set(account, next);
  return next;
}

async function writeState(
  account: string,
  data: { lastUsage?: AccountUsage; rateLimitedUntil?: Date },
): Promise<void> {
  if (!dbEnabled) return;
  try {
    await prisma.adsAccount.updateMany({
      where: { externalId: account },
      data: {
        ...(data.lastUsage ? { lastUsage: data.lastUsage as never } : {}),
        ...(data.rateLimitedUntil
          ? { rateLimitedUntil: data.rateLimitedUntil }
          : {}),
      },
    });
  } catch {
    // Bir sonraki ölçümde yeniden denenir.
  }
}

export const MetaGovernor = {
  // Çağrıdan önce: izin yoksa MetaRateLimitedError (retryAt ile).
  async acquire(
    rawAccount: string,
    lane: MetaLane,
    now: Date = new Date(),
  ): Promise<void> {
    const account = normalize(rawAccount);
    const current = await readState(account, now);
    const decision = laneDecision({
      lane,
      usage: current.usage,
      blockedUntil: current.blockedUntil,
      now,
    });
    if (!decision.allow) {
      throw new MetaRateLimitedError(
        `${decision.reason}; try again after ${decision.retryAt.toISOString()}`,
        decision.retryAt,
      );
    }
  },

  // Her yanıttan sonra: Meta'nın kullanım başlıkları kaydedilir.
  async observe(
    rawAccount: string,
    headers: { get(name: string): string | null },
    now: Date = new Date(),
  ): Promise<void> {
    const usage = usageFromHeaders(headers, now);
    if (!usage) return;
    const account = normalize(rawAccount);
    const current = state.get(account);
    const next: AccountState = {
      usage,
      blockedUntil: current?.blockedUntil ?? null,
      readAt: now.getTime(),
      writtenPct: current?.writtenPct ?? null,
      writtenAt: current?.writtenAt ?? 0,
    };
    const changedEnough =
      next.writtenPct === null ||
      Math.abs(usage.pct - next.writtenPct) >= 5 ||
      now.getTime() - next.writtenAt >= WRITE_EVERY_MS;
    if (changedEnough) {
      next.writtenPct = usage.pct;
      next.writtenAt = now.getTime();
      state.set(account, next);
      await writeState(account, { lastUsage: usage });
    } else {
      state.set(account, next);
    }
  },

  // Kota hatasından sonra: hesap blok süresi kadar bekler (P0 dahil).
  async block(
    rawAccount: string,
    error: MetaApiError,
    headers: { get(name: string): string | null } | null,
    now: Date = new Date(),
  ): Promise<Date> {
    const account = normalize(rawAccount);
    const usage = headers ? usageFromHeaders(headers, now) : null;
    const until = blockedUntilAfter({
      code: error.metaErrorCode,
      subcode: error.metaErrorSubcode,
      usage: usage ?? state.get(account)?.usage ?? null,
      now,
    });
    const current = state.get(account);
    state.set(account, {
      usage: usage ?? current?.usage ?? null,
      blockedUntil: until,
      readAt: now.getTime(),
      writtenPct: current?.writtenPct ?? null,
      writtenAt: now.getTime(),
    });
    await writeState(account, {
      rateLimitedUntil: until,
      ...(usage ? { lastUsage: usage } : {}),
    });
    return until;
  },

  // Testler için.
  resetForTests(options: { db?: boolean } = {}): void {
    state.clear();
    if (options.db !== undefined) dbEnabled = options.db;
  },
};
