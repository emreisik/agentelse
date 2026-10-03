"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { decryptSecret } from "@/server/security/crypto";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  META_PROVIDER,
  META_SERVICE_LABEL,
  MetaApiError,
  fetchMetaAdsInsights,
  parseMetaService,
  verifyFacebookPageAccess,
  verifyInstagramAccess,
  type MetaAdsMetadata,
  type MetaFacebookMetadata,
  type MetaInstagramMetadata,
  type MetaService,
} from "@/server/integrations/meta-client";
import {
  instagramAccessFor,
  resolveInstagramTarget,
} from "@/server/integrations/instagram-target";

export type ActionResult = { ok: true } | { ok: false; message: string };

function describeMetaError(error: unknown): string {
  if (!(error instanceof MetaApiError)) {
    return error instanceof Error ? error.message : "Operation failed";
  }
  // 190 = OAuthException (token expired/revoked) — unlike Google's refresh
  // token, Meta's long-lived tokens don't renew automatically, the user has
  // to reconnect.
  if (error.metaErrorCode === 190) {
    return "Meta: The connection's authorization has become invalid — you need to reconnect.";
  }
  return `Meta: ${error.message}`;
}

function fail(error: unknown): ActionResult {
  return { ok: false, message: describeMetaError(error) };
}

function notFound(service: MetaService): ActionResult {
  return {
    ok: false,
    message: `${META_SERVICE_LABEL[service]} connection not found`,
  };
}

function loadCredential(projectId: string, service: MetaService) {
  return prisma.integrationCredential.findUnique({
    where: {
      projectId_provider: { projectId, provider: META_PROVIDER[service] },
    },
  });
}

// Every action carries `projectId` (+ `service` where the action is shared
// by the integrations) in its form; access is verified before anything is
// read.
async function resolveScope(formData: FormData, fixedService?: MetaService) {
  const projectId = String(formData.get("projectId"));
  const service = fixedService ?? parseMetaService(formData.get("service"));
  if (!service) throw new Error("Invalid Meta service");
  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);
  return { projectId, service, userId, access };
}

// Every integration keeps its own Page selection: Instagram needs one with a
// linked Instagram Business account (its list is already filtered to those),
// Facebook is where organic posts go, Meta Ads uses it as the identity ads run
// as. Changing one never touches the others.
export async function selectMetaPageAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const { projectId, service } = await resolveScope(formData);
    const pageId = String(formData.get("pageId") ?? "").trim();

    const credential = await loadCredential(projectId, service);
    if (!credential) return notFound(service);

    const metadata = (credential.metadata ?? {}) as
      | MetaInstagramMetadata
      | MetaFacebookMetadata
      | MetaAdsMetadata;
    const page = metadata.pages?.find((p) => p.pageId === pageId);
    if (!page) {
      return { ok: false, message: "Invalid Page selection" };
    }

    await prisma.integrationCredential.update({
      where: { id: credential.id },
      data: {
        metadata: {
          ...metadata,
          selectedPageId: page.pageId,
          selectedPageName: page.pageName,
        },
      },
    });

    revalidatePath(`/projects/${projectId}/integrations`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function selectMetaAdAccountAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const { projectId } = await resolveScope(formData, "ads");
    const adAccountId = String(formData.get("adAccountId") ?? "").trim();

    const credential = await loadCredential(projectId, "ads");
    if (!credential) return notFound("ads");

    const metadata = (credential.metadata ?? {}) as MetaAdsMetadata;
    const account = metadata.adAccounts?.find(
      (a) => a.adAccountId === adAccountId,
    );
    if (!account) {
      return { ok: false, message: "Invalid ad account selection" };
    }

    const nextMetadata: MetaAdsMetadata = {
      ...metadata,
      selectedAdAccountId: account.adAccountId,
      selectedAdAccountName: account.adAccountName,
    };
    await prisma.integrationCredential.update({
      where: { id: credential.id },
      data: { metadata: nextMetadata },
    });

    revalidatePath(`/projects/${projectId}/integrations`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

// Performs a real read for the selected Page/ad account by actually using
// the long-lived token against Meta — a fake "connected" state is never
// produced.
export async function testMetaConnectionAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const { projectId, service } = await resolveScope(formData);

    const credential = await loadCredential(projectId, service);
    // A disconnected row keeps its token, but only a new OAuth connection may
    // bring it back: a successful test below would otherwise set it ACTIVE
    // again without the account owner's renewed consent.
    if (!credential || credential.status === "REVOKED") {
      return notFound(service);
    }

    const accessToken = decryptSecret(credential.encryptedSecret);
    let testedAt = new Date().toISOString();
    let testError: string | undefined;
    let nextMetadata:
      | MetaInstagramMetadata
      | MetaFacebookMetadata
      | MetaAdsMetadata;

    try {
      if (service === "instagram") {
        const metadata = (credential.metadata ?? {}) as MetaInstagramMetadata;
        const target = resolveInstagramTarget(metadata);
        if (!target) {
          return {
            ok: false,
            message:
              metadata.login === "instagram"
                ? "No Instagram account is connected"
                : "Select a Page with a linked Instagram account first",
          };
        }
        const access = await instagramAccessFor(target, accessToken);
        const igUsername = await verifyInstagramAccess(
          target.igUserId,
          access.accessToken,
          access.api,
        );
        testedAt = new Date().toISOString();
        nextMetadata = { ...metadata, lastTestResult: { testedAt, igUsername } };
      } else if (service === "facebook") {
        const metadata = (credential.metadata ?? {}) as MetaFacebookMetadata;
        if (!metadata.selectedPageId) {
          return { ok: false, message: "Select a Page first" };
        }
        const pageName = await verifyFacebookPageAccess(
          metadata.selectedPageId,
          accessToken,
        );
        testedAt = new Date().toISOString();
        nextMetadata = { ...metadata, lastTestResult: { testedAt, pageName } };
      } else {
        const metadata = (credential.metadata ?? {}) as MetaAdsMetadata;
        if (!metadata.selectedAdAccountId) {
          return { ok: false, message: "Select an ad account first" };
        }
        const insights = await fetchMetaAdsInsights({
          adAccountId: metadata.selectedAdAccountId,
          accessToken,
        });
        testedAt = new Date().toISOString();
        nextMetadata = {
          ...metadata,
          lastTestResult: { testedAt, adAccountSpend: insights.spend },
        };
      }
    } catch (error) {
      if (error instanceof MetaApiError && error.metaErrorCode === 190) {
        await prisma.integrationCredential.update({
          where: { id: credential.id },
          data: { status: "EXPIRED" },
        });
      }
      testError = describeMetaError(error);
      nextMetadata = {
        ...((credential.metadata ?? {}) as MetaInstagramMetadata &
          MetaFacebookMetadata &
          MetaAdsMetadata),
        lastTestResult: { testedAt, error: testError },
      };
    }

    // A Disconnect that landed while the test ran wins: the row is only
    // written while it is still not REVOKED.
    await prisma.integrationCredential.updateMany({
      where: { id: credential.id, status: { not: "REVOKED" } },
      data: {
        metadata: nextMetadata,
        // An expired token stays EXPIRED; any other failure leaves the
        // status as it was.
        ...(testError ? {} : { status: "ACTIVE" as const }),
      },
    });

    revalidatePath(`/projects/${projectId}/integrations`);
    return testError ? { ok: false, message: testError } : { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function disconnectMetaAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const { projectId, service, userId, access } =
      await resolveScope(formData);

    const credential = await loadCredential(projectId, service);
    if (!credential) return { ok: true };

    await prisma.integrationCredential.update({
      where: { id: credential.id },
      data: { status: "REVOKED" },
    });

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "integration_credential.disconnected",
      entityType: "IntegrationCredential",
      entityId: credential.id,
      metadata: { provider: META_PROVIDER[service] },
    });

    revalidatePath(`/projects/${projectId}/integrations`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
