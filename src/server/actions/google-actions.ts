"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  GOOGLE_PROVIDER,
  GOOGLE_SERVICE_LABEL,
  GoogleApiError,
  fetchGa4PropertyList,
  fetchGa4Report,
  fetchSearchConsoleReport,
  fetchSearchConsoleSiteList,
  parseGoogleService,
  reconcileGa4Selection,
  reconcileSearchConsoleSelection,
  type GoogleAnalyticsMetadata,
  type GoogleSearchConsoleMetadata,
  type GoogleService,
} from "@/server/integrations/google-client";
import { buildGoogleConnectionMetadata } from "@/server/integrations/google-connection-metadata";
import { disconnectGoogleCredential } from "@/server/integrations/google-disconnect";
import { googleErrorUserMessage } from "@/server/integrations/google/error-catalog";
import { getFreshGoogleAccessToken } from "@/server/integrations/google-token";

export type ActionResult = { ok: true } | { ok: false; message: string };

// Kullanıcıya giden metin hata kataloğundan gelir (google/error-catalog.ts);
// katalogda karşılığı olmayan hatada Google'ın kendi mesajı gösterilir.
function describeGoogleError(error: unknown, service?: GoogleService): string {
  if (!(error instanceof GoogleApiError)) {
    return error instanceof Error ? error.message : "Operation failed";
  }
  if (error.googleErrorCode === "access_denied") {
    return "Google: Access denied.";
  }
  const friendly = service
    ? googleErrorUserMessage(error.errorClass, service)
    : null;
  if (friendly) return friendly;
  if (error.googleErrorCode === "invalid_grant") {
    return "Google: The connection's authorization has become invalid — you need to reconnect.";
  }
  return `Google: ${error.message}`;
}

function fail(error: unknown, service?: GoogleService): ActionResult {
  return { ok: false, message: describeGoogleError(error, service) };
}

function notFound(service: GoogleService): ActionResult {
  return {
    ok: false,
    message: `${GOOGLE_SERVICE_LABEL[service]} connection not found`,
  };
}

const MANAGERS_ONLY: ActionResult = {
  ok: false,
  message: "Only workspace owners and admins can change this.",
};

function loadCredential(projectId: string, service: GoogleService) {
  return prisma.integrationCredential.findUnique({
    where: {
      projectId_provider: { projectId, provider: GOOGLE_PROVIDER[service] },
    },
  });
}

// Every action carries `projectId` + `service` in its form; access is
// verified before anything is read.
async function resolveScope(formData: FormData) {
  const projectId = String(formData.get("projectId"));
  const service = parseGoogleService(formData.get("service"));
  if (!service) throw new Error("Invalid Google service");
  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);
  return { projectId, service, userId, access };
}

// İlk seçimi bağlantıyı kuran herkes yapabilir (Connect her üyeye açık);
// zaten seçili mülkü ya da siteyi değiştirmek bütün ekibin raporlarını
// değiştirdiği için yalnız OWNER/ADMIN'e açıktır (GK6).
async function canChangeSelection(
  current: string | undefined,
  next: string,
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  if (!current || current === next) return true;
  return isWorkspaceManager(userId, workspaceId);
}

export async function selectGa4PropertyAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const propertyId = String(formData.get("propertyId") ?? "").trim();
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const credential = await loadCredential(projectId, "analytics");
    if (!credential || credential.status === "REVOKED") {
      return notFound("analytics");
    }

    const metadata = (credential.metadata ?? {}) as GoogleAnalyticsMetadata;
    const property = metadata.ga4Properties?.find(
      (p) => p.propertyId === propertyId,
    );
    if (!property) {
      return { ok: false, message: "Invalid GA4 property selection" };
    }
    if (
      !(await canChangeSelection(
        metadata.selectedGa4PropertyId,
        property.propertyId,
        userId,
        access.workspaceId,
      ))
    ) {
      return MANAGERS_ONLY;
    }

    const nextMetadata: GoogleAnalyticsMetadata = {
      ...metadata,
      selectedGa4PropertyId: property.propertyId,
      selectedGa4PropertyName: property.propertyName,
    };
    await prisma.integrationCredential.updateMany({
      where: { id: credential.id, status: { not: "REVOKED" } },
      data: { metadata: nextMetadata },
    });

    revalidatePath(`/projects/${projectId}/integrations`);
    return { ok: true };
  } catch (error) {
    return fail(error, "analytics");
  }
}

export async function selectSearchConsoleSiteAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const siteUrl = String(formData.get("siteUrl") ?? "").trim();
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const credential = await loadCredential(projectId, "search_console");
    if (!credential || credential.status === "REVOKED") {
      return notFound("search_console");
    }

    const metadata = (credential.metadata ?? {}) as GoogleSearchConsoleMetadata;
    const site = metadata.searchConsoleSites?.find(
      (s) => s.siteUrl === siteUrl,
    );
    if (!site) {
      return { ok: false, message: "Invalid Search Console site selection" };
    }
    if (
      !(await canChangeSelection(
        metadata.selectedSearchConsoleSite,
        site.siteUrl,
        userId,
        access.workspaceId,
      ))
    ) {
      return MANAGERS_ONLY;
    }

    const nextMetadata: GoogleSearchConsoleMetadata = {
      ...metadata,
      selectedSearchConsoleSite: site.siteUrl,
    };
    await prisma.integrationCredential.updateMany({
      where: { id: credential.id, status: { not: "REVOKED" } },
      data: { metadata: nextMetadata },
    });

    revalidatePath(`/projects/${projectId}/integrations`);
    return { ok: true };
  } catch (error) {
    return fail(error, "search_console");
  }
}

// Performs a real read for the selected property/site by actually using the
// refresh token against Google — a fake "connected" state is never produced.
export async function testGoogleConnectionAction(
  formData: FormData,
): Promise<ActionResult> {
  let service: GoogleService | undefined;
  try {
    const scope = await resolveScope(formData);
    service = scope.service;
    const { projectId } = scope;

    const credential = await loadCredential(projectId, service);
    // Koparılmış (REVOKED) bağlantı geri gelmez: bağlantıyı yalnız yeni bir
    // OAuth bağlantısı geri getirebilir (meta-actions.ts ile aynı kural).
    if (!credential || credential.status === "REVOKED") {
      return notFound(service);
    }

    let testError: string | undefined;
    let nextMetadata: GoogleAnalyticsMetadata | GoogleSearchConsoleMetadata;

    if (service === "analytics") {
      const metadata = (credential.metadata ?? {}) as GoogleAnalyticsMetadata;
      if (!metadata.selectedGa4PropertyId) {
        return { ok: false, message: "Select a GA4 property first" };
      }
      const accessToken = await getFreshGoogleAccessToken(credential);
      const result: NonNullable<GoogleAnalyticsMetadata["lastTestResult"]> = {
        testedAt: new Date().toISOString(),
      };
      try {
        const ga4 = await fetchGa4Report(
          accessToken,
          metadata.selectedGa4PropertyId,
        );
        result.ga4ActiveUsers = ga4.activeUsers;
      } catch (error) {
        result.error = describeGoogleError(error, service);
      }
      testError = result.error;
      nextMetadata = { ...metadata, lastTestResult: result };
    } else {
      const metadata = (credential.metadata ??
        {}) as GoogleSearchConsoleMetadata;
      if (!metadata.selectedSearchConsoleSite) {
        return { ok: false, message: "Select a Search Console site first" };
      }
      const accessToken = await getFreshGoogleAccessToken(credential);
      const result: NonNullable<GoogleSearchConsoleMetadata["lastTestResult"]> =
        { testedAt: new Date().toISOString() };
      try {
        const gsc = await fetchSearchConsoleReport(
          accessToken,
          metadata.selectedSearchConsoleSite,
        );
        result.gscClicks = gsc.clicks;
        result.gscImpressions = gsc.impressions;
      } catch (error) {
        result.error = describeGoogleError(error, service);
      }
      testError = result.error;
      nextMetadata = { ...metadata, lastTestResult: result };
    }

    // Yalnız satır hâlâ REVOKED değilken yazılır: test sürerken gelen bir
    // Disconnect kazanır.
    await prisma.integrationCredential.updateMany({
      where: { id: credential.id, status: { not: "REVOKED" } },
      data: { metadata: nextMetadata, status: "ACTIVE" },
    });

    revalidatePath(`/projects/${projectId}/integrations`);
    return testError ? { ok: false, message: testError } : { ok: true };
  } catch (error) {
    return fail(error, service);
  }
}

// Re-fetches the GA4 property / Search Console site list against Google —
// this is the only way to update after connecting if a new property/site
// was added on Google's side (or access was removed) without going through
// OAuth again.
export async function refreshGoogleListsAction(
  formData: FormData,
): Promise<ActionResult> {
  let service: GoogleService | undefined;
  try {
    const scope = await resolveScope(formData);
    service = scope.service;
    const { projectId } = scope;

    const credential = await loadCredential(projectId, service);
    // Test eylemindeki kuralın aynısı: koparılmış bağlantı liste yenilemeyle
    // geri gelmez.
    if (!credential || credential.status === "REVOKED") {
      return notFound(service);
    }

    const accessToken = await getFreshGoogleAccessToken(credential);

    let listError: string | undefined;
    let nextMetadata: GoogleAnalyticsMetadata | GoogleSearchConsoleMetadata;
    if (service === "analytics") {
      const existing = (credential.metadata ?? {}) as GoogleAnalyticsMetadata;
      const lists = await fetchGa4PropertyList(accessToken);
      listError = lists.ga4ListError;
      nextMetadata = {
        ...existing,
        ga4ListError: undefined,
        ...lists,
        ...reconcileGa4Selection(existing, lists),
      };
    } else {
      const existing = (credential.metadata ??
        {}) as GoogleSearchConsoleMetadata;
      const lists = await fetchSearchConsoleSiteList(accessToken);
      listError = lists.gscListError;
      nextMetadata = {
        ...existing,
        gscListError: undefined,
        ...lists,
        ...reconcileSearchConsoleSelection(existing, lists),
      };
    }

    await prisma.integrationCredential.updateMany({
      where: { id: credential.id, status: { not: "REVOKED" } },
      data: { metadata: nextMetadata, status: "ACTIVE" },
    });

    revalidatePath(`/projects/${projectId}/integrations`);
    return listError ? { ok: false, message: listError } : { ok: true };
  } catch (error) {
    return fail(error, service);
  }
}

// "Use existing connection" (GK5): aynı workspace'te başka bir projede bağlı
// olan Google hesabını OAuth'a gitmeden bu projeye bağlar; şifreli refresh
// token kopyalanır (google-reuse.ts). Bir Google hesabının erişimini başka
// projeye taşıdığı için yalnız OWNER/ADMIN. Seçim kaynaktan kopyalanmaz: her
// proje kendi mülkünü ya da sitesini seçer.
export async function reuseGoogleConnectionAction(
  formData: FormData,
): Promise<ActionResult> {
  let service: GoogleService | undefined;
  try {
    const scope = await resolveScope(formData);
    service = scope.service;
    const { projectId, userId, access } = scope;
    if (!(await isWorkspaceManager(userId, access.workspaceId))) {
      return MANAGERS_ONLY;
    }

    const provider = GOOGLE_PROVIDER[service];
    const sourceId = String(formData.get("sourceCredentialId") ?? "");
    const source = sourceId
      ? await prisma.integrationCredential.findUnique({
          where: { id: sourceId },
        })
      : null;
    if (
      !source ||
      source.workspaceId !== access.workspaceId ||
      source.provider !== provider ||
      source.status !== "ACTIVE" ||
      !source.encryptedSecret ||
      source.projectId === projectId
    ) {
      return { ok: false, message: "That connection can't be used here." };
    }

    // Canlı bağlantının üzerine yazılmaz: önce Disconnect. Bu projede daha
    // önce kopmuş ya da süresi dolmuş bir bağlantı varsa erişilebilen seçimi
    // ve tarama kayıtları korunur (OAuth dönüşü gibi).
    const existing = await loadCredential(projectId, service);
    if (existing?.status === "ACTIVE") {
      return {
        ok: false,
        message: `${GOOGLE_SERVICE_LABEL[service]} is already connected here. Disconnect it first.`,
      };
    }

    // Token hâlâ geçerli mi; geçersizse kaynak EXPIRED olur ve hata döner.
    const accessToken = await getFreshGoogleAccessToken(source);
    const identity = (source.metadata ?? {}) as {
      connectedEmail?: string;
      googleSub?: string;
    };
    const metadata = await buildGoogleConnectionMetadata(
      service,
      accessToken,
      {
        connectedEmail: identity.connectedEmail,
        googleSub: identity.googleSub,
      },
      (existing?.metadata ?? {}) as Record<string, unknown>,
    );

    const credential = await prisma.integrationCredential.upsert({
      where: { projectId_provider: { projectId, provider } },
      create: {
        workspaceId: access.workspaceId,
        projectId,
        brandId: access.defaultBrandId,
        provider,
        accountLabel: source.accountLabel,
        encryptedSecret: source.encryptedSecret,
        metadata,
        status: "ACTIVE",
      },
      update: {
        accountLabel: source.accountLabel,
        encryptedSecret: source.encryptedSecret,
        metadata,
        status: "ACTIVE",
      },
    });

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "integration_credential.connected",
      entityType: "IntegrationCredential",
      entityId: credential.id,
      metadata: { provider, reusedFromCredentialId: source.id },
    });

    revalidatePath(`/projects/${projectId}/integrations`);
    return { ok: true };
  } catch (error) {
    return fail(error, service);
  }
}

// Bağlantıyı koparır: refresh token ve Google'dan gelen veriler hemen silinir,
// Google'da iptal yalnız aynı Google hesabının başka canlı Agentelse bağlantısı
// yoksa yapılır (google-disconnect.ts). Bütün ekibi etkilediği için yalnız
// OWNER/ADMIN (GK6).
export async function disconnectGoogleAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const { projectId, service, userId, access } = await resolveScope(formData);
    if (!(await isWorkspaceManager(userId, access.workspaceId))) {
      return MANAGERS_ONLY;
    }

    const credential = await loadCredential(projectId, service);
    // Bu değişiklikten önce koparılmış satırlar token'ı hâlâ tutuyor olabilir;
    // onlar da temizlenir.
    if (
      !credential ||
      (credential.status === "REVOKED" && !credential.encryptedSecret)
    ) {
      return { ok: true };
    }

    const { revokedAtGoogle } = await disconnectGoogleCredential(credential);

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "integration_credential.disconnected",
      entityType: "IntegrationCredential",
      entityId: credential.id,
      metadata: { provider: GOOGLE_PROVIDER[service], revokedAtGoogle },
    });

    revalidatePath(`/projects/${projectId}/integrations`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
