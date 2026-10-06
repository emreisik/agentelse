import "server-only";

import { normalizeAdAccountId } from "@/lib/ads/account-id";
import { appUrl } from "@/lib/app-url";
import { getEnv } from "@/lib/env";

import { metaFetch } from "./graph";
import { requestPages } from "./paging";
import { GRAPH_API_VERSION, GRAPH_BASE } from "./version";

// Facebook Login for Business (docs/meta-ads-plan.md F8): config_id ile açılan
// onay ekranı. "System-user access token" yapılandırmasında dönen token BISU'dur
// (Business Integration System User): kişiye bağlı değil, süresiz, müşterinin
// business portfolio'suna bağlı. Yönlendirme adresi App Dashboard'da "Valid
// OAuth Redirect URIs"e eklenmeli.

export const BUSINESS_CALLBACK_PATH =
  "/api/integrations/meta-business/callback";
const AUTHORIZE_URL = `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth`;

export function businessLoginConfigured(): boolean {
  const env = getEnv();
  return Boolean(
    env.META_APP_ID && env.META_APP_SECRET && env.META_FLFB_CONFIG_ID,
  );
}

function redirectUri(): string {
  return appUrl(BUSINESS_CALLBACK_PATH).toString();
}

export function buildBusinessLoginUrl(state: string): string {
  const env = getEnv();
  const params = new URLSearchParams({
    client_id: env.META_APP_ID,
    redirect_uri: redirectUri(),
    config_id: env.META_FLFB_CONFIG_ID,
    response_type: "code",
    override_default_response_type: "true",
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeBusinessCode(code: string): Promise<string> {
  const env = getEnv();
  const params = new URLSearchParams({
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    redirect_uri: redirectUri(),
    code,
  });
  const result = await metaFetch<{ access_token?: string }>(
    `${GRAPH_BASE}/oauth/access_token?${params.toString()}`,
  );
  if (!result.access_token)
    throw new Error("Meta didn't return an access token");
  return result.access_token;
}

export type BusinessIdentity = {
  id: string;
  name: string | null;
  clientBusinessId: string | null;
};

export async function readBusinessIdentity(
  accessToken: string,
): Promise<BusinessIdentity> {
  const params = new URLSearchParams({
    fields: "id,name,client_business_id",
    access_token: accessToken,
  });
  const me = await metaFetch<{
    id: string;
    name?: string;
    client_business_id?: string;
  }>(`${GRAPH_BASE}/me?${params.toString()}`);
  return {
    id: me.id,
    name: me.name ?? null,
    clientBusinessId: me.client_business_id ?? null,
  };
}

export type BusinessAdAccount = {
  adAccountId: string;
  adAccountName: string;
  currency: string;
  accountStatus?: number;
};

export type BusinessPage = { pageId: string; pageName: string };

type RawAccount = {
  id?: string;
  account_id?: string;
  name?: string;
  currency?: string;
  account_status?: number;
};

function accountOf(raw: RawAccount): BusinessAdAccount | null {
  const id = raw.id ?? (raw.account_id ? `act_${raw.account_id}` : null);
  if (!id) return null;
  return {
    adAccountId: normalizeAdAccountId(id),
    adAccountName: raw.name ?? id,
    currency: raw.currency ?? "",
    ...(raw.account_status !== undefined
      ? { accountStatus: raw.account_status }
      : {}),
  };
}

// Business uçları: müşterinin kendi hesapları ve paylaşılanlar; business
// kimliği yoksa token'ın gördüğü hesaplar.
export async function listBusinessAdAccounts(
  accessToken: string,
  businessId: string | null,
): Promise<BusinessAdAccount[]> {
  const fields = "id,account_id,name,currency,account_status";
  const read = (edge: string) =>
    requestPages<RawAccount>(
      `${GRAPH_BASE}/${edge}?${new URLSearchParams({ fields, limit: "100", access_token: accessToken })}`,
      { label: edge },
    ).then((page) => page.items);
  const raws = businessId
    ? [
        ...(await read(`${businessId}/owned_ad_accounts`)),
        ...(await read(`${businessId}/client_ad_accounts`).catch(() => [])),
      ]
    : await read("me/adaccounts");
  const seen = new Set<string>();
  const out: BusinessAdAccount[] = [];
  for (const raw of raws) {
    const account = accountOf(raw);
    if (!account || seen.has(account.adAccountId)) continue;
    seen.add(account.adAccountId);
    out.push(account);
  }
  return out;
}

export async function listBusinessPages(
  accessToken: string,
  businessId: string | null,
): Promise<BusinessPage[]> {
  const read = (edge: string) =>
    requestPages<{ id?: string; name?: string }>(
      `${GRAPH_BASE}/${edge}?${new URLSearchParams({ fields: "id,name", limit: "100", access_token: accessToken })}`,
      { label: edge },
    ).then((page) => page.items);
  const raws = businessId
    ? [
        ...(await read(`${businessId}/owned_pages`)),
        ...(await read(`${businessId}/client_pages`).catch(() => [])),
      ]
    : await read("me/accounts");
  const seen = new Set<string>();
  return raws.flatMap((raw) => {
    if (!raw.id || seen.has(raw.id)) return [];
    seen.add(raw.id);
    return [{ pageId: raw.id, pageName: raw.name ?? raw.id }];
  });
}
