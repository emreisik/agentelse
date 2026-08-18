import "server-only";

import type { ProviderHealthStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ProviderRegistry } from "@/server/execution/provider-registry";
import { classifyError } from "@/server/observability/error-classifier";

// Sağlayıcı sağlığı: şemadaki ProviderDefinition/ProviderHealth/
// ProviderIncident modelleri tanımlıydı ama hiçbir kod onlara yazmıyordu.
// Bu servis son N dakikadaki ExecutionJob sonuçlarından her sağlayıcının
// durumunu türetir, durum değişiminde olay (incident) açar/kapatır ve
// CapabilityRouter'ın devre kesici kararını besler.

const WINDOW_MS = 30 * 60_000;
// Ardışık değil, pencere içi oran: tek bir hata sağlayıcıyı düşürmemeli
// ama üst üste gelen hatalar hızla düşürmeli.
const MIN_SAMPLE = 3;
const DEGRADED_FAILURE_RATE = 0.5;
const DOWN_FAILURE_RATE = 0.9;

export type ProviderHealthSnapshot = {
  key: string;
  status: ProviderHealthStatus;
  isConfigured: boolean;
  total: number;
  failed: number;
  lastErrorMessage: string | null;
  lastCheckAt: Date | null;
};

// Devre kesici "yarı-açık" davranışı: bir sağlayıcı UNAVAILABLE/DEGRADED/
// RATE_LIMITED'a düşünce CapabilityRouter ona bir daha iş vermiyor (bkz.
// unhealthyProviderKeys) — bu da pencerede ASLA yeni örnek biriktiremeyeceği
// anlamına geliyor (dispatch edilmeyen bir işin sonucu da olmaz). Önceki
// kod bu durumda son bilinen (kötü) statüyü SONSUZA DEK koruyordu: gerçek
// hata çoktan 30dk'lık pencereden çıksa bile sağlayıcı bir daha asla
// denenmiyordu (canlıda openclaw + meta-api'nin başına geldi — bkz. bu
// oturumun notları). Pencerede hiç örnek kalmayınca (jobs.length === 0,
// yani son WINDOW_MS'de bu sağlayıcıya tek bir iş bile düşmemiş) AVAILABLE'a
// dönüp bir sonraki dispatch'in tekrar denemesine izin veriyoruz — sorun
// gerçekten sürüyorsa yeni bir hata hemen yeniden UNAVAILABLE'a düşürür,
// gerçekten geçtiyse sağlayıcı sessizce toparlanır. AUTH_REQUIRED/DISABLED
// istisna: bunlar insan müdahalesi (anahtar/yapılandırma) gerektirir,
// zamanla kendiliğinden düzelmez, o yüzden decay olmadan korunuyor.
function decayStatus(
  previous: ProviderHealthStatus | undefined,
): ProviderHealthStatus {
  if (previous === "AUTH_REQUIRED" || previous === "DISABLED") return previous;
  return "AVAILABLE";
}

function statusFromSamples(
  total: number,
  failed: number,
  lastError: string | null,
): ProviderHealthStatus {
  if (total === 0) return "AVAILABLE";
  const rate = failed / total;
  if (rate < DEGRADED_FAILURE_RATE) return "AVAILABLE";

  // Hata tipi durumu belirler: kota/anahtar sorunları beklemekle geçmez,
  // bu yüzden ayrı durumlara düşerler ve devre kesici onları farklı ele alır.
  const classification = classifyError(lastError);
  if (classification.category === "RATE_LIMIT") return "RATE_LIMITED";
  if (
    classification.category === "AUTH" ||
    classification.category === "BILLING"
  ) {
    return "AUTH_REQUIRED";
  }
  return rate >= DOWN_FAILURE_RATE ? "UNAVAILABLE" : "DEGRADED";
}

export const ProviderHealthService = {
  // Kayıt defterindeki her sağlayıcı için ProviderDefinition satırının
  // varlığını garanti eder — sağlık ve olay kayıtları buna bağlı.
  async syncDefinitions(): Promise<void> {
    for (const provider of ProviderRegistry.registered()) {
      await prisma.providerDefinition.upsert({
        where: { key: provider.key },
        create: {
          key: provider.key,
          name: provider.key,
          providerType: provider.type,
          configured: provider.isConfigured,
        },
        update: { configured: provider.isConfigured },
      });
    }
  },

  // Son penceredeki iş sonuçlarından sağlığı yeniden hesaplar. Her tick'te
  // çağrılabilir; yazma yalnızca durum değiştiğinde olay üretir.
  async refresh(now = new Date()): Promise<ProviderHealthSnapshot[]> {
    await this.syncDefinitions();

    const since = new Date(now.getTime() - WINDOW_MS);
    const definitions = await prisma.providerDefinition.findMany({
      include: { health: true },
    });
    const snapshots: ProviderHealthSnapshot[] = [];

    for (const definition of definitions) {
      const jobs = await prisma.executionJob.findMany({
        where: {
          providerId: definition.key,
          updatedAt: { gte: since },
          status: { in: ["COMPLETED", "FAILED"] },
        },
        select: { status: true, errorMessage: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
      });

      // Yalnızca sağlayıcının GERÇEKTEN bozuk olduğuna kanıt olan hatalar
      // (classifyError().degradesProvider) devre kesiciyi besler — içerik
      // doğrulama hatası gibi "isteğimiz kötüydü" türü başarısızlıklar
      // (ör. Instagram'ın "Only photo or video..." reddi) sağlayıcıyı
      // UNAVAILABLE'a düşürmemeli, çünkü sağlayıcının kendisi sağlıklı.
      const failures = jobs.filter(
        (job) =>
          job.status === "FAILED" &&
          classifyError(job.errorMessage).degradesProvider,
      );
      const lastErrorMessage = failures[0]?.errorMessage ?? null;
      const status =
        jobs.length < MIN_SAMPLE
          ? decayStatus(definition.health?.status)
          : statusFromSamples(jobs.length, failures.length, lastErrorMessage);

      const previous = definition.health?.status;
      await prisma.providerHealth.upsert({
        where: { providerId: definition.id },
        create: {
          providerId: definition.id,
          status,
          lastCheckAt: now,
          lastErrorMessage,
        },
        update: { status, lastCheckAt: now, lastErrorMessage },
      });

      if (previous !== status) {
        await this.recordStatusChange(
          definition.id,
          previous,
          status,
          lastErrorMessage,
          now,
        );
      }

      snapshots.push({
        key: definition.key,
        status,
        isConfigured: definition.configured,
        total: jobs.length,
        failed: failures.length,
        lastErrorMessage,
        lastCheckAt: now,
      });
    }

    return snapshots;
  },

  // Sağlıklıya dönüşte açık olayları kapatır, bozulmada yeni olay açar.
  async recordStatusChange(
    providerDefinitionId: string,
    previous: ProviderHealthStatus | undefined,
    next: ProviderHealthStatus,
    lastErrorMessage: string | null,
    now: Date,
  ): Promise<void> {
    if (next === "AVAILABLE") {
      await prisma.providerIncident.updateMany({
        where: { providerId: providerDefinitionId, resolved: false },
        data: { resolved: true, resolvedAt: now },
      });
      return;
    }

    const alreadyOpen = await prisma.providerIncident.findFirst({
      where: { providerId: providerDefinitionId, resolved: false },
    });
    if (alreadyOpen) return;

    await prisma.providerIncident.create({
      data: {
        providerId: providerDefinitionId,
        message: [
          `${previous ?? "AVAILABLE"} → ${next}`,
          lastErrorMessage ? `Son hata: ${lastErrorMessage}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      },
    });
  },

  // Devre kesicinin okuduğu küme: bu sağlayıcılara yeni iş verilmez.
  async unhealthyProviderKeys(): Promise<ReadonlySet<string>> {
    const rows = await prisma.providerHealth.findMany({
      where: { status: { in: ["UNAVAILABLE", "AUTH_REQUIRED", "DISABLED"] } },
      include: { provider: { select: { key: true } } },
    });
    return new Set(rows.map((row) => row.provider.key));
  },
};
