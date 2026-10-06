import "server-only";

import { AdsFlags } from "@/lib/ads/flags";
import { WEBHOOK_FIELDS } from "@/lib/ads/webhooks";
import { appUrl } from "@/lib/app-url";
import { getEnv } from "@/lib/env";
import { metaWorkExcludedHere } from "@/lib/local-worker-policy";
import { prisma } from "@/lib/prisma";
import { withMetaCallContext } from "@/server/integrations/meta/call-context";
import { MetaApiError } from "@/server/integrations/meta/errors";
import {
  listAppSubscriptions,
  listSubscribedApps,
  subscribeAdAccount,
  subscribeApp,
} from "@/server/integrations/meta/webhook-subscriptions";
import { claimPeriodic } from "@/server/observability/periodic";
import { decryptSecret } from "@/server/security/crypto";

// Webhook aboneliğinin bakımı (docs/meta-ads-plan.md F7): uygulama düzeyinde
// abonelik günde bir doğrulanır (yoksa kurulur), her reklam hesabı günde bir
// subscribed_apps ile denetlenir (düşmüşse yeniden abone olunur). Hesapta
// admin (MANAGE) görevi yoksa olay gelmez: hesap "polling only" kalır ve Ads
// sayfası bunu söyler. Ayna yoklaması her durumda yedektir.

const DAY_MS = 24 * 60 * 60_000;
export const WEBHOOK_PATH = "/api/webhooks/meta-ads";

export type WebhookStatus = "SUBSCRIBED" | "POLLING_ONLY" | "FAILED";

// 10 / 2xx: izin yok (admin değil ya da ads_management eksik).
function permissionError(error: unknown): boolean {
  if (!(error instanceof MetaApiError)) return false;
  const code = error.metaErrorCode;
  return code === 10 || (code !== undefined && code >= 200 && code < 300);
}

async function ensureAppSubscription(): Promise<void> {
  const env = getEnv();
  const callbackUrl = appUrl(WEBHOOK_PATH).toString();
  const current = await listAppSubscriptions(
    env.META_APP_ID,
    env.META_APP_SECRET,
  );
  const ours = current.find((row) => row.object === "ad_account");
  const fields = new Set((ours?.fields ?? []).map((field) => field.name));
  const complete =
    ours?.active !== false &&
    ours?.callback_url === callbackUrl &&
    WEBHOOK_FIELDS.every((field) => fields.has(field));
  if (complete) return;
  await subscribeApp({
    appId: env.META_APP_ID,
    appSecret: env.META_APP_SECRET,
    callbackUrl,
    verifyToken: env.META_ADS_WEBHOOK_VERIFY_TOKEN,
    fields: WEBHOOK_FIELDS,
  });
  console.info("[ads-webhooks] app subscription (re)created for ad_account");
}

export const AdsWebhookSubscriptions = {
  configured(): boolean {
    const env = getEnv();
    return Boolean(
      env.META_APP_ID &&
      env.META_APP_SECRET &&
      env.META_ADS_WEBHOOK_VERIFY_TOKEN,
    );
  },

  // Tick adımı: vadesi gelen birkaç hesap.
  async runDue(now: Date = new Date(), limit = 5): Promise<number> {
    if (!AdsFlags.webhooks() || !AdsFlags.sync()) return 0;
    if (metaWorkExcludedHere(process.env)) return 0;
    if (!this.configured()) return 0;
    if (await claimPeriodic("ads.webhook-app-subscription", DAY_MS, now)) {
      await ensureAppSubscription().catch((error: unknown) => {
        console.error(
          "[ads-webhooks] app subscription check failed:",
          error instanceof Error ? error.message : error,
        );
      });
    }
    const accounts = await prisma.adsAccount.findMany({
      where: {
        platform: "META",
        credentialId: { not: null },
        projects: { some: { selected: true } },
        OR: [
          { webhookCheckedAt: null },
          { webhookCheckedAt: { lt: new Date(now.getTime() - DAY_MS) } },
        ],
      },
      orderBy: [{ webhookCheckedAt: { sort: "asc", nulls: "first" } }],
      take: limit,
    });
    let checked = 0;
    for (const account of accounts) {
      const status = await this.checkAccount(account, now);
      await prisma.adsAccount.update({
        where: { id: account.id },
        data: { webhookStatus: status, webhookCheckedAt: now },
      });
      checked += 1;
    }
    return checked;
  },

  async checkAccount(
    account: {
      externalId: string;
      credentialId: string | null;
      userTasks: string[];
      webhookStatus: string | null;
    },
    now: Date,
  ): Promise<WebhookStatus> {
    // Yalnız admin (MANAGE) token'ı subscribed_apps yazabilir.
    if (!account.userTasks.includes("MANAGE")) return "POLLING_ONLY";
    const credential = account.credentialId
      ? await prisma.integrationCredential.findUnique({
          where: { id: account.credentialId },
          select: { status: true, encryptedSecret: true },
        })
      : null;
    if (
      !credential ||
      credential.status !== "ACTIVE" ||
      !credential.encryptedSecret
    ) {
      return "FAILED";
    }
    const token = decryptSecret(credential.encryptedSecret);
    const appId = getEnv().META_APP_ID;
    try {
      return await withMetaCallContext(
        {
          account: account.externalId,
          lane: "P2_BACKGROUND",
          callSite: "ads.webhook-subscription",
        },
        async () => {
          const apps = await listSubscribedApps(account.externalId, token);
          if (apps.some((app) => app.id === appId))
            return "SUBSCRIBED" as const;
          await subscribeAdAccount(account.externalId, token);
          if (account.webhookStatus === "SUBSCRIBED") {
            console.warn(
              `[ads-webhooks] ${account.externalId} had dropped its subscription; subscribed again (${now.toISOString()})`,
            );
          }
          return "SUBSCRIBED" as const;
        },
      );
    } catch (error) {
      console.error(
        `[ads-webhooks] ${account.externalId} subscription failed:`,
        error instanceof Error ? error.message : error,
      );
      return permissionError(error) ? "POLLING_ONLY" : "FAILED";
    }
  },
};
