import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  ProjectRepository,
  type CreateProjectInput,
} from "@/server/repositories/project.repository";

import { getBillingConfig } from "./config";
import { getEntitlements } from "./entitlements";
import { recordShadowDecision } from "./shadow-log";

type Project = Prisma.ProjectGetPayload<{ include: { brands: true } }>;

// BRAND_LIMIT: planın marka sayısı dolu. PLAN_REQUIRED: aktif plan/deneme yok
// (satırsız yeni kayıt, deneme/LEGACY sonu...). Metinleri Faz 6 belirler.
export type BrandLimitFailure = {
  ok: false;
  code: "BRAND_LIMIT" | "PLAN_REQUIRED";
  limit: number;
  current: number;
};

// Marka (proje) oluşturma kapısı: BILLING_MODE=off iken faturalama sorgusu ATMADAN
// doğrudan eski yol. shadow: limiti hesaplar, "engellenirdi"yi AuditLog'a yazar,
// yine oluşturur. enforce: sayma + oluşturma tek işlemde kilit altında.
export async function createProjectWithinBrandLimit(args: {
  workspaceId: string;
  input: CreateProjectInput;
}): Promise<{ ok: true; project: Project } | BrandLimitFailure> {
  const { workspaceId, input } = args;
  const config = getBillingConfig();
  if (config.mode === "off") {
    return { ok: true, project: await ProjectRepository.create(input) };
  }

  const entitlements = await getEntitlements(workspaceId);
  // Okunamadı (DEGRADED): enforce'ta kapalı, aksi halde açık (getEntitlements karar verdi).
  const limit = entitlements.brandLimit;
  if (limit === null) {
    return { ok: true, project: await ProjectRepository.create(input) };
  }

  const code: BrandLimitFailure["code"] =
    entitlements.access === "READ_ONLY" ? "PLAN_REQUIRED" : "BRAND_LIMIT";

  if (entitlements.enforced) {
    const result = await ProjectRepository.createWithinLimit(input, limit);
    if (result.ok) return result;
    return { ok: false, code, limit, current: result.current };
  }

  // shadow: engellenmez, yalnız ölçülür.
  try {
    const current = await prisma.project.count({ where: { workspaceId } });
    if (current >= limit) {
      await recordShadowDecision({
        workspaceId,
        kind: "brand_limit",
        detail: { code, limit, current },
      });
    }
  } catch (error) {
    console.error(
      "[billing] shadow brand-limit check failed:",
      error instanceof Error ? error.name : error,
    );
  }
  return { ok: true, project: await ProjectRepository.create(input) };
}
