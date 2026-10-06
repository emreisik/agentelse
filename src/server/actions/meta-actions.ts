"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { ensureAdsAccountRow } from "@/server/ads/accounts";
import { AdsInsurance } from "@/server/ads/insurance";
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
  revokeMetaPermission,
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

    // Key by key (jsonb_set): a whole-object write would put back what a
    // scan or another tab changed meanwhile (docs/meta-ads-plan.md F1).
    await writeMetadataKeys(credential.id, {
      selectedPageId: page.pageId,
      selectedPageName: page.pageName,
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

    // A closed or disabled account cannot run ads: it is not picked.
    if (account.accountStatus !== undefined && account.accountStatus !== 1) {
      return {
        ok: false,
        message:
          "This ad account can't run ads right now (closed or disabled in Meta). Pick another one.",
      };
    }
    await writeMetadataKeys(credential.id, {
      selectedAdAccountId: account.adAccountId,
      selectedAdAccountName: account.adAccountName,
    });
    // The account model follows the choice (src/server/ads/accounts.ts).
    await ensureAdsAccountRow({
      workspaceId: credential.workspaceId,
      projectId,
      brandId: credential.brandId,
      credentialId: credential.id,
      externalId: account.adAccountId,
      name: account.adAccountName,
      currency: account.currency,
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

    // Agentelse safety rules (Ad Rules, F7) are removed first, while the
    // token still works; one that can't be removed is listed on /health.
    if (service === "ads" && credential.encryptedSecret) {
      await AdsInsurance.removeForProject(
        projectId,
        decryptSecret(credential.encryptedSecret),
      ).catch((error: unknown) => {
        console.error(
          "[meta-actions] safety rules could not be removed:",
          error instanceof Error ? error.message : error,
        );
      });
    }

    // Meta Ads (K18): only the ads permissions are taken back at Meta, and
    // only when this person has no other active Meta Ads connection. Meta
    // keeps one grant per person and app, so a full revoke would cut their
    // Facebook and Instagram connections too.
    const revokedAtMeta =
      service === "ads" ? await revokeAdsPermissions(credential) : false;

    // For Meta Ads our side forgets the token at once, with the account choice
    // and the scan's numbers. The row stays REVOKED so the tile can say
    // what was connected.
    await prisma.integrationCredential.update({
      where: { id: credential.id },
      data: {
        status: "REVOKED",
        ...(service === "ads" ? { encryptedSecret: "" } : {}),
      },
    });
    if (service === "ads") {
      await deleteMetadataKeys(credential.id, ADS_METADATA_KEYS);
      await prisma.adsAccountProject
        .deleteMany({ where: { projectId } })
        .catch(() => undefined);
    }

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "integration_credential.disconnected",
      entityType: "IntegrationCredential",
      entityId: credential.id,
      metadata: {
        provider: META_PROVIDER[service],
        ...(service === "ads" ? { adsPermissionsRevokedAtMeta: revokedAtMeta } : {}),
      },
    });

    revalidatePath(`/projects/${projectId}/integrations`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

// Ads-only metadata a Disconnect removes (docs/meta-ads-plan.md K18).
const ADS_METADATA_KEYS = [
  "selectedAdAccountId",
  "selectedAdAccountName",
  "adAccounts",
  "previousScanSnapshot",
  "adsDigest",
  "lastAdsPerformanceScanAt",
  "adsPerformanceScanFailureCount",
  "lastTestResult",
];

async function writeMetadataKeys(
  credentialId: string,
  values: Record<string, unknown>,
): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    await prisma.$executeRaw`UPDATE "IntegrationCredential" SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), ${[key]}::text[], ${JSON.stringify(value)}::jsonb) WHERE id = ${credentialId}`;
  }
}

async function deleteMetadataKeys(
  credentialId: string,
  keys: readonly string[],
): Promise<void> {
  await prisma.$executeRaw`UPDATE "IntegrationCredential" SET metadata = coalesce(metadata, '{}'::jsonb) - ${[...keys]}::text[] WHERE id = ${credentialId}`;
}

// true: ads_management and ads_read were taken back at Meta. Never throws:
// a failed revoke must not keep the user from disconnecting.
async function revokeAdsPermissions(credential: {
  id: string;
  encryptedSecret: string;
  metadata: unknown;
}): Promise<boolean> {
  const userId = (credential.metadata as { appScopedUserId?: unknown } | null)
    ?.appScopedUserId;
  if (typeof userId !== "string" || !userId || !credential.encryptedSecret) {
    return false;
  }
  try {
    const others = await prisma.integrationCredential.count({
      where: {
        id: { not: credential.id },
        provider: META_PROVIDER.ads,
        status: "ACTIVE",
        metadata: { path: ["appScopedUserId"], equals: userId },
      },
    });
    if (others > 0) return false;
    const accessToken = decryptSecret(credential.encryptedSecret);
    for (const permission of ["ads_management", "ads_read"]) {
      await revokeMetaPermission({ userId, permission, accessToken });
    }
    return true;
  } catch (error) {
    console.error(
      "[meta-actions] ads permissions could not be revoked at Meta:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
