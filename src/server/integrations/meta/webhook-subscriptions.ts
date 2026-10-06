import "server-only";

import { metaFetch } from "./graph";
import { GRAPH_BASE } from "./version";

// Ads webhook aboneliği (docs/meta-ads-plan.md F7). İki adım: uygulama
// düzeyinde abonelik (object=ad_account, uygulama token'ı) ve reklam hesabı
// başına subscribed_apps (hesabın admin token'ı: admin kullanıcı ya da system
// user; yalnız ADVERTISE görevi olan çalışanın token'ıyla olay gelmez).

export type AppSubscription = {
  object?: string;
  callback_url?: string;
  active?: boolean;
  fields?: { name?: string }[];
};

function appToken(appId: string, appSecret: string): string {
  return `${appId}|${appSecret}`;
}

export async function listAppSubscriptions(
  appId: string,
  appSecret: string,
): Promise<AppSubscription[]> {
  const params = new URLSearchParams({
    access_token: appToken(appId, appSecret),
  });
  const body = await metaFetch<{ data?: AppSubscription[] }>(
    `${GRAPH_BASE}/${appId}/subscriptions?${params.toString()}`,
  );
  return body.data ?? [];
}

export async function subscribeApp(input: {
  appId: string;
  appSecret: string;
  callbackUrl: string;
  verifyToken: string;
  fields: readonly string[];
}): Promise<void> {
  const body = new URLSearchParams({
    object: "ad_account",
    callback_url: input.callbackUrl,
    fields: input.fields.join(","),
    verify_token: input.verifyToken,
    include_values: "true",
    access_token: appToken(input.appId, input.appSecret),
  });
  await metaFetch<{ success?: boolean }>(
    `${GRAPH_BASE}/${input.appId}/subscriptions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
}

export async function listSubscribedApps(
  adAccountId: string,
  accessToken: string,
): Promise<{ id?: string; name?: string }[]> {
  const params = new URLSearchParams({ access_token: accessToken });
  const body = await metaFetch<{ data?: { id?: string; name?: string }[] }>(
    `${GRAPH_BASE}/${adAccountId}/subscribed_apps?${params.toString()}`,
  );
  return body.data ?? [];
}

export async function subscribeAdAccount(
  adAccountId: string,
  accessToken: string,
): Promise<void> {
  const body = new URLSearchParams({ access_token: accessToken });
  await metaFetch<{ success?: boolean }>(
    `${GRAPH_BASE}/${adAccountId}/subscribed_apps`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
}
