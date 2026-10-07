import "server-only";

import type { GaConfigChange, GaPropertyLink } from "@prisma/client";

import { dayKeyInTimezone } from "@/lib/timezone";
import { safeTimezone } from "@/lib/ads/sync-plan";
import { prisma } from "@/lib/prisma";
import {
  GA_FIX_CATALOG,
  gaFixIsAlpha,
} from "@/lib/website-analytics/fixes/catalog";
import { GA_FIX_REFUSAL_MESSAGES } from "@/lib/website-analytics/fixes/copy";
import {
  gaFixKindEnabled,
  gaFixesEnabledFor,
} from "@/lib/website-analytics/fixes/flags";
import {
  GA_FIX_APPROVAL_TTL_MS,
  mockMatchesLink,
} from "@/lib/website-analytics/fixes/lifecycle";
import { retentionRank } from "@/lib/website-analytics/fixes/plan";
import type {
  GaFixKind,
  GaFixParams,
  GaFixRefusal,
  GaFixStatus,
} from "@/lib/website-analytics/fixes/types";
import { validateFixParams } from "@/lib/website-analytics/fixes/validate";
import { gaMockMode } from "@/server/integrations/google-analytics/data-api";
import { primaryGaLink } from "@/server/website-analytics/store";

import { syncGaFixApprovalState } from "./approval-hook";
import { recordGaFixAudit } from "./audit";
import { loadGaEditAccess } from "./edit-grant";
import { createGaFixApproval } from "./task-approval";
import type { GaFixDeps, ProposeInput, ProposeResult } from "./types";

// Öneri motoru (docs/website-fixes.md): doğrular, tek açık değişiklik kuralını
// uygular, GaConfigChange + Task + Approval kurar. Bu dosya Google'a ASLA
// yazma çağrısı yapmaz; yazma yalnız onaydan sonra apply.ts'tedir.

const KEY_EVENT_LIMIT_STANDARD = 30;
const KEY_EVENT_LIMIT_360 = 50;
// Onaylanmamış SYSTEM not önerileri bu sayıda dururken yenisi açılmaz.
const OPEN_SYSTEM_ANNOTATION_CAP = 3;

function refuse(code: GaFixRefusal): ProposeResult {
  return { ok: false, code, message: GA_FIX_REFUSAL_MESSAGES[code] };
}

function storedKeyEventNames(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as { eventName?: unknown }).eventName === "string"
    ) {
      names.push((item as { eventName: string }).eventName);
    }
  }
  return names;
}

// Yalnız bağın SAKLI verisine bakan ön kontroller; apply canlı okuyup
// yeniden planlar, bu yalnız bariz boş işleri baştan keser.
function precheck(params: GaFixParams, link: GaPropertyLink): GaFixRefusal | null {
  switch (params.kind) {
    case "KEY_EVENT_CREATE": {
      const names = storedKeyEventNames(link.keyEvents);
      if (!names) return null;
      if (names.includes(params.eventName)) return "already_satisfied";
      const limit =
        link.serviceLevel === "GOOGLE_ANALYTICS_360"
          ? KEY_EVENT_LIMIT_360
          : KEY_EVENT_LIMIT_STANDARD;
      return names.length >= limit ? "limit_reached" : null;
    }
    case "RETENTION_14M":
      return link.dataRetention &&
        retentionRank(link.dataRetention) >= retentionRank("FOURTEEN_MONTHS")
        ? "already_satisfied"
        : null;
    case "ENHANCED_MEASUREMENT":
      return link.streamId ? null : "no_stream";
    default:
      return null;
  }
}

function dedupeSubjectFor(params: GaFixParams, explicit?: string): string {
  if (explicit) return explicit;
  if (params.kind === "KEY_EVENT_CREATE") return params.eventName;
  if (params.kind === "ANNOTATION_CREATE") return `${params.day}:${params.title}`;
  return "-";
}

// Not önerisinde gün verilmediyse mülkün bugünü kullanılır.
function withDefaultDay(kind: GaFixKind, raw: unknown, today: string): unknown {
  if (kind !== "ANNOTATION_CREATE") return raw;
  if (!raw || typeof raw !== "object") return raw;
  const record = raw as Record<string, unknown>;
  return record.day === undefined || record.day === null
    ? { ...record, day: today }
    : raw;
}

function existingResult(change: GaConfigChange): ProposeResult {
  return {
    ok: true,
    changeId: change.id,
    status: change.status as GaFixStatus,
    created: false,
    approvalId: change.approvalId,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

async function findOpen(linkId: string, dedupeKey: string) {
  return prisma.gaConfigChange.findFirst({
    where: { linkId, openKey: dedupeKey },
  });
}

export async function proposeGaFix(
  input: ProposeInput,
  deps: GaFixDeps = {},
): Promise<ProposeResult> {
  const now = input.now ?? deps.now ?? new Date();
  const { projectId, kind } = input;

  if (!gaFixesEnabledFor(projectId)) return refuse("not_enabled");
  if (!gaFixKindEnabled(kind)) {
    return refuse(gaFixIsAlpha(kind) ? "alpha_off" : "not_enabled");
  }

  const link = await primaryGaLink(projectId);
  if (!link) return refuse("no_link");
  const credential = await prisma.integrationCredential.findUnique({
    where: { id: link.credentialId },
    select: { status: true },
  });
  if (!credential || credential.status !== "ACTIVE") return refuse("no_link");

  const mock = deps.mock ?? gaMockMode();
  // Mock süreci gerçek bağa, gerçek süreç mock bağa asla yazmaz.
  if (!mockMatchesLink(mock, link.isMock)) return refuse("not_allowed_here");

  const access = await loadGaEditAccess(projectId, { mock });
  if (!access || !access.granted) return refuse("no_edit_access");

  const today = dayKeyInTimezone(now, safeTimezone(link.timeZone));
  const validated = validateFixParams(
    kind,
    withDefaultDay(kind, input.raw, today),
    { today },
  );
  if (!validated.ok) {
    return { ok: false, code: "invalid", message: validated.message };
  }
  const params = validated.params;

  const refusal = precheck(params, link);
  if (refusal) return refuse(refusal);

  if (input.actor.type === "SYSTEM" && kind === "ANNOTATION_CREATE") {
    const open = await prisma.gaConfigChange.count({
      where: { projectId, kind, status: "PROPOSED" },
    });
    if (open >= OPEN_SYSTEM_ANNOTATION_CAP) return refuse("not_allowed_here");
  }

  const dedupeKey = `${kind}:${dedupeSubjectFor(params, input.dedupeSubject)}`;

  const existing = await findOpen(link.id, dedupeKey);
  if (existing) {
    if (existing.status !== "PROPOSED") return existingResult(existing);
    // Açık satırın onayı sohbetten reddedilmiş olabilir: önce hizala, kapandıysa
    // aşağıda taze bir değişiklik kurulur.
    const status = await syncGaFixApprovalState(existing.id, { now });
    if (status !== "REJECTED" && status !== "EXPIRED" && status !== null) {
      const fresh = await findOpen(link.id, dedupeKey);
      return fresh
        ? existingResult(fresh)
        : {
            ok: true,
            changeId: existing.id,
            status,
            created: false,
            approvalId: existing.approvalId,
          };
    }
  }

  const entry = GA_FIX_CATALOG[kind];
  const title = entry.title(params).slice(0, 80);
  const expiresAt = new Date(now.getTime() + GA_FIX_APPROVAL_TTL_MS);

  let change: GaConfigChange;
  try {
    change = await prisma.gaConfigChange.create({
      data: {
        workspaceId: link.workspaceId,
        projectId,
        linkId: link.id,
        kind,
        status: "PROPOSED",
        source: input.source,
        title,
        params: params as never,
        dedupeKey,
        openKey: dedupeKey,
        expiresAt,
        proposedByType: input.actor.type,
        proposedByUserId:
          input.actor.type === "USER" ? input.actor.userId : null,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Eşzamanlı öneri kazandı: onun satırını döndür.
    const winner = await findOpen(link.id, dedupeKey);
    if (winner) return existingResult(winner);
    throw error;
  }

  try {
    const { taskId, approvalId } = await createGaFixApproval({
      workspaceId: link.workspaceId,
      projectId,
      changeId: change.id,
      kind,
      params,
      title,
      actor: input.actor,
      expiresAt,
    });
    change = await prisma.gaConfigChange.update({
      where: { id: change.id },
      data: { taskId, approvalId },
    });
  } catch (error) {
    console.error(
      "[ga-fixes] proposal could not be requested:",
      error instanceof Error ? error.name : "unknown",
    );
    // Satır açık kalıp aynı konuyu kilitlemesin.
    await prisma.gaConfigChange
      .updateMany({
        where: { id: change.id, status: "PROPOSED" },
        data: { status: "EXPIRED", openKey: null },
      })
      .catch(() => undefined);
    return refuse("not_allowed_here");
  }

  await recordGaFixAudit(
    "ga_config_change.proposed",
    { changeId: change.id, kind, source: input.source },
    {
      workspaceId: link.workspaceId,
      projectId,
      userId: input.actor.type === "USER" ? input.actor.userId : null,
    },
  );

  return {
    ok: true,
    changeId: change.id,
    status: "PROPOSED",
    created: true,
    approvalId: change.approvalId,
  };
}

// Otomatik (SYSTEM) not önerisi: saklanan dedupeKey tam olarak
// `ANNOTATION_CREATE:${input.dedupeKey}` olur; çağıran kendi önekini
// (launch:<id>, publish:<hafta>) dahil eder.
export async function proposeGaAnnotation(
  input: { projectId: string; title: string; day?: string; dedupeKey: string },
  deps: GaFixDeps = {},
): Promise<ProposeResult> {
  return proposeGaFix(
    {
      projectId: input.projectId,
      kind: "ANNOTATION_CREATE",
      raw: { title: input.title, day: input.day },
      source: "AUTO",
      actor: { type: "SYSTEM" },
      dedupeSubject: input.dedupeKey,
    },
    deps,
  );
}
