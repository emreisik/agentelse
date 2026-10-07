import "server-only";

import {
  Prisma,
  type GaConfigChange,
  type GaPropertyLink,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  gaFixKindEnabled,
  gaFixesEnabledFor,
} from "@/lib/website-analytics/fixes/flags";
import { gaFixIsAlpha } from "@/lib/website-analytics/fixes/catalog";
import {
  GA_FIX_ERROR_MESSAGES,
  fixErrorFor,
} from "@/lib/website-analytics/fixes/copy";
import {
  GA_FIX_LEASE_MS,
  GA_FIX_MAX_ATTEMPTS,
  fixBackoffMs,
  mockMatchesLink,
} from "@/lib/website-analytics/fixes/lifecycle";
import { planFix } from "@/lib/website-analytics/fixes/plan";
import { verifyReadBack } from "@/lib/website-analytics/fixes/readback";
import {
  GA_FIX_KINDS,
  type GaFixCurrent,
  type GaFixError,
  type GaFixErrorCode,
  type GaFixKind,
  type GaFixParams,
  type GaFixSnapshot,
  type GaFixSource,
  type GaFixWrite,
} from "@/lib/website-analytics/fixes/types";
import type { GaAdminWriter } from "@/server/integrations/google-analytics/admin-write";
import { GoogleApiError } from "@/server/integrations/google/errors";
import { TaskRepository } from "@/server/repositories/task.repository";

import { recordGaFixAudit } from "./audit";
import { resolveGaFixDeps, type ResolvedGaFixDeps } from "./deps";
import { clearGaEditGrant, loadGaEditAccess } from "./edit-grant";
import type { GaFixDeps } from "./types";

// GA-F7 uygulama motoru (docs/website-fixes.md, "ENGINE TRANSITIONS").
// Sıra: bayrak -> CAS kilidi -> kapılar -> canlı "önce" okuması -> plan ->
// yazma -> canlı geri okuma -> doğrulama. Yazıcının yazan üyelerini yalnız
// bu dosya ve undo.ts çağırır. Onaylanmamış satıra, kapalı bayrakla ya da
// izin yokken asla yazılmaz; her yazma geri okunur.

export type ApplyState =
  "verified" | "noop" | "failed" | "retry" | "busy" | "gone" | "skipped";

type ChangeWithLink = GaConfigChange & { link: GaPropertyLink };

// Standart mülkte 30, 360'ta 50 key event (doğrulanmalı: Google belgeleri).
const KEY_EVENT_LIMIT_STANDARD = 30;
const KEY_EVENT_LIMIT_360 = 50;

// Kapı ve mantık hataları: yazıcı çağrılmadan önce fırlatılır, kodu sabittir.
class GaFixStop extends Error {
  constructor(readonly code: GaFixErrorCode) {
    super(code);
    this.name = "GaFixStop";
  }
}

function isFixKind(value: string): value is GaFixKind {
  return (GA_FIX_KINDS as readonly string[]).includes(value);
}

function keyEventLimit(serviceLevel: string | null): number {
  return serviceLevel === "GOOGLE_ANALYTICS_360"
    ? KEY_EVENT_LIMIT_360
    : KEY_EVENT_LIMIT_STANDARD;
}

// Canlı okuma: apply (önce ve geri okuma) ve undo ortak kullanır. Yazmaz.
export async function readGaFixCurrent(
  writer: GaAdminWriter,
  link: Pick<GaPropertyLink, "propertyId" | "streamId" | "serviceLevel">,
  kind: GaFixKind,
): Promise<GaFixCurrent> {
  switch (kind) {
    case "KEY_EVENT_CREATE":
      return {
        kind,
        keyEvents: await writer.listKeyEvents(link.propertyId),
        limit: keyEventLimit(link.serviceLevel),
      };
    case "RETENTION_14M":
      return {
        kind,
        retention: await writer.getDataRetention(link.propertyId),
      };
    case "ENHANCED_MEASUREMENT": {
      if (!link.streamId) throw new GaFixStop("no_stream");
      return {
        kind,
        streamId: link.streamId,
        settings: await writer.getEnhancedMeasurement(
          link.propertyId,
          link.streamId,
        ),
      };
    }
    case "CHANNEL_GROUP_AI":
      return { kind, groups: await writer.listChannelGroups(link.propertyId) };
    case "ANNOTATION_CREATE":
      return {
        kind,
        annotations: await writer.listAnnotations(link.propertyId),
      };
  }
}

async function executeWrite(
  writer: GaAdminWriter,
  propertyId: string,
  write: GaFixWrite,
): Promise<{ resourceName: string | null }> {
  switch (write.op) {
    case "createKeyEvent": {
      const created = await writer.createKeyEvent(propertyId, write.eventName);
      return { resourceName: created.name };
    }
    case "updateRetention":
      await writer.updateDataRetention(propertyId, write.value);
      return { resourceName: null };
    case "updateEnhanced": {
      const updated = await writer.updateEnhancedMeasurement(
        propertyId,
        write.streamId,
        write.patch,
      );
      return { resourceName: updated.name };
    }
    case "createChannelGroup": {
      const created = await writer.createChannelGroup(propertyId, write.body);
      return { resourceName: created.name };
    }
    case "createAnnotation": {
      const created = await writer.createAnnotation(propertyId, write.input);
      return { resourceName: created.name };
    }
  }
}

function isCreateWrite(write: GaFixWrite): boolean {
  return (
    write.op === "createKeyEvent" ||
    write.op === "createChannelGroup" ||
    write.op === "createAnnotation"
  );
}

// Yazma döndükten sonra (APPLIED) çökmüş ya da geri okuması düşmüş bir
// satırın yazması yeniden kurulur: "önce" görüntüsünden sahte bir canlı
// durum üretilip planFix'ten geçirilir; böylece ikinci bir yazma olmadan
// doğru GaFixWrite elde edilir.
function currentFromBefore(
  kind: GaFixKind,
  before: GaFixSnapshot | null,
  link: Pick<GaPropertyLink, "propertyId">,
): GaFixCurrent | null {
  switch (kind) {
    case "KEY_EVENT_CREATE":
      return {
        kind,
        keyEvents: [],
        limit: Number.MAX_SAFE_INTEGER,
      };
    case "RETENTION_14M": {
      const previous =
        before?.kind === "RETENTION_14M" ? before.eventDataRetention : null;
      return {
        kind,
        retention: {
          eventDataRetention: previous ?? "TWO_MONTHS",
          resetUserDataOnNewActivity: false,
        },
      };
    }
    case "ENHANCED_MEASUREMENT": {
      if (before?.kind !== "ENHANCED_MEASUREMENT") return null;
      return {
        kind,
        streamId: before.streamId,
        settings: {
          name: `properties/${link.propertyId}/dataStreams/${before.streamId}/enhancedMeasurementSettings`,
          streamEnabled: before.streamEnabled,
          scrollsEnabled: before.scrollsEnabled,
          outboundClicksEnabled: before.outboundClicksEnabled,
          siteSearchEnabled: before.siteSearchEnabled,
          videoEngagementEnabled: false,
          fileDownloadsEnabled: before.fileDownloadsEnabled,
          formInteractionsEnabled: false,
          pageChangesEnabled: false,
          searchQueryParameter: before.searchQueryParameter ?? "",
          uriQueryParameter: null,
        },
      };
    }
    case "CHANNEL_GROUP_AI":
      return { kind, groups: [] };
    case "ANNOTATION_CREATE":
      return { kind, annotations: [] };
  }
}

function reconstructWrite(
  params: GaFixParams,
  before: GaFixSnapshot | null,
  link: Pick<GaPropertyLink, "propertyId">,
): GaFixWrite {
  const current = currentFromBefore(params.kind, before, link);
  if (!current) throw new GaFixStop("unknown");
  const plan = planFix(params, current);
  if (plan.kind !== "write") throw new GaFixStop("unknown");
  return plan.write;
}

function snapshotJson(value: GaFixSnapshot): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

function errorJson(error: GaFixError): Prisma.InputJsonValue {
  return {
    code: error.code,
    message: error.message,
    ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
  };
}

function stopError(code: GaFixErrorCode): GaFixError {
  return { code, message: GA_FIX_ERROR_MESSAGES[code], retryable: false };
}

function logName(step: string, error: unknown): void {
  console.error(
    `[ga-fixes] ${step} failed:`,
    error instanceof Error ? error.name : "unknown",
  );
}

type Run = {
  change: ChangeWithLink;
  kind: GaFixKind;
  params: GaFixParams;
  d: ResolvedGaFixDeps;
  owner: string;
  // "pre": yazma henüz dönmedi (APPLYING); "applied": yazma döndü (APPLIED).
  phase: "pre" | "applied";
};

function runFrom(run: Run): "APPLYING" | "APPLIED" {
  return run.phase === "pre" ? "APPLYING" : "APPLIED";
}

// Yalnız kilidi hâlâ elinde tutan koşu günceller; düşmüşse sessizce çıkar.
async function advance(
  run: Run,
  from: "APPLYING" | "APPLIED",
  data: Prisma.GaConfigChangeUpdateManyMutationInput,
): Promise<boolean> {
  const result = await prisma.gaConfigChange.updateMany({
    where: { id: run.change.id, status: from, leaseOwner: run.owner },
    data,
  });
  return result.count === 1;
}

// Task'ı kapatır (en iyi çaba). WAITING_APPROVAL/QUEUED -> RUNNING -> son durum.
async function finishTask(
  change: ChangeWithLink,
  to: "COMPLETED" | "FAILED",
  failureReason?: string,
): Promise<void> {
  if (!change.taskId) return;
  const task = await prisma.task.findFirst({
    where: { id: change.taskId, projectId: change.projectId },
    select: { status: true },
  });
  if (!task) return;
  if (
    task.status === "COMPLETED" ||
    task.status === "FAILED" ||
    task.status === "CANCELLED"
  ) {
    return;
  }
  if (task.status !== "RUNNING") {
    await TaskRepository.transition(change.taskId, change.projectId, "RUNNING");
  }
  await TaskRepository.transition(
    change.taskId,
    change.projectId,
    to,
    to === "FAILED" ? { failureReason } : undefined,
  );
}

// Son durum sonrası adımlar: her biri kendi try/catch'inde, yalnız ad loglar.
async function postSteps(
  run: Run,
  outcome:
    { ok: true; live: GaFixCurrent | null } | { ok: false; error: GaFixError },
): Promise<void> {
  const { change, kind, d } = run;
  if (outcome.ok) {
    const live = outcome.live;
    try {
      if (live?.kind === "KEY_EVENT_CREATE") {
        await prisma.gaPropertyLink.update({
          where: { id: change.linkId },
          data: {
            keyEvents: live.keyEvents.map((event) => ({
              eventName: event.eventName,
              countingMethod: event.countingMethod,
              createTime: null,
            })) as Prisma.InputJsonValue,
          },
        });
      } else if (live?.kind === "RETENTION_14M") {
        await prisma.gaPropertyLink.update({
          where: { id: change.linkId },
          data: { dataRetention: live.retention.eventDataRetention },
        });
      }
    } catch (error) {
      logName("link column update", error);
    }
    try {
      await prisma.gaHealthRun.updateMany({
        where: { linkId: change.linkId },
        data: { recheckRequestedAt: d.now },
      });
    } catch (error) {
      logName("health recheck request", error);
    }
  }
  try {
    await recordGaFixAudit(
      outcome.ok ? "ga_config_change.verified" : "ga_config_change.failed",
      {
        changeId: change.id,
        kind,
        source: change.source as GaFixSource,
        ...(outcome.ok ? {} : { code: outcome.error.code }),
      },
      { workspaceId: change.workspaceId, projectId: change.projectId },
    );
  } catch (error) {
    logName("audit", error);
  }
  try {
    await finishTask(
      change,
      outcome.ok ? "COMPLETED" : "FAILED",
      outcome.ok ? undefined : outcome.error.message,
    );
  } catch (error) {
    logName("task finish", error);
  }
}

async function failRun(
  run: Run,
  error: GaFixError,
): Promise<{ state: ApplyState }> {
  const moved = await advance(run, runFrom(run), {
    status: "FAILED",
    openKey: null,
    failedAt: run.d.now,
    error: errorJson(error),
    leaseUntil: null,
    leaseOwner: null,
  });
  if (!moved) return { state: "busy" };
  await postSteps(run, { ok: false, error });
  return { state: "failed" };
}

async function verifyRun(
  run: Run,
  data: {
    before?: GaFixSnapshot;
    after: GaFixSnapshot;
    resourceName: string | null;
    noop: boolean;
    live: GaFixCurrent | null;
  },
): Promise<{ state: ApplyState }> {
  const moved = await advance(run, runFrom(run), {
    status: "VERIFIED",
    openKey: null,
    verifiedAt: run.d.now,
    after: snapshotJson(data.after),
    ...(data.before ? { before: snapshotJson(data.before) } : {}),
    ...(data.resourceName ? { resourceName: data.resourceName } : {}),
    ...(data.noop ? { noop: true } : {}),
    error: Prisma.DbNull,
    leaseUntil: null,
    leaseOwner: null,
  });
  if (!moved) return { state: "busy" };
  await postSteps(run, { ok: true, live: data.live });
  return { state: data.noop ? "noop" : "verified" };
}

// Kapılar: herhangi biri düşerse yazıcı ASLA çağrılmaz.
async function passGates(
  run: Run,
  readBackOnly: boolean,
): Promise<{ id: string; encryptedSecret: string }> {
  const { change, d } = run;
  const link = change.link;

  if (!readBackOnly) {
    if (!change.approvalId) throw new GaFixStop("approval_missing");
    // Yalnız status: expiresAt PENDING iken anlamlıdır, decide() zaten sınar.
    const approval = await prisma.approval.findFirst({
      where: { id: change.approvalId },
      select: { status: true },
    });
    if (approval?.status !== "APPROVED")
      throw new GaFixStop("approval_missing");
    if (!link.isPrimary) throw new GaFixStop("property_changed");
  }

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
    throw new GaFixStop("property_changed");
  }
  if (credential.status !== "ACTIVE" || !credential.encryptedSecret) {
    throw new GaFixStop("reconnect");
  }
  if (!mockMatchesLink(d.mock, link.isMock)) throw new GaFixStop("not_enabled");

  if (!readBackOnly) {
    const access = await loadGaEditAccess(change.projectId, { mock: d.mock });
    if (!access || !access.granted) throw new GaFixStop("no_edit_access");
    if (access.credentialId !== credential.id) {
      throw new GaFixStop("property_changed");
    }
  }
  return { id: credential.id, encryptedSecret: credential.encryptedSecret };
}

async function readBackPhase(
  run: Run,
  writer: GaAdminWriter,
  write: GaFixWrite,
): Promise<{ state: ApplyState }> {
  const live = await readGaFixCurrent(writer, run.change.link, run.kind);
  const check = verifyReadBack(run.params, write, live);
  if (!check.ok) return failRun(run, stopError("readback_mismatch"));
  return verifyRun(run, {
    after: check.snapshot,
    resourceName: check.resourceName,
    noop: false,
    live,
  });
}

async function writePhase(
  run: Run,
  writer: GaAdminWriter,
): Promise<{ state: ApplyState }> {
  const { change, kind, params } = run;
  const link = change.link;

  let current = await readGaFixCurrent(writer, link, kind);
  let plan = planFix(params, current);

  if (plan.kind === "noop") {
    return verifyRun(run, {
      before: plan.snapshot,
      after: plan.snapshot,
      resourceName: change.resourceName,
      noop: true,
      live: current,
    });
  }
  if (plan.kind === "refuse") return failRun(run, stopError("limit_reached"));

  const persisted = await advance(run, "APPLYING", {
    before: snapshotJson(plan.before),
  });
  if (!persisted) return { state: "busy" };

  let written: { resourceName: string | null };
  try {
    written = await executeWrite(writer, link.propertyId, plan.write);
  } catch (error) {
    const conflict =
      error instanceof GoogleApiError &&
      error.httpStatus === 409 &&
      isCreateWrite(plan.write);
    if (!conflict) throw error;
    // 409: kaynak zaten var (kayıp yanıt ya da yarış). Yeniden oku, yeniden planla.
    current = await readGaFixCurrent(writer, link, kind);
    plan = planFix(params, current);
    if (plan.kind !== "noop")
      return failRun(run, stopError("rejected_by_google"));
    return verifyRun(run, {
      before: plan.snapshot,
      after: plan.snapshot,
      resourceName: change.resourceName,
      noop: true,
      live: current,
    });
  }

  const write = plan.write;
  const applied = await advance(run, "APPLYING", {
    status: "APPLIED",
    appliedAt: run.d.now,
    ...(written.resourceName ? { resourceName: written.resourceName } : {}),
    leaseUntil: new Date(run.d.now.getTime() + GA_FIX_LEASE_MS),
    // Geri okuma kendi deneme bütçesini kullanır: yazma öncesi denemeler sayılmaz.
    attempts: 1,
  });
  if (!applied) return { state: "busy" };
  run.phase = "applied";
  run.change.attempts = 1;

  return readBackPhase(run, writer, write);
}

// Google ya da mantık hatasını duruma çevirir (ENGINE TRANSITIONS).
async function handleError(
  run: Run,
  error: unknown,
): Promise<{ state: ApplyState }> {
  if (error instanceof GaFixStop) return failRun(run, stopError(error.code));

  const google = error instanceof GoogleApiError ? error : null;
  const errorClass = google?.errorClass ?? "UNKNOWN";
  const mapped = fixErrorFor({
    errorClass,
    httpStatus: google?.httpStatus,
    message: google?.message,
    alpha: gaFixIsAlpha(run.kind),
  });
  if (errorClass === "SCOPE_MISSING") {
    await clearGaEditGrant(run.change.link.credentialId).catch(
      (clearError: unknown) => logName("edit grant clear", clearError),
    );
  }
  const attempts = run.change.attempts;

  if (run.phase === "pre") {
    if (mapped.retryable && attempts < GA_FIX_MAX_ATTEMPTS) {
      const moved = await advance(run, "APPLYING", {
        status: "APPROVED",
        nextAttemptAt: new Date(
          run.d.now.getTime() + fixBackoffMs(attempts, errorClass),
        ),
        leaseUntil: null,
        leaseOwner: null,
      });
      return { state: moved ? "retry" : "busy" };
    }
    return failRun(run, { ...mapped, retryable: mapped.retryable });
  }

  // Yazma döndü: asla ikinci yazma yok, yalnız geri okuma yeniden denenir.
  const hopeless =
    errorClass === "SCOPE_MISSING" ||
    errorClass === "AUTH" ||
    errorClass === "PERMISSION";
  if (hopeless) return failRun(run, mapped);
  if (attempts < GA_FIX_MAX_ATTEMPTS) {
    const moved = await advance(run, "APPLIED", {
      nextAttemptAt: new Date(
        run.d.now.getTime() + fixBackoffMs(attempts, errorClass),
      ),
      leaseUntil: null,
      leaseOwner: null,
    });
    return { state: moved ? "retry" : "busy" };
  }
  return failRun(run, {
    code: "google_unavailable",
    message: GA_FIX_ERROR_MESSAGES.google_unavailable,
    retryable: false,
  });
}

export async function applyGaConfigChange(
  changeId: string,
  deps?: GaFixDeps,
): Promise<{ state: ApplyState }> {
  const d = resolveGaFixDeps(deps);

  const head = await prisma.gaConfigChange.findUnique({
    where: { id: changeId },
    select: { id: true, status: true, kind: true, projectId: true },
  });
  if (!head) return { state: "gone" };
  if (head.status === "APPLYING" || head.status === "UNDOING") {
    return { state: "busy" };
  }
  if (head.status !== "APPROVED" && head.status !== "APPLIED") {
    return { state: "skipped" };
  }
  if (!isFixKind(head.kind)) return { state: "skipped" };
  const kind = head.kind;

  // Bayrak kapalıyken (ya da v1alpha kapatma anahtarıyla) satıra dokunulmaz:
  // onaylı satır bekler, FAILED'a çevrilmez. Yazma zaten dönmüş (APPLIED) satır
  // yalnız geri okunur; kind kapatma anahtarı onu sonsuza dek bekletmesin diye
  // yalnız ana bayrak aranır.
  const readBackOnly = head.status === "APPLIED";
  if (
    !gaFixesEnabledFor(head.projectId) ||
    (!readBackOnly && !gaFixKindEnabled(kind))
  ) {
    return { state: "skipped" };
  }

  const owner = `ga-fix:${process.pid}:${d.now.getTime()}:${changeId}`;
  const claimed = await prisma.gaConfigChange.updateMany({
    where: {
      id: changeId,
      status: head.status,
      AND: [
        { OR: [{ leaseUntil: null }, { leaseUntil: { lt: d.now } }] },
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: d.now } }] },
      ],
    },
    data: {
      status: readBackOnly ? "APPLIED" : "APPLYING",
      leaseUntil: new Date(d.now.getTime() + GA_FIX_LEASE_MS),
      leaseOwner: owner,
      attempts: { increment: 1 },
    },
  });
  if (claimed.count !== 1) return { state: "busy" };

  const change = await prisma.gaConfigChange.findUnique({
    where: { id: changeId },
    include: { link: true },
  });
  if (!change) return { state: "gone" };
  if (change.leaseOwner !== owner) return { state: "busy" };

  const run: Run = {
    change,
    kind,
    params: change.params as unknown as GaFixParams,
    d,
    owner,
    phase: readBackOnly ? "applied" : "pre",
  };

  try {
    if (run.params.kind !== kind) throw new GaFixStop("unknown");
    const credential = await passGates(run, readBackOnly);
    const token = await d.tokenFor(credential);
    const writer = d.writerFor(token);
    if (readBackOnly) {
      const write = reconstructWrite(
        run.params,
        change.before as unknown as GaFixSnapshot | null,
        change.link,
      );
      return await readBackPhase(run, writer, write);
    }
    return await writePhase(run, writer);
  } catch (error) {
    try {
      return await handleError(run, error);
    } catch (handlerError) {
      // Durum yazılamadıysa kilit süresi dolunca reconcile devralır.
      logName("error handling", handlerError);
      return { state: "busy" };
    }
  }
}
