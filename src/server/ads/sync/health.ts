import "server-only";

import {
  accountHealthIssues,
  hasFundingSource,
  healthStatusOf,
  type AccountHealthIssue,
} from "@/lib/ads/account-health";
import { prisma } from "@/lib/prisma";
import { AdsAlerts } from "@/server/ads/guard/alerts";
import { readAccountHealth } from "@/server/integrations/meta/sync-reads";

import type { SyncContext } from "./context";

// Hesap sağlığı senkronu (docs/meta-ads-plan.md §3.2, §3.6 Hesap / ödeme,
// Piksel sağlığı). 6 saatte bir; sonuç AdsAccount'a yazılır, uyarılar burada
// açılır ve kapanır.

export const ACCOUNT_ALERT_KINDS = [
  "ACCOUNT_BLOCKED",
  "PAYMENT_ISSUE",
  "SPEND_CAP_NEAR",
  "SPEND_CAP_REACHED",
] as const;

const PIXEL_STALE_MS = 24 * 60 * 60_000;

function minorOf(value: unknown): bigint | null {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? BigInt(Math.round(number)) : null;
}

function currencyOf(value: unknown): string | null {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

export async function syncAccountHealth(
  ctx: SyncContext,
): Promise<{ issues: AccountHealthIssue[] }> {
  const read = await readAccountHealth(ctx.externalId, ctx.accessToken);
  const hasFunding = read.hasFundingInfo
    ? hasFundingSource(read.funding_source_details)
    : null;
  const spendCapMinor = minorOf(read.spend_cap);
  const amountSpentMinor = minorOf(read.amount_spent);
  const issues = accountHealthIssues({
    accountStatus:
      typeof read.account_status === "number" ? read.account_status : null,
    disableReason:
      typeof read.disable_reason === "number" ? read.disable_reason : null,
    hasFunding,
    spendCapMinor: spendCapMinor === null ? null : Number(spendCapMinor),
    amountSpentMinor: amountSpentMinor === null ? null : Number(amountSpentMinor),
  });
  const health = healthStatusOf(issues);
  const currency = currencyOf(read.currency) ?? ctx.account.currency;

  ctx.account = await prisma.adsAccount.update({
    where: { id: ctx.account.id },
    data: {
      accountStatus:
        typeof read.account_status === "number" ? read.account_status : null,
      disableReason:
        typeof read.disable_reason === "number" ? read.disable_reason : null,
      hasFunding,
      isPersonal:
        read.is_personal === undefined ? null : Boolean(read.is_personal),
      currency,
      timezoneName: read.timezone_name ?? ctx.account.timezoneName,
      spendCapMinor: spendCapMinor && spendCapMinor > BigInt(0) ? spendCapMinor : null,
      amountSpentMinor,
      minDailyBudgetMinor: minorOf(read.min_daily_budget),
      minCampaignSpendCapMinor: minorOf(read.min_campaign_group_spend_cap),
      ...(read.minimumBudgets !== undefined
        ? { minimumBudgets: read.minimumBudgets as object }
        : {}),
      userTasks: Array.isArray(read.user_tasks) ? read.user_tasks : [],
      businessId: read.business?.id ?? null,
      dsaBeneficiary: read.default_dsa_beneficiary ?? ctx.account.dsaBeneficiary,
      dsaPayor: read.default_dsa_payor ?? ctx.account.dsaPayor,
      healthStatus: health.status,
      healthReason: health.reason,
      lastHealthAt: ctx.now,
    },
  });
  ctx.currency = currency;

  // Uyarılar: hesabın seçili olduğu her proje için.
  for (const project of ctx.projects) {
    const open = new Set<string>();
    for (const issue of issues) {
      const dedupeKey = `account:${ctx.externalId}:${issue.kind}`;
      open.add(dedupeKey);
      await AdsAlerts.raise(
        {
          workspaceId: project.workspaceId,
          projectId: project.projectId,
          adsAccountId: ctx.account.id,
          externalId: ctx.externalId,
          kind: issue.kind,
          severity: issue.severity,
          dedupeKey,
          title: issue.title,
          detail: issue.detail,
        },
        ctx.now,
      );
    }
    await AdsAlerts.resolveMissing(
      {
        projectId: project.projectId,
        kinds: ACCOUNT_ALERT_KINDS,
        stillOpen: open,
        adsAccountId: ctx.account.id,
      },
      ctx.now,
    );
  }

  await checkPixels(ctx, read.pixels);
  return { issues };
}

// Piksel sessizliği yalnız dönüşüm hedefli teslimat sürerken anlamlıdır:
// hesaptaki eski, kullanılmayan pikseller gürültü üretmesin.
async function checkPixels(
  ctx: SyncContext,
  pixels: { id: string; last_fired_time?: string; is_unavailable?: boolean }[] | undefined,
): Promise<void> {
  if (!pixels) return;
  const conversionDelivery = await prisma.adsObject.count({
    where: {
      adsAccountId: ctx.account.id,
      level: "ADSET",
      effectiveStatus: "ACTIVE",
      goneAt: null,
      resultActionType: { startsWith: "offsite_conversion." },
    },
  });
  const usable = pixels.filter((pixel) => {
    if (pixel.is_unavailable) return false;
    const fired = pixel.last_fired_time ? Date.parse(pixel.last_fired_time) : NaN;
    return Number.isFinite(fired) && ctx.now.getTime() - fired < PIXEL_STALE_MS;
  });
  const stale = conversionDelivery > 0 && usable.length === 0;
  for (const project of ctx.projects) {
    const dedupeKey = `account:${ctx.externalId}:TRACKING_STALE`;
    if (stale) {
      await AdsAlerts.raise(
        {
          workspaceId: project.workspaceId,
          projectId: project.projectId,
          adsAccountId: ctx.account.id,
          externalId: ctx.externalId,
          kind: "TRACKING_STALE",
          severity: "WARN",
          dedupeKey,
          title: "Your website tracking looks silent",
          detail:
            "The Meta Pixel hasn't sent an event for 24 hours while conversion ads are running. Results may be under-reported.",
        },
        ctx.now,
      );
    } else {
      await AdsAlerts.resolve(project.projectId, dedupeKey, ctx.now);
    }
  }
}
