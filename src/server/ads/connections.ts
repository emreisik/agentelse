import "server-only";

import type { AdsConnection, Prisma } from "@prisma/client";

import { normalizeAdAccountId } from "@/lib/ads/account-id";
import { AdsFlags } from "@/lib/ads/flags";
import { metaWorkExcludedHere } from "@/lib/local-worker-policy";
import { prisma } from "@/lib/prisma";
import { ensureAdsAccountRow } from "@/server/ads/accounts";
import { AdsInsurance } from "@/server/ads/insurance";
import {
  inspectMetaToken,
  META_PROVIDER,
  type MetaTokenHealth,
} from "@/server/integrations/meta-client";
import {
  exchangeBusinessCode,
  listBusinessAdAccounts,
  listBusinessPages,
  readBusinessIdentity,
  type BusinessAdAccount,
  type BusinessPage,
} from "@/server/integrations/meta/business-login";
import { withMetaCallContext } from "@/server/integrations/meta/call-context";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { encryptSecret } from "@/server/security/crypto";
import {
  decryptToken,
  encryptToken,
  needsRotation,
} from "@/server/security/key-ring";

// Workspace düzeyinde Meta bağlantısı (docs/meta-ads-plan.md F8). Ajans,
// müşterinin business portfolio'sunu Facebook Login for Business ile bir kez
// bağlar (BISU: kişiye bağlı değil, süresiz) ve hesaplarını projelere atar.
// Atama, projenin Meta Ads bağlantısını bu token'ın kopyasıyla kurar: ayna,
// lansman, karar ve bekçi yolları değişmeden çalışır. Yeniden bağlanınca
// kopyalar yenilenir; Disconnect önce güvenlik kurallarını, sonra kopyaları
// ve bağlantıyı kapatır.

const CHECK_EVERY_MS = 24 * 60 * 60_000;

export type AssignResult = { ok: true } | { ok: false; message: string };

function healthOf(
  connection: Pick<
    AdsConnection,
    "expiresAt" | "dataAccessExpiresAt" | "lastCheckedAt"
  >,
  now: Date,
): MetaTokenHealth {
  return {
    checkedAt: (connection.lastCheckedAt ?? now).toISOString(),
    isValid: true,
    ...(connection.expiresAt
      ? { expiresAt: connection.expiresAt.toISOString() }
      : {}),
    ...(connection.dataAccessExpiresAt
      ? { dataAccessExpiresAt: connection.dataAccessExpiresAt.toISOString() }
      : {}),
    missingScopes: [],
  };
}

function linkedCredentials(connectionId: string) {
  return prisma.integrationCredential.findMany({
    where: {
      provider: META_PROVIDER.ads,
      metadata: { path: ["connectionId"], equals: connectionId },
    },
    select: { id: true, projectId: true, workspaceId: true, status: true },
  });
}

export const AdsConnections = {
  token(connection: Pick<AdsConnection, "encryptedSecret" | "keyId">): string {
    return decryptToken(connection.encryptedSecret, connection.keyId);
  },

  async list(workspaceId: string): Promise<AdsConnection[]> {
    return prisma.adsConnection.findMany({
      where: { workspaceId, status: { not: "REVOKED" } },
      orderBy: { createdAt: "desc" },
    });
  },

  async connectFromCode(input: {
    workspaceId: string;
    userId: string;
    code: string;
    now?: Date;
  }): Promise<AdsConnection> {
    const now = input.now ?? new Date();
    const token = await withMetaCallContext(
      { lane: "P1_USER", callSite: "ads.connection-connect" },
      () => exchangeBusinessCode(input.code),
    );
    const [identity, inspection] = await withMetaCallContext(
      { lane: "P1_USER", callSite: "ads.connection-connect" },
      () =>
        Promise.all([
          readBusinessIdentity(token),
          inspectMetaToken(token).catch(() => null),
        ]),
    );
    const permanent = Boolean(inspection?.isValid && !inspection.expiresAt);
    const sealed = encryptToken(token);
    const fields = {
      kind: permanent
        ? identity.clientBusinessId
          ? "BISU"
          : "SYSTEM_USER"
        : "USER",
      name: identity.name,
      clientBusinessId: identity.clientBusinessId,
      encryptedSecret: sealed.encryptedSecret,
      keyId: sealed.keyId,
      scopes: inspection?.scopes ?? [],
      expiresAt: inspection?.expiresAt
        ? new Date(inspection.expiresAt * 1000)
        : null,
      dataAccessExpiresAt: inspection?.dataAccessExpiresAt
        ? new Date(inspection.dataAccessExpiresAt * 1000)
        : null,
      status: "ACTIVE",
      lastCheckedAt: now,
    };
    const existing = identity.clientBusinessId
      ? await prisma.adsConnection.findFirst({
          where: {
            workspaceId: input.workspaceId,
            clientBusinessId: identity.clientBusinessId,
          },
        })
      : null;
    const connection = existing
      ? await prisma.adsConnection.update({
          where: { id: existing.id },
          data: fields,
        })
      : await prisma.adsConnection.create({
          data: {
            ...fields,
            workspaceId: input.workspaceId,
            createdByUserId: input.userId,
          },
        });
    // Yeniden bağlanınca atanmış projelerin kopyası da yenilenir.
    await this.refreshProjectCopies(connection, token, now);
    await AuditLogRepository.record({
      workspaceId: input.workspaceId,
      actorType: "USER",
      actorId: input.userId,
      action: existing
        ? "ads_connection.reconnected"
        : "ads_connection.connected",
      entityType: "AdsConnection",
      entityId: connection.id,
      metadata: {
        kind: connection.kind,
        clientBusinessId: connection.clientBusinessId,
      },
    });
    return connection;
  },

  async accounts(connection: AdsConnection): Promise<BusinessAdAccount[]> {
    const token = this.token(connection);
    return withMetaCallContext(
      { lane: "P1_USER", callSite: "ads.connection-accounts" },
      () => listBusinessAdAccounts(token, connection.clientBusinessId),
    );
  },

  async pages(connection: AdsConnection): Promise<BusinessPage[]> {
    const token = this.token(connection);
    return withMetaCallContext(
      { lane: "P1_USER", callSite: "ads.connection-pages" },
      () => listBusinessPages(token, connection.clientBusinessId),
    );
  },

  // Bağlantının bir hesabını projeye atar (aynı bağlantı birden çok projeye
  // hesap atayabilir). Projenin önceki Meta Ads bağlantısının yerini alır.
  async assign(input: {
    connectionId: string;
    workspaceId: string;
    projectId: string;
    adAccountId: string;
    pageId?: string | null;
    userId: string;
    now?: Date;
  }): Promise<AssignResult> {
    const now = input.now ?? new Date();
    const connection = await prisma.adsConnection.findFirst({
      where: {
        id: input.connectionId,
        workspaceId: input.workspaceId,
        status: "ACTIVE",
      },
    });
    if (!connection)
      return {
        ok: false,
        message: "This connection isn't active. Connect again.",
      };
    const project = await prisma.project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      select: { id: true },
    });
    const brand = await prisma.brand.findFirst({
      where: { projectId: input.projectId, isDefault: true },
      select: { id: true },
    });
    if (!project || !brand)
      return { ok: false, message: "Pick a project of this workspace." };
    const wanted = normalizeAdAccountId(input.adAccountId);
    const [accounts, pages] = await Promise.all([
      this.accounts(connection),
      this.pages(connection).catch(() => [] as BusinessPage[]),
    ]);
    const account = accounts.find((row) => row.adAccountId === wanted);
    if (!account)
      return {
        ok: false,
        message: "This ad account isn't in this connection.",
      };
    const page = input.pageId
      ? pages.find((row) => row.pageId === input.pageId)
      : undefined;
    if (input.pageId && !page) {
      return { ok: false, message: "This Page isn't in this connection." };
    }
    const token = this.token(connection);
    const metadata = {
      pages,
      adAccounts: [account],
      selectedAdAccountId: account.adAccountId,
      selectedAdAccountName: account.adAccountName,
      ...(page
        ? { selectedPageId: page.pageId, selectedPageName: page.pageName }
        : {}),
      connectionId: connection.id,
      connectionKind: connection.kind,
      tokenHealth: healthOf(connection, now),
    };
    const credential = await prisma.integrationCredential.upsert({
      where: {
        projectId_provider: {
          projectId: input.projectId,
          provider: META_PROVIDER.ads,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: brand.id,
        provider: META_PROVIDER.ads,
        accountLabel: account.adAccountName,
        encryptedSecret: encryptSecret(token),
        metadata: metadata as unknown as Prisma.InputJsonValue,
        status: "ACTIVE",
      },
      update: {
        accountLabel: account.adAccountName,
        encryptedSecret: encryptSecret(token),
        metadata: metadata as unknown as Prisma.InputJsonValue,
        status: "ACTIVE",
      },
    });
    const row = await ensureAdsAccountRow({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: brand.id,
      credentialId: credential.id,
      externalId: account.adAccountId,
      name: account.adAccountName,
      ...(account.currency ? { currency: account.currency } : {}),
      ...(page ? { pageId: page.pageId } : {}),
    });
    if (row) {
      await prisma.adsAccount.update({
        where: { id: row.id },
        data: { connectionId: connection.id },
      });
    }
    await AuditLogRepository.record({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      actorType: "USER",
      actorId: input.userId,
      action: "ads_connection.assigned",
      entityType: "AdsConnection",
      entityId: connection.id,
      metadata: {
        adAccountId: account.adAccountId,
        pageId: page?.pageId ?? null,
      },
    });
    return { ok: true };
  },

  async refreshProjectCopies(
    connection: AdsConnection,
    token: string,
    now: Date,
  ): Promise<number> {
    const credentials = await linkedCredentials(connection.id);
    for (const credential of credentials) {
      await prisma.integrationCredential.update({
        where: { id: credential.id },
        data: { encryptedSecret: encryptSecret(token), status: "ACTIVE" },
      });
      await prisma.$executeRaw`UPDATE "IntegrationCredential" SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{tokenHealth}', ${JSON.stringify(healthOf(connection, now))}::jsonb) WHERE id = ${credential.id}`;
    }
    return credentials.length;
  },

  async disconnect(input: {
    connectionId: string;
    workspaceId: string;
    userId: string;
  }): Promise<AssignResult> {
    const connection = await prisma.adsConnection.findFirst({
      where: { id: input.connectionId, workspaceId: input.workspaceId },
    });
    if (!connection) return { ok: false, message: "Connection not found." };
    let token: string | null = null;
    try {
      token = connection.encryptedSecret ? this.token(connection) : null;
    } catch {
      token = null;
    }
    const credentials = await linkedCredentials(connection.id);
    for (const credential of credentials) {
      // Önce Meta'daki güvenlik kuralları (token hâlâ geçerliyken).
      if (token) {
        await AdsInsurance.removeForProject(credential.projectId, token).catch(
          () => null,
        );
      }
      await prisma.integrationCredential.update({
        where: { id: credential.id },
        data: { status: "REVOKED", encryptedSecret: "" },
      });
      await prisma.adsAccountProject
        .deleteMany({ where: { projectId: credential.projectId } })
        .catch(() => undefined);
    }
    await prisma.adsAccount.updateMany({
      where: { connectionId: connection.id },
      data: { connectionId: null },
    });
    await prisma.adsConnection.update({
      where: { id: connection.id },
      data: { status: "REVOKED", encryptedSecret: "" },
    });
    await AuditLogRepository.record({
      workspaceId: input.workspaceId,
      actorType: "USER",
      actorId: input.userId,
      action: "ads_connection.disconnected",
      entityType: "AdsConnection",
      entityId: connection.id,
      metadata: {
        projects: credentials.map((credential) => credential.projectId),
      },
    });
    return { ok: true };
  },

  // Tick adımı: günde bir token denetimi (debug_token) ve anahtar rotasyonu.
  async checkDue(now: Date = new Date(), limit = 10): Promise<number> {
    if (!AdsFlags.agency()) return 0;
    if (metaWorkExcludedHere(process.env)) return 0;
    const due = await prisma.adsConnection.findMany({
      where: {
        status: "ACTIVE",
        OR: [
          { lastCheckedAt: null },
          { lastCheckedAt: { lt: new Date(now.getTime() - CHECK_EVERY_MS) } },
        ],
      },
      take: limit,
    });
    let checked = 0;
    for (const connection of due) {
      let token: string;
      try {
        token = this.token(connection);
      } catch (error) {
        console.error(
          `[ads-connections] ${connection.id} token can't be decrypted:`,
          error instanceof Error ? error.message : error,
        );
        continue;
      }
      const inspection = await withMetaCallContext(
        { lane: "P2_BACKGROUND", callSite: "ads.connection-health" },
        () => inspectMetaToken(token),
      ).catch(() => null);
      if (inspection && !inspection.isValid) {
        await prisma.adsConnection.update({
          where: { id: connection.id },
          data: { status: "EXPIRED", lastCheckedAt: now },
        });
        const credentials = await linkedCredentials(connection.id);
        await prisma.integrationCredential.updateMany({
          where: { id: { in: credentials.map((credential) => credential.id) } },
          data: { status: "EXPIRED" },
        });
        checked += 1;
        continue;
      }
      const rotate = needsRotation(connection.keyId)
        ? encryptToken(token)
        : null;
      await prisma.adsConnection.update({
        where: { id: connection.id },
        data: {
          lastCheckedAt: now,
          ...(inspection
            ? {
                expiresAt: inspection.expiresAt
                  ? new Date(inspection.expiresAt * 1000)
                  : null,
                scopes: inspection.scopes,
              }
            : {}),
          ...(rotate
            ? { encryptedSecret: rotate.encryptedSecret, keyId: rotate.keyId }
            : {}),
        },
      });
      checked += 1;
    }
    return checked;
  },
};
