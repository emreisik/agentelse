import "server-only";

import type { CmsSite, IntegrationCredential, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  CONNECT_ERROR_MESSAGES,
  SEO_CHANGE_ERROR_MESSAGES,
  WP_HEALTH_LABEL,
} from "@/lib/seo/apply/copy";
import { applyMockMode, seoApplyEnabledFor } from "@/lib/seo/apply/flags";
import { normalizeAppPassword, normalizeUsername } from "@/lib/seo/apply/validate";
import type {
  ConnectErrorCode,
  SeoFieldsCapability,
  WpCapabilities,
  WpHealth,
} from "@/lib/seo/apply/types";
import type { WpIndex, WpMe } from "@/lib/seo/apply/wp/wp-types";
import { deriveWpCapabilities, isAdministrator } from "@/lib/seo/apply/wp/capabilities";
import { detectSeoPlugin, probeSeoFields } from "@/lib/seo/apply/wp/plugin-fields";
import type { WordPressConnectionView } from "@/lib/seo/apply/view-types";
import { inScope } from "@/lib/seo/crawl-url";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { cleanupSeoApplyForSite } from "@/server/seo/apply/cleanup";
import { SeoSites } from "@/server/seo/site/sites";

import { createWordPressClient, type WordPressClient } from "./client";
import {
  getWordPressClientFor,
  loadCmsSite,
  providerFor,
  WORDPRESS_KIND,
} from "./connection";
import { WordPressApiError } from "./errors";
import { classifyConnection, type ConnectionReason } from "./health";
import { sealWordPressSecret } from "./secret";
import { wpTransportFor, type WpTransport } from "./transport";

// WordPress bağlantısının yaşam döngüsü (docs/wordpress-plan.md): bağla, sına,
// yeniden bağla (rebind), kopar ve Connectors'taki görünüm. Yalnız eylemler ve
// Connectors sayfası içe aktarır; işçi grafiği connection.ts'i kullanır.
// Şifre hiçbir yerde loglanmaz, metadata'ya yazılmaz, hiçbir görünümde dönmez.

export type ConnectInput = {
  projectId: string;
  workspaceId: string;
  brandId: string;
  userId: string;
  siteUrl: string;
  username: string;
  appPassword: string;
};

type Failure = { ok: false; code: ConnectErrorCode; message: string };
type ConnectResult = { ok: true; view: WordPressConnectionView } | Failure;

type Deps = {
  transport?: WpTransport;
  now?: Date;
  pace?: (host: string) => Promise<void>;
};

const REVOKE_TIMEOUT_MS = 8_000;

function fail(code: ConnectErrorCode, message?: string): Failure {
  return { ok: false, code, message: message ?? CONNECT_ERROR_MESSAGES[code] };
}

function logFailure(step: string, error: unknown): void {
  console.error(
    `[wordpress] ${step} failed:`,
    error instanceof Error ? error.name : "unknown",
  );
}

// --- adres ---------------------------------------------------------------------

export function normalizeSiteUrl(
  raw: string,
): { ok: true; origin: string; host: string } | { ok: false; code: ConnectErrorCode } {
  const text = raw.trim();
  if (!text || text.length > 255) return { ok: false, code: "invalid_url" };
  if (/^http:\/\//i.test(text)) return { ok: false, code: "not_https" };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https:\/\//i.test(text)) {
    return { ok: false, code: "invalid_url" };
  }
  let url: URL;
  try {
    url = new URL(/^https:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, code: "invalid_url" };
  }
  if (url.username || url.password) return { ok: false, code: "invalid_url" };
  if (url.port && url.port !== "443") return { ok: false, code: "invalid_url" };
  const host = url.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) {
    return { ok: false, code: "invalid_url" };
  }
  if (host === "wordpress.com" || host.endsWith(".wordpress.com")) {
    return { ok: false, code: "wordpress_com" };
  }
  // Alt klasör kurulumu (https://site.com/blog) v1'de desteklenmez.
  if (url.pathname.replace(/\/+$/, "") !== "") {
    return { ok: false, code: "subfolder" };
  }
  return { ok: true, origin: `https://${host}`, host };
}

// --- görünüm ---------------------------------------------------------------------

const REASON_TEXT: Record<ConnectionReason, string> = {
  domain_mismatch: SEO_CHANGE_ERROR_MESSAGES.domain_mismatch,
  scope_changed: SEO_CHANGE_ERROR_MESSAGES.scope_changed,
  reconnect: SEO_CHANGE_ERROR_MESSAGES.reconnect,
  rest_blocked: CONNECT_ERROR_MESSAGES.rest_blocked,
  not_wordpress: CONNECT_ERROR_MESSAGES.not_wordpress,
  unreachable: CONNECT_ERROR_MESSAGES.unreachable,
  no_edit_rights: CONNECT_ERROR_MESSAGES.no_edit_rights,
  limited: "This WordPress user can make some changes but not all of them.",
};

const HEALTHS = Object.keys(WP_HEALTH_LABEL) as WpHealth[];

function healthOf(value: string): WpHealth {
  return (HEALTHS as string[]).includes(value) ? (value as WpHealth) : "UNKNOWN";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CAPABILITY_KEYS: (keyof WpCapabilities)[] = [
  "draftPosts",
  "publishPosts",
  "editPublishedPosts",
  "editPages",
  "editPublishedPages",
  "editOthers",
  "deletePosts",
];

function capabilitiesOf(value: unknown): WpCapabilities | null {
  if (!isRecord(value)) return null;
  const caps = {} as WpCapabilities;
  for (const key of CAPABILITY_KEYS) {
    caps[key] = value[key] === true;
  }
  return caps;
}

function fieldsOf(value: unknown): SeoFieldsCapability | null {
  if (!isRecord(value)) return null;
  const plugin =
    value.plugin === "YOAST" || value.plugin === "RANK_MATH" ? value.plugin : "NONE";
  const titleVia =
    value.titleVia === "META" || value.titleVia === "RANKMATH_ENDPOINT"
      ? value.titleVia
      : "POST_TITLE";
  const descriptionVia =
    value.descriptionVia === "META" || value.descriptionVia === "RANKMATH_ENDPOINT"
      ? value.descriptionVia
      : "NONE";
  return { plugin, titleVia, descriptionVia, verifiable: value.verifiable === true };
}

function adminFlagOf(metadata: unknown): boolean {
  return isRecord(metadata) && metadata.administrator === true;
}

export function notConnectedView(canManage: boolean): WordPressConnectionView {
  return {
    connected: false,
    siteId: null,
    origin: null,
    host: null,
    accountLabel: null,
    health: "UNKNOWN",
    healthLabel: WP_HEALTH_LABEL.UNKNOWN,
    healthReason: null,
    seoPlugin: "NONE",
    descriptionWritable: false,
    capabilities: null,
    lastCheckedAt: null,
    canManage,
    adminWarning: false,
    canRebind: false,
  };
}

function viewOf(
  site: CmsSite,
  credential: Pick<IntegrationCredential, "accountLabel" | "metadata"> | null,
  ctx: { canManage: boolean; scopeKey: string | null | undefined },
): WordPressConnectionView {
  const health = healthOf(site.health);
  const fields = fieldsOf(site.seoFields);
  const plugin =
    site.seoPlugin === "YOAST" || site.seoPlugin === "RANK_MATH" ? site.seoPlugin : "NONE";
  let host: string | null = null;
  try {
    host = new URL(site.origin).host;
  } catch {
    host = null;
  }
  const reason = site.healthReason as ConnectionReason | null;
  return {
    connected: true,
    siteId: site.id,
    origin: site.origin,
    host,
    accountLabel: credential?.accountLabel ?? null,
    health,
    healthLabel: WP_HEALTH_LABEL[health],
    healthReason: reason ? (REASON_TEXT[reason] ?? null) : null,
    seoPlugin: plugin,
    descriptionWritable: fields ? fields.descriptionVia !== "NONE" : false,
    capabilities: capabilitiesOf(site.capabilities),
    lastCheckedAt: site.lastCheckedAt ? site.lastCheckedAt.toISOString() : null,
    canManage: ctx.canManage,
    adminWarning: adminFlagOf(credential?.metadata),
    canRebind:
      health === "DOMAIN_MISMATCH" ||
      (ctx.scopeKey !== undefined && ctx.scopeKey !== null && site.scopeKey !== ctx.scopeKey),
  };
}

// OWNER/ADMIN denetimi: işçi grafiğine girmesin diye tenant-context yerine
// doğrudan sorgu (Telegram sahte kullanıcıları "id:..." biçimindedir, sorgusuz reddedilir).
async function isManagerOf(projectId: string, userId: string): Promise<boolean> {
  if (!userId || userId.includes(":")) return false;
  const member = await prisma.workspaceMember.findFirst({
    where: { userId, workspace: { projects: { some: { id: projectId } } } },
    select: { role: true },
  });
  return member?.role === "OWNER" || member?.role === "ADMIN";
}

export async function loadWordPressConnectionView(
  projectId: string,
  userId: string,
): Promise<WordPressConnectionView | null> {
  // Bayrak kapalıyken hiçbir sorgu çalışmaz.
  if (!seoApplyEnabledFor(projectId)) return null;
  const [site, canManage] = await Promise.all([
    loadCmsSite(projectId),
    isManagerOf(projectId, userId),
  ]);
  if (!site) return notConnectedView(canManage);
  const [credential, state] = await Promise.all([
    prisma.integrationCredential.findUnique({
      where: {
        projectId_provider: { projectId, provider: providerFor(site.isMock) },
      },
      select: { accountLabel: true, metadata: true },
    }),
    SeoSites.readState(projectId),
  ]);
  return viewOf(site, credential, {
    canManage,
    scopeKey: state?.scope ? state.scope.key : null,
  });
}

// --- hata eşleme -------------------------------------------------------------------

function discoverFailure(error: unknown): Failure {
  if (!(error instanceof WordPressApiError)) {
    logFailure("discover", error);
    return fail("unknown");
  }
  switch (error.errorClass) {
    case "REDIRECT":
      return fail("domain_mismatch");
    case "NOT_FOUND":
    case "NOT_WORDPRESS":
      return fail("not_wordpress");
    case "REST_DISABLED":
      return fail("rest_blocked");
    default:
      return fail("unreachable");
  }
}

function meFailure(error: unknown): Failure {
  if (!(error instanceof WordPressApiError)) {
    logFailure("me", error);
    return fail("unknown");
  }
  switch (error.errorClass) {
    case "AUTH":
      return fail("bad_credentials");
    case "APP_PASSWORDS_DISABLED":
      return fail("app_passwords_disabled");
    case "FORBIDDEN":
      return fail("no_edit_rights");
    case "REST_DISABLED":
    case "REDIRECT":
      return fail("rest_blocked");
    case "NOT_WORDPRESS":
    case "NOT_FOUND":
      return fail("not_wordpress");
    default:
      return fail("unreachable");
  }
}

async function probeFields(
  client: WordPressClient,
  index: WpIndex,
): Promise<SeoFieldsCapability> {
  let metaKeys: string[] = [];
  try {
    metaKeys = await client.probeMetaKeys();
  } catch (error) {
    // Yoklama başarısızsa eklenti alanları "gizli" sayılır (güvenli taraf).
    logFailure("meta probe", error);
  }
  return probeSeoFields(detectSeoPlugin(index.namespaces), {
    metaKeys,
    namespaces: index.namespaces,
  });
}

// --- bağla ---------------------------------------------------------------------------

// Yazma sürerken bağlantı değiştirilmez/koparılmaz: kimlik yarı yolda silinmesin.
// İlk yazmadan sonra satır APPLIED kalır ve kira sürer (ikinci yazma + geri okuma),
// bu yüzden APPLIED da sayılır; kira süresi dolmuş satırı uzlaştırıcı toparlar.
async function hasWriteInFlight(siteId: string, now: Date): Promise<boolean> {
  const count = await prisma.seoChange.count({
    where: {
      siteId,
      status: { in: ["APPLYING", "APPLIED", "UNDOING"] },
      leaseUntil: { gt: now },
    },
  });
  return count > 0;
}

async function resetSiteRows(site: CmsSite): Promise<void> {
  try {
    await cleanupSeoApplyForSite(site.id);
  } catch (error) {
    logFailure("cleanup", error);
  }
  await prisma.cmsSite.deleteMany({ where: { id: site.id } });
}

export async function connectWordPress(
  input: ConnectInput,
  deps: Deps = {},
): Promise<ConnectResult> {
  if (!seoApplyEnabledFor(input.projectId)) return fail("not_allowed");

  const username = normalizeUsername(input.username);
  const appPassword = normalizeAppPassword(input.appPassword);
  if (!username || !appPassword) return fail("invalid_input");

  const url = normalizeSiteUrl(input.siteUrl);
  if (!url.ok) return fail(url.code);

  const state = await SeoSites.readState(input.projectId);
  const scope = state?.scope ?? null;
  if (!scope) return fail("no_verified_site");
  // Kapsam dışı adrese hiç istek atılmaz.
  if (!inScope(`${url.origin}/`, scope)) return fail("domain_mismatch");

  const mock = applyMockMode();
  const now = deps.now ?? new Date();
  const client = createWordPressClient({
    origin: url.origin,
    restMode: "pretty",
    credentials: { username, appPassword },
    transport: deps.transport ?? wpTransportFor(mock),
    ...(deps.pace ? { pace: deps.pace } : {}),
    inScope: (candidate) => inScope(candidate, scope),
  });

  let index: WpIndex;
  try {
    index = await client.discover();
  } catch (error) {
    return discoverFailure(error);
  }
  const origin = client.lastOrigin();
  const pinned = normalizeSiteUrl(origin);
  if (!pinned.ok) {
    return fail(pinned.code === "wordpress_com" ? "wordpress_com" : "domain_mismatch");
  }
  if (!inScope(`${origin}/`, scope)) return fail("domain_mismatch");
  if (!index.appPasswords) return fail("app_passwords_disabled");

  let me: WpMe;
  try {
    me = await client.me();
  } catch (error) {
    return meFailure(error);
  }
  const capabilities = deriveWpCapabilities(me);
  if (!capabilities.draftPosts) return fail("no_edit_rights");

  const fields = await probeFields(client, index);
  const administrator = isAdministrator(me);
  const { health, reason } = classifyConnection({
    capabilities,
    error: null,
    domainOk: true,
    scopeOk: true,
  });

  const sealed = sealWordPressSecret({ username, appPassword });
  const provider = providerFor(mock);
  const metadata = {
    keyId: sealed.keyId,
    origin,
    administrator,
  };
  const accountLabel = `${username} @ ${pinned.host}`;

  // Aynı sitenin yeniden bağlanması SeoChange satırlarını korur; başka bir
  // siteye bağlanılırsa eski sitenin kimlikleri yeni sitede anlamsızdır ve
  // açık değişiklikler yanlış yazıya gidebilir: eski site temizlenip silinir.
  const existing = await loadCmsSite(input.projectId, { mock });
  if (existing && existing.origin !== origin) {
    if (await hasWriteInFlight(existing.id, now)) return fail("busy");
    await resetSiteRows(existing);
  }

  const credential = await prisma.integrationCredential.upsert({
    where: { projectId_provider: { projectId: input.projectId, provider } },
    create: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      provider,
      accountLabel,
      encryptedSecret: sealed.encryptedSecret,
      metadata,
      status: "ACTIVE",
    },
    update: {
      accountLabel,
      encryptedSecret: sealed.encryptedSecret,
      metadata,
      status: "ACTIVE",
    },
  });

  const siteData = {
    credentialId: credential.id,
    origin,
    restMode: client.lastRestMode?.() ?? "pretty",
    siteName: index.name,
    scopeKey: scope.key,
    seoPlugin: fields.plugin,
    seoFields: fields as unknown as Prisma.InputJsonValue,
    capabilities: capabilities as unknown as Prisma.InputJsonValue,
    health,
    healthReason: reason,
    lastCheckedAt: now,
    lastError: null,
  };
  const site = await prisma.cmsSite.upsert({
    where: {
      projectId_kind_isMock: {
        projectId: input.projectId,
        kind: WORDPRESS_KIND,
        isMock: mock,
      },
    },
    create: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      isMock: mock,
      kind: WORDPRESS_KIND,
      ...siteData,
    },
    update: siteData,
  });

  await AuditLogRepository.record({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    brandId: input.brandId,
    actorType: "USER",
    actorId: input.userId,
    action: "integration_credential.connected",
    entityType: "IntegrationCredential",
    entityId: credential.id,
    metadata: { provider },
  });

  return {
    ok: true,
    view: viewOf(site, { accountLabel, metadata }, { canManage: true, scopeKey: scope.key }),
  };
}

// --- sına / yeniden bağla ----------------------------------------------------------

const HEALTH_FAILURE: Partial<Record<WpHealth, ConnectErrorCode>> = {
  AUTH: "bad_credentials",
  REST_BLOCKED: "rest_blocked",
  NOT_WORDPRESS: "not_wordpress",
  UNREACHABLE: "unreachable",
  NO_PERMISSION: "no_edit_rights",
  DOMAIN_MISMATCH: "domain_mismatch",
};

export async function testWordPress(
  projectId: string,
  options: { rebind?: boolean; userId?: string; isManager?: boolean } = {},
  deps: Deps = {},
): Promise<ConnectResult> {
  if (!seoApplyEnabledFor(projectId)) {
    return fail("unknown", SEO_CHANGE_ERROR_MESSAGES.not_enabled);
  }
  const mock = applyMockMode();
  const site = await loadCmsSite(projectId, { mock });
  if (!site) {
    return fail("unknown", "WordPress is not connected for this project.");
  }
  const canManage = options.isManager === true;
  const rebind = options.rebind === true;
  if (rebind && !canManage) return fail("not_allowed");

  const now = deps.now ?? new Date();
  const state = await SeoSites.readState(projectId);
  const scope = state?.scope ?? null;
  const domainOk = scope !== null && inScope(`${site.origin}/`, scope);
  // Yeniden bağlama (yalnız yönetici): kapsam anahtarı güncel kapsamla yenilenir.
  const scopeOk = scope !== null && (rebind ? domainOk : site.scopeKey === scope.key);
  const nextScopeKey = rebind && scope && domainOk ? scope.key : site.scopeKey;

  let capabilities: WpCapabilities | null = null;
  let fields: SeoFieldsCapability | null = null;
  let restMode: "pretty" | "query" = site.restMode === "query" ? "query" : "pretty";
  let administrator: boolean | null = null;
  let error: WordPressApiError | null = null;

  const client = domainOk ? await getWordPressClientFor(site, deps) : null;
  if (domainOk && !client) {
    // Kimlik yok ya da açılamıyor: yeniden bağlanmak gerekir.
    error = new WordPressApiError("AUTH");
  } else if (client) {
    try {
      const index = await client.discover();
      restMode = client.lastRestMode?.() ?? restMode;
      const me = await client.me();
      capabilities = deriveWpCapabilities(me);
      administrator = isAdministrator(me);
      fields = await probeFields(client, index);
    } catch (caught) {
      if (caught instanceof WordPressApiError) error = caught;
      else {
        logFailure("test", caught);
        error = new WordPressApiError("TRANSIENT");
      }
    }
  }

  const { health, reason } = classifyConnection({
    capabilities,
    error,
    domainOk,
    scopeOk,
  });

  const updated = await prisma.cmsSite.update({
    where: { id: site.id },
    data: {
      health,
      healthReason: reason,
      lastCheckedAt: now,
      lastError: error ? error.errorClass : null,
      scopeKey: nextScopeKey,
      ...(capabilities
        ? { capabilities: capabilities as unknown as Prisma.InputJsonValue }
        : {}),
      ...(fields
        ? {
            seoPlugin: fields.plugin,
            seoFields: fields as unknown as Prisma.InputJsonValue,
            restMode,
          }
        : {}),
    },
  });

  const credential = await prisma.integrationCredential.findUnique({
    where: {
      projectId_provider: { projectId, provider: providerFor(site.isMock) },
    },
    select: { id: true, accountLabel: true, metadata: true },
  });
  if (credential && administrator !== null) {
    await prisma.integrationCredential.update({
      where: { id: credential.id },
      data: {
        metadata: {
          ...(isRecord(credential.metadata) ? credential.metadata : {}),
          administrator,
        } as Prisma.InputJsonValue,
      },
    });
  }

  const view = viewOf(
    updated,
    credential
      ? {
          accountLabel: credential.accountLabel,
          metadata: {
            ...(isRecord(credential.metadata) ? credential.metadata : {}),
            ...(administrator !== null ? { administrator } : {}),
          },
        }
      : null,
    { canManage, scopeKey: scope ? scope.key : null },
  );

  const code = HEALTH_FAILURE[health];
  if (code) {
    // Kapsam anahtarı değişmişse metin "yeniden denetle" der, adres uyumsuzluğu değil.
    if (reason === "scope_changed") {
      return fail("domain_mismatch", SEO_CHANGE_ERROR_MESSAGES.scope_changed);
    }
    if (reason === "reconnect") {
      return fail("bad_credentials", SEO_CHANGE_ERROR_MESSAGES.reconnect);
    }
    return fail(code);
  }
  return { ok: true, view };
}

// --- kopar ---------------------------------------------------------------------------

function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    run().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// Application Password'ü WordPress tarafında iptal etmeyi dener (en iyi çaba, 8 sn).
async function tryRevoke(site: CmsSite, deps: Deps): Promise<void> {
  try {
    const client = await getWordPressClientFor(site, deps);
    if (!client) return;
    await withTimeout(async () => {
      const info = await client.introspectAppPassword();
      if (info) await client.revokeAppPassword(info.uuid);
    }, REVOKE_TIMEOUT_MS);
  } catch (error) {
    logFailure("revoke", error);
  }
}

export async function disconnectWordPress(
  input: { projectId: string; workspaceId: string; userId: string },
  deps: Deps = {},
): Promise<{ ok: true } | { ok: false; code: "busy"; message: string }> {
  const mock = applyMockMode();
  const provider = providerFor(mock);
  const now = deps.now ?? new Date();
  const site = await loadCmsSite(input.projectId, { mock });

  if (site) {
    if (await hasWriteInFlight(site.id, now)) {
      return { ok: false, code: "busy", message: CONNECT_ERROR_MESSAGES.busy };
    }
    await tryRevoke(site, deps);
    try {
      await cleanupSeoApplyForSite(site.id);
    } catch (error) {
      logFailure("cleanup", error);
    }
    await prisma.cmsSite.deleteMany({ where: { id: site.id } });
  }

  const credential = await prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId: input.projectId, provider } },
    select: { id: true },
  });
  await prisma.integrationCredential.deleteMany({
    where: { projectId: input.projectId, provider },
  });
  await prisma.seoApplySetting.updateMany({
    where: { projectId: input.projectId },
    data: {
      indexNowEnabled: false,
      indexNowKey: null,
      indexNowHost: null,
      indexNowVerifiedAt: null,
      indexNowLastPingAt: null,
    },
  });

  if (site || credential) {
    await AuditLogRepository.record({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      actorType: "USER",
      actorId: input.userId,
      action: "integration_credential.disconnected",
      entityType: "IntegrationCredential",
      entityId: credential?.id ?? site?.credentialId ?? input.projectId,
      metadata: { provider },
    });
  }
  return { ok: true };
}
