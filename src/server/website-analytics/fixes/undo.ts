import "server-only";

import {
  Prisma,
  type GaConfigChange,
  type GaPropertyLink,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { gaFixIsAlpha } from "@/lib/website-analytics/fixes/catalog";
import {
  GA_FIX_ERROR_MESSAGES,
  fixErrorFor,
} from "@/lib/website-analytics/fixes/copy";
import {
  gaFixKindEnabled,
  gaFixesEnabledFor,
} from "@/lib/website-analytics/fixes/flags";
import {
  GA_FIX_LEASE_MS,
  mockMatchesLink,
} from "@/lib/website-analytics/fixes/lifecycle";
import { planUndo, undoPrecondition } from "@/lib/website-analytics/fixes/plan";
import { verifyUndo } from "@/lib/website-analytics/fixes/readback";
import {
  GA_FIX_KINDS,
  type GaFixCurrent,
  type GaFixError,
  type GaFixErrorCode,
  type GaFixKind,
  type GaFixSnapshot,
  type GaFixSource,
  type GaFixUndoOp,
} from "@/lib/website-analytics/fixes/types";
import type { GaAdminWriter } from "@/server/integrations/google-analytics/admin-write";
import { GoogleApiError } from "@/server/integrations/google/errors";

import { recordGaFixAudit } from "./audit";
import { readGaFixCurrent } from "./apply";
import { resolveGaFixDeps } from "./deps";
import { clearGaEditGrant, loadGaEditAccess } from "./edit-grant";
import type { GaFixDeps } from "./types";

// GA-F7 geri alma (docs/website-fixes.md, "Undo"): bilinçli OWNER/ADMIN
// tıklaması, ikinci onay değil. VERIFIED -> UNDOING -> UNDONE; her başarısızlık
// VERIFIED'a döner (error.undo = true). Tek örnekli kaynaklarda (saklama,
// gelişmiş ölçüm) canlı durum hâlâ düzeltmenin bıraktığı gibi değilse
// üzerine yazılmaz (cannot_undo). Yazıcının yazan üyelerini yalnız apply.ts
// ve bu dosya çağırır.

const MANAGER_ROLES = new Set(["OWNER", "ADMIN"]);

const NOT_MANAGER_MESSAGE = "Only a workspace owner or admin can undo this.";
const NOT_FOUND_MESSAGE = "This change was not found.";
const NOT_UNDOABLE_MESSAGE = "This change can't be undone.";
const BUSY_MESSAGE = "This change is busy right now. Try again in a moment.";

type ChangeWithLink = GaConfigChange & { link: GaPropertyLink };
type UndoResult = { ok: true } | { ok: false; message: string };

function isFixKind(value: string): value is GaFixKind {
  return (GA_FIX_KINDS as readonly string[]).includes(value);
}

function refuse(code: GaFixErrorCode): UndoResult {
  return { ok: false, message: GA_FIX_ERROR_MESSAGES[code] };
}

// Üye rolü satır içi aranır (tenant-context'i içe aktarmak next-auth'u işçiye
// taşırdı). 'telegram:<id>' sözde kullanıcısının rolü yoktur.
async function isManager(
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  if (userId.includes(":")) return false;
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  return member !== null && MANAGER_ROLES.has(member.role);
}

function logName(step: string, error: unknown): void {
  console.error(
    `[ga-fixes] undo ${step} failed:`,
    error instanceof Error ? error.name : "unknown",
  );
}

// Geri alma işlemi. Silmelerde 404 "zaten yok" sayılır (kaybolan yanıttan
// sonraki DELETE yeniden denemesi 404 görebilir) ve doğrudan geri okumaya geçilir.
async function executeUndo(
  writer: GaAdminWriter,
  propertyId: string,
  undo: GaFixUndoOp,
): Promise<void> {
  try {
    switch (undo.op) {
      case "deleteKeyEvent":
        await writer.deleteKeyEvent(undo.resourceName);
        return;
      case "restoreRetention":
        await writer.updateDataRetention(propertyId, undo.value);
        return;
      case "restoreEnhanced":
        await writer.updateEnhancedMeasurement(
          propertyId,
          undo.streamId,
          undo.patch,
        );
        return;
      case "deleteChannelGroup":
        await writer.deleteChannelGroup(undo.resourceName);
        return;
      case "deleteAnnotation":
        await writer.deleteAnnotation(undo.resourceName);
        return;
    }
  } catch (error) {
    const isDelete =
      undo.op === "deleteKeyEvent" ||
      undo.op === "deleteChannelGroup" ||
      undo.op === "deleteAnnotation";
    const gone =
      error instanceof GoogleApiError &&
      (error.httpStatus === 404 || error.errorClass === "NOT_FOUND");
    if (isDelete && gone) return;
    throw error;
  }
}

function errorJson(error: GaFixError): Prisma.InputJsonValue {
  return {
    code: error.code,
    message: error.message,
    ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
    undo: true,
  };
}

export async function undoGaConfigChange(
  input: { projectId: string; changeId: string; userId: string },
  deps?: GaFixDeps,
): Promise<UndoResult> {
  const d = resolveGaFixDeps(deps);

  const change: ChangeWithLink | null = await prisma.gaConfigChange.findFirst({
    where: { id: input.changeId, projectId: input.projectId },
    include: { link: true },
  });
  if (!change) return { ok: false, message: NOT_FOUND_MESSAGE };

  // Yetki ilk kapı: yazıcıya hiçbir çağrı yapılmadan reddedilir.
  if (!(await isManager(input.userId, change.workspaceId))) {
    return { ok: false, message: NOT_MANAGER_MESSAGE };
  }
  if (!isFixKind(change.kind))
    return { ok: false, message: NOT_UNDOABLE_MESSAGE };
  const kind = change.kind;
  if (change.status !== "VERIFIED" || change.noop) {
    return { ok: false, message: NOT_UNDOABLE_MESSAGE };
  }
  if (!gaFixesEnabledFor(change.projectId) || !gaFixKindEnabled(kind)) {
    return refuse("not_enabled");
  }
  const link = change.link;
  if (!link.isPrimary) return refuse("property_changed");
  if (!mockMatchesLink(d.mock, link.isMock)) return refuse("not_enabled");

  const credential = await prisma.integrationCredential.findUnique({
    where: { id: link.credentialId },
    select: {
      id: true,
      status: true,
      encryptedSecret: true,
      workspaceId: true,
    },
  });
  if (!credential || credential.workspaceId !== change.workspaceId) {
    return refuse("property_changed");
  }
  if (credential.status !== "ACTIVE" || !credential.encryptedSecret) {
    return refuse("reconnect");
  }
  const access = await loadGaEditAccess(change.projectId, { mock: d.mock });
  if (!access || !access.granted) return refuse("no_edit_access");
  if (access.credentialId !== credential.id) return refuse("property_changed");

  const before = change.before as unknown as GaFixSnapshot | null;
  const after = change.after as unknown as GaFixSnapshot | null;
  const planned = planUndo({
    kind,
    noop: change.noop,
    before,
    after,
    resourceName: change.resourceName,
  });
  if (!planned.ok) return { ok: false, message: NOT_UNDOABLE_MESSAGE };
  const undo = planned.undo;

  // VERIFIED -> UNDOING: tek koşu elde tutar.
  const owner = `ga-undo:${process.pid}:${d.now.getTime()}:${change.id}`;
  const claimed = await prisma.gaConfigChange.updateMany({
    where: {
      id: change.id,
      status: "VERIFIED",
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: d.now } }],
    },
    data: {
      status: "UNDOING",
      leaseUntil: new Date(d.now.getTime() + GA_FIX_LEASE_MS),
      leaseOwner: owner,
    },
  });
  if (claimed.count !== 1) return { ok: false, message: BUSY_MESSAGE };

  const backToVerified = async (error: GaFixError): Promise<UndoResult> => {
    await prisma.gaConfigChange.updateMany({
      where: { id: change.id, status: "UNDOING", leaseOwner: owner },
      data: {
        status: "VERIFIED",
        error: errorJson(error),
        leaseUntil: null,
        leaseOwner: null,
      },
    });
    return { ok: false, message: error.message };
  };

  try {
    const token = await d.tokenFor({
      id: credential.id,
      encryptedSecret: credential.encryptedSecret,
    });
    const writer = d.writerFor(token);

    const beforeUndo = await readGaFixCurrent(writer, link, kind);
    if (!undoPrecondition({ kind, after, before }, beforeUndo)) {
      return await backToVerified({
        code: "cannot_undo",
        message: GA_FIX_ERROR_MESSAGES.cannot_undo,
      });
    }

    await executeUndo(writer, link.propertyId, undo);

    const live: GaFixCurrent = await readGaFixCurrent(writer, link, kind);
    if (!verifyUndo(undo, live)) {
      return await backToVerified({
        code: "readback_mismatch",
        message: GA_FIX_ERROR_MESSAGES.readback_mismatch,
      });
    }

    const done = await prisma.gaConfigChange.updateMany({
      where: { id: change.id, status: "UNDOING", leaseOwner: owner },
      data: {
        status: "UNDONE",
        rolledBackAt: d.now,
        undoneByUserId: input.userId,
        openKey: null,
        error: Prisma.DbNull,
        leaseUntil: null,
        leaseOwner: null,
      },
    });
    if (done.count !== 1) return { ok: false, message: BUSY_MESSAGE };

    await updateLinkColumns(change.linkId, live);
    await recordGaFixAudit(
      "ga_config_change.undone",
      {
        changeId: change.id,
        kind,
        source: change.source as GaFixSource,
      },
      {
        workspaceId: change.workspaceId,
        projectId: change.projectId,
        userId: input.userId,
      },
    );
    return { ok: true };
  } catch (error) {
    const google = error instanceof GoogleApiError ? error : null;
    const errorClass = google?.errorClass ?? "UNKNOWN";
    if (errorClass === "SCOPE_MISSING") {
      await clearGaEditGrant(link.credentialId).catch((clearError: unknown) =>
        logName("edit grant clear", clearError),
      );
    }
    const mapped = fixErrorFor({
      errorClass,
      httpStatus: google?.httpStatus,
      message: google?.message,
      alpha: gaFixIsAlpha(kind),
    });
    try {
      return await backToVerified(mapped);
    } catch (restoreError) {
      // Durum yazılamadıysa kilit süresi dolunca reconcile VERIFIED'a döndürür.
      logName("state restore", restoreError);
      return { ok: false, message: mapped.message };
    }
  }
}

// Geri almadan sonra bağın saklı sütunlarını canlı okumayla tazeler (en iyi çaba).
async function updateLinkColumns(
  linkId: string,
  live: GaFixCurrent,
): Promise<void> {
  try {
    if (live.kind === "KEY_EVENT_CREATE") {
      await prisma.gaPropertyLink.update({
        where: { id: linkId },
        data: {
          keyEvents: live.keyEvents.map((event) => ({
            eventName: event.eventName,
            countingMethod: event.countingMethod,
            createTime: null,
          })) as Prisma.InputJsonValue,
        },
      });
    } else if (live.kind === "RETENTION_14M") {
      await prisma.gaPropertyLink.update({
        where: { id: linkId },
        data: { dataRetention: live.retention.eventDataRetention },
      });
    }
  } catch (error) {
    logName("link column update", error);
  }
}
