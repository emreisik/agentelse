import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { encryptSecret } from "@/server/security/crypto";
import { verifyOAuthState } from "@/server/security/oauth-state";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  exchangeForLongLivedToken,
  exchangeMetaAuthCode,
  fetchMetaAccountName,
  listAdAccounts,
  listManagedPages,
  type MetaCredentialMetadata,
} from "@/server/integrations/meta-client";

type ListOutcome<T> = { items: T[]; error?: string };

async function safeList<T>(
  promise: Promise<T[]>,
  fallbackMessage: string,
): Promise<ListOutcome<T>> {
  try {
    return { items: await promise };
  } catch (error) {
    return {
      items: [],
      error: error instanceof Error ? error.message : fallbackMessage,
    };
  }
}

function redirectToEntegrasyonlar(
  request: Request,
  projectId: string,
  metaError?: string,
) {
  const url = new URL(`/projects/${projectId}/entegrasyonlar`, request.url);
  url.searchParams.set("entegrasyon", "meta");
  if (metaError) url.searchParams.set("metaError", metaError);
  return NextResponse.redirect(url);
}

// Meta'nın consent ekranından dönüş — code'u long-lived token'a çevirir,
// yönetilen Page'leri (bağlı Instagram Business hesaplarıyla birlikte) ve
// reklam hesaplarını listeler, bağlantıyı kurar. google/callback/route.ts
// ile aynı iskelet.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const stateParam = searchParams.get("state");

  const state = stateParam ? verifyOAuthState(stateParam) : null;
  if (!state) {
    return NextResponse.redirect(
      new URL("/dashboard?metaError=state_invalid", request.url),
    );
  }

  if (error === "access_denied") {
    return redirectToEntegrasyonlar(request, state.projectId, "denied");
  }
  if (!code) {
    return redirectToEntegrasyonlar(
      request,
      state.projectId,
      "exchange_failed",
    );
  }

  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return redirectToEntegrasyonlar(request, state.projectId, "unauthorized");
  }
  // İmzalı state hangi kullanıcı adına başlatıldığını taşıyor — mevcut
  // oturum başka bir kullanıcıya aitse devam etmiyoruz.
  if (userId !== state.userId) {
    return redirectToEntegrasyonlar(request, state.projectId, "state_invalid");
  }

  let access: {
    workspaceId: string;
    projectId: string;
    defaultBrandId: string;
  };
  try {
    access = await requireProjectAccess(userId, state.projectId);
  } catch {
    return redirectToEntegrasyonlar(request, state.projectId, "state_invalid");
  }

  let longLivedToken: { accessToken: string; expiresIn: number };
  try {
    const shortLived = await exchangeMetaAuthCode(code);
    longLivedToken = await exchangeForLongLivedToken(shortLived.accessToken);
  } catch {
    return redirectToEntegrasyonlar(
      request,
      state.projectId,
      "exchange_failed",
    );
  }

  // Page/ad account listelerinden biri başarısız olsa da (örn. o Page için
  // izin verilmemiş) bağlantı yine de kurulur — hata mesajı metadata'da
  // saklanır, dialog'da gösterilir.
  const [connectedName, pages, adAccounts] = await Promise.all([
    fetchMetaAccountName(longLivedToken.accessToken),
    safeList(
      listManagedPages(longLivedToken.accessToken),
      "Page listesi alınamadı",
    ),
    safeList(
      listAdAccounts(longLivedToken.accessToken),
      "Reklam hesabı listesi alınamadı",
    ),
  ]);

  const existing = await prisma.integrationCredential.findUnique({
    where: {
      projectId_provider: { projectId: state.projectId, provider: "meta" },
    },
  });
  const existingMetadata = (existing?.metadata ?? {}) as MetaCredentialMetadata;

  const keepPageSelection =
    existingMetadata.selectedPageId &&
    pages.items.some((p) => p.pageId === existingMetadata.selectedPageId);
  const keepAdAccountSelection =
    existingMetadata.selectedAdAccountId &&
    adAccounts.items.some(
      (a) => a.adAccountId === existingMetadata.selectedAdAccountId,
    );

  const metadata: MetaCredentialMetadata = {
    connectedName: connectedName ?? undefined,
    longLivedTokenExpiresAt: new Date(
      Date.now() + longLivedToken.expiresIn * 1000,
    ).toISOString(),
    pages: pages.items,
    pagesListError: pages.error,
    adAccounts: adAccounts.items,
    adAccountsListError: adAccounts.error,
    selectedPageId: keepPageSelection
      ? existingMetadata.selectedPageId
      : undefined,
    selectedPageName: keepPageSelection
      ? existingMetadata.selectedPageName
      : undefined,
    selectedAdAccountId: keepAdAccountSelection
      ? existingMetadata.selectedAdAccountId
      : undefined,
    selectedAdAccountName: keepAdAccountSelection
      ? existingMetadata.selectedAdAccountName
      : undefined,
  };

  const credential = await prisma.integrationCredential.upsert({
    where: {
      projectId_provider: { projectId: state.projectId, provider: "meta" },
    },
    create: {
      workspaceId: access.workspaceId,
      projectId: state.projectId,
      brandId: access.defaultBrandId,
      provider: "meta",
      accountLabel: connectedName ?? "Meta",
      encryptedSecret: encryptSecret(longLivedToken.accessToken),
      metadata,
      status: "ACTIVE",
    },
    update: {
      accountLabel: connectedName ?? "Meta",
      encryptedSecret: encryptSecret(longLivedToken.accessToken),
      metadata,
      status: "ACTIVE",
    },
  });

  await AuditLogRepository.record({
    workspaceId: access.workspaceId,
    projectId: state.projectId,
    actorType: "USER",
    actorId: userId,
    action: "integration_credential.connected",
    entityType: "IntegrationCredential",
    entityId: credential.id,
    metadata: { provider: "meta" },
  });

  return redirectToEntegrasyonlar(request, state.projectId);
}
