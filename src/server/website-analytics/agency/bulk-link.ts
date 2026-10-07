import "server-only";

import { prisma } from "@/lib/prisma";
import {
  gaAgencyEnabled,
  gaAgencyEnabledFor,
  gaAgencyMockMode,
} from "@/lib/website-analytics/agency/flags";
import { suggestGaProperty } from "@/lib/website-analytics/agency/property-match";
import { GaFlags } from "@/lib/website-analytics/flags";
import { buildGoogleConnectionMetadata } from "@/server/integrations/google-connection-metadata";
import { getFreshGoogleAccessToken } from "@/server/integrations/google-token";
import { GOOGLE_PROVIDER } from "@/server/integrations/google/services";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { ensureGaLinkForProject } from "@/server/website-analytics/sync/links";

// Toplu bağlama (GA-F8): bir Google hesabını tek işlemde en çok 20 projeye
// bağlar. "Use existing connection" (google-actions.ts reuseGoogleConnectionAction)
// ile AYNI mekanizma: kaynak bağlantının şifreli refresh token'ı kopyalanır,
// yani tek OAuth izni ve tek token (Google'ın hesap başına 100 token sınırı
// ajansta dolmaz). Mülk listesi bir kez tazelenir. Mevcut ACTIVE bir bağlantının
// üzerine asla yazılmaz.

export const BULK_LINK_MAX = 20;

export type BulkLinkRow = {
  projectId: string;
  status: "linked" | "skipped";
  reason?:
    | "not_found"
    | "closed"
    | "already_connected"
    | "other_workspace"
    | "not_allowed";
  propertyId?: string | null;
};

export type BulkLinkResult =
  | { ok: true; rows: BulkLinkRow[]; linked: number }
  | { ok: false; reason: "off" | "bad_source" | "too_many" | "token_invalid" };

export type BulkLinkDeps = {
  getAccessToken?: (credential: {
    id: string;
    encryptedSecret: string;
  }) => Promise<string>;
  buildMetadata?: (
    accessToken: string,
    source: { connectedEmail?: string; googleSub?: string; metadata: unknown },
  ) => Promise<Record<string, unknown>>;
};

type Ga4PropertyEntry = {
  propertyId: string;
  propertyName: string;
  accountName: string;
};

const PROVIDER = GOOGLE_PROVIDER.analytics;

// Kaynak hesaba özgü olmayan, projeye özgü anahtarlar: paylaşılan metadata'dan
// ve (sağlık/koparma izleri) eski metadata'dan düşer. Seçim ve tarama kayıtları
// projenin KENDİ eski metadata'sından geri yüklenir.
const PER_PROJECT_KEYS = [
  "selectedGa4PropertyId",
  "selectedGa4PropertyName",
  "lastAnalyticsScanAt",
  "analyticsScanFailureCount",
  "lastTestResult",
  "previousAnalyticsSnapshot",
] as const;
const STALE_TRACE_KEYS = ["disconnectedAt", "googleHealth", "gaEdit"] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function without(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const copy = { ...source };
  for (const key of keys) delete copy[key];
  return copy;
}

function propertyList(metadata: Record<string, unknown>): Ga4PropertyEntry[] {
  const list = metadata.ga4Properties;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (entry): entry is Ga4PropertyEntry =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as Ga4PropertyEntry).propertyId === "string",
  );
}

function identityOf(metadata: unknown): {
  connectedEmail?: string;
  googleSub?: string;
} {
  const record = asRecord(metadata);
  return {
    connectedEmail:
      typeof record.connectedEmail === "string"
        ? record.connectedEmail
        : undefined,
    googleSub:
      typeof record.googleSub === "string" ? record.googleSub : undefined,
  };
}

// Gerçek varsayılanlar: bir kez Google'a gider. Mock kipte hiç ağ çağrısı yok:
// jeton sahte, metadata kaynağın kendi saklı metadata'sıdır.
function resolveDeps(deps: BulkLinkDeps): Required<BulkLinkDeps> {
  const mock = gaAgencyMockMode();
  return {
    getAccessToken:
      deps.getAccessToken ??
      (mock
        ? async () => "mock-access-token"
        : (credential) => getFreshGoogleAccessToken(credential)),
    buildMetadata:
      deps.buildMetadata ??
      (mock
        ? async (_accessToken, source) => asRecord(source.metadata)
        : async (accessToken, source) =>
            asRecord(
              await buildGoogleConnectionMetadata(
                "analytics",
                accessToken,
                {
                  connectedEmail: source.connectedEmail,
                  googleSub: source.googleSub,
                },
                {},
              ),
            )),
  };
}

// Workspace'teki bağlı Google hesapları (hesap başına bir satır; kaynak olarak
// en yeni bağlantı) ve kaç projede bağlı olduğu.
export async function listWorkspaceGoogleAccounts(
  workspaceId: string,
): Promise<{ credentialId: string; email: string; projectCount: number }[]> {
  if (!gaAgencyEnabled()) return [];
  const rows = await prisma.integrationCredential.findMany({
    where: {
      workspaceId,
      provider: PROVIDER,
      status: "ACTIVE",
      NOT: { encryptedSecret: "" },
    },
    select: { id: true, accountLabel: true, metadata: true },
    orderBy: { updatedAt: "desc" },
    take: 500,
  });
  const accounts = new Map<
    string,
    { credentialId: string; email: string; projectCount: number }
  >();
  for (const row of rows) {
    const identity = identityOf(row.metadata);
    const email = identity.connectedEmail ?? row.accountLabel;
    if (!email) continue;
    const key = identity.googleSub ?? email.toLowerCase();
    const existing = accounts.get(key);
    if (existing) existing.projectCount += 1;
    else accounts.set(key, { credentialId: row.id, email, projectCount: 1 });
  }
  return [...accounts.values()].sort((a, b) => a.email.localeCompare(b.email));
}

// Henüz ACTIVE bir Analytics bağlantısı olmayan, kapatılmamış projeler.
export async function listLinkableProjects(
  workspaceId: string,
): Promise<{ id: string; name: string }[]> {
  if (!gaAgencyEnabled()) return [];
  const [projects, connected] = await Promise.all([
    prisma.project.findMany({
      where: { workspaceId, status: { not: "CLOSED" } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 500,
    }),
    prisma.integrationCredential.findMany({
      where: { workspaceId, provider: PROVIDER, status: "ACTIVE" },
      select: { projectId: true },
    }),
  ]);
  const taken = new Set(connected.map((row) => row.projectId));
  return projects.filter((project) => !taken.has(project.id));
}

export async function bulkLinkGoogleAccount(
  input: {
    workspaceId: string;
    userId: string;
    sourceCredentialId: string;
    projectIds: readonly string[];
    // Arayüzde varsayılan KAPALI: yanlış eşleşme başka müşterinin verisini gösterir.
    autoProperty: boolean;
    now?: Date;
  },
  deps: BulkLinkDeps = {},
): Promise<BulkLinkResult> {
  if (!gaAgencyEnabled()) return { ok: false, reason: "off" };
  const projectIds = [...new Set(input.projectIds)];
  if (projectIds.length > BULK_LINK_MAX) {
    return { ok: false, reason: "too_many" };
  }
  const source = await prisma.integrationCredential.findFirst({
    where: {
      id: input.sourceCredentialId,
      workspaceId: input.workspaceId,
      provider: PROVIDER,
      status: "ACTIVE",
      NOT: { encryptedSecret: "" },
    },
  });
  if (!source) return { ok: false, reason: "bad_source" };
  // Canlı veritabanını paylaşan geliştirme süreci kaynak hesabın jetonunu da
  // yenilemez ve Google'a gitmez: kaynak projesi izinli değilse kaynak geçersiz sayılır.
  if (!gaAgencyEnabledFor(source.projectId)) {
    return { ok: false, reason: "bad_source" };
  }

  const { getAccessToken, buildMetadata } = resolveDeps(deps);
  // Jeton ve mülk listesi bir kez alınır; bütün projeler aynı listeyi paylaşır.
  let shared: Record<string, unknown>;
  try {
    const accessToken = await getAccessToken({
      id: source.id,
      encryptedSecret: source.encryptedSecret,
    });
    shared = without(
      await buildMetadata(accessToken, {
        ...identityOf(source.metadata),
        metadata: source.metadata,
      }),
      [...PER_PROJECT_KEYS, ...STALE_TRACE_KEYS],
    );
  } catch (error) {
    console.error(
      "[ga-bulk-link] source token failed:",
      error instanceof Error ? error.name : "error",
    );
    return { ok: false, reason: "token_invalid" };
  }
  const sharedProperties = propertyList(shared);

  const rows: BulkLinkRow[] = [];
  // Sıralı: Google'a ve veritabanına ani yük bindirmez, hata ilk satırda durur.
  for (const projectId of projectIds) {
    rows.push(
      await linkOneProject({
        projectId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        source,
        shared,
        sharedProperties,
        autoProperty: input.autoProperty,
      }),
    );
  }
  return {
    ok: true,
    rows,
    linked: rows.filter((row) => row.status === "linked").length,
  };
}

async function linkOneProject(input: {
  projectId: string;
  workspaceId: string;
  userId: string;
  source: { id: string; accountLabel: string | null; encryptedSecret: string };
  shared: Record<string, unknown>;
  sharedProperties: Ga4PropertyEntry[];
  autoProperty: boolean;
}): Promise<BulkLinkRow> {
  const { projectId } = input;
  const skip = (reason: NonNullable<BulkLinkRow["reason"]>): BulkLinkRow => ({
    projectId,
    status: "skipped",
    reason,
  });

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, domain: true, workspaceId: true, status: true },
  });
  if (!project) return skip("not_found");
  if (project.workspaceId !== input.workspaceId) return skip("other_workspace");
  if (project.status === "CLOSED") return skip("closed");
  // Canlı veritabanını paylaşan geliştirme süreci yalnız izinli projelere dokunur.
  if (!gaAgencyEnabledFor(projectId)) return skip("not_allowed");

  const [existing, brand] = await Promise.all([
    prisma.integrationCredential.findUnique({
      where: { projectId_provider: { projectId, provider: PROVIDER } },
      select: { id: true, status: true, metadata: true },
    }),
    prisma.brand.findFirst({
      where: { projectId, isDefault: true },
      select: { id: true },
    }),
  ]);
  if (existing?.status === "ACTIVE") return skip("already_connected");
  if (!brand) return skip("not_found");

  // Projenin kendi eski metadata'sı korunur; hesaba ait paylaşılan kısım üstüne yazılır.
  const previous = asRecord(existing?.metadata);
  const metadata: Record<string, unknown> = {
    ...without(previous, [...PER_PROJECT_KEYS, ...STALE_TRACE_KEYS]),
    ...input.shared,
  };
  // Önceki mülk seçimi ve tarama kayıtları, mülk hâlâ listedeyse geri yüklenir.
  const previousId =
    typeof previous.selectedGa4PropertyId === "string"
      ? previous.selectedGa4PropertyId
      : undefined;
  let selectedId: string | null = null;
  if (
    previousId &&
    input.sharedProperties.some((entry) => entry.propertyId === previousId)
  ) {
    selectedId = previousId;
    metadata.selectedGa4PropertyId = previousId;
    if (typeof previous.selectedGa4PropertyName === "string") {
      metadata.selectedGa4PropertyName = previous.selectedGa4PropertyName;
    }
    for (const key of ["lastAnalyticsScanAt", "analyticsScanFailureCount"]) {
      if (previous[key] !== undefined) metadata[key] = previous[key];
    }
  } else if (input.autoProperty) {
    const suggested = suggestGaProperty(
      { name: project.name, domain: project.domain },
      input.sharedProperties,
    );
    const entry = input.sharedProperties.find(
      (candidate) => candidate.propertyId === suggested,
    );
    if (entry) {
      selectedId = entry.propertyId;
      metadata.selectedGa4PropertyId = entry.propertyId;
      metadata.selectedGa4PropertyName = entry.propertyName;
    }
  }

  const credential = await prisma.integrationCredential.upsert({
    where: { projectId_provider: { projectId, provider: PROVIDER } },
    create: {
      workspaceId: input.workspaceId,
      projectId,
      brandId: brand.id,
      provider: PROVIDER,
      accountLabel: input.source.accountLabel,
      encryptedSecret: input.source.encryptedSecret,
      metadata: metadata as never,
      status: "ACTIVE",
    },
    update: {
      accountLabel: input.source.accountLabel,
      encryptedSecret: input.source.encryptedSecret,
      metadata: metadata as never,
      status: "ACTIVE",
    },
  });

  if (GaFlags.sync()) {
    try {
      await ensureGaLinkForProject(projectId);
    } catch (error) {
      console.error(
        "[ga-bulk-link] link failed:",
        error instanceof Error ? error.name : "error",
      );
    }
  }

  await AuditLogRepository.record({
    workspaceId: input.workspaceId,
    projectId,
    actorType: "USER",
    actorId: input.userId,
    action: "integration_credential.connected",
    entityType: "IntegrationCredential",
    entityId: credential.id,
    metadata: {
      provider: PROVIDER,
      reusedFromCredentialId: input.source.id,
      bulk: true,
    },
  });

  return { projectId, status: "linked", propertyId: selectedId };
}
