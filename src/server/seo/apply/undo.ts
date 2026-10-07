import "server-only";

import { Prisma, type CmsSite, type SeoChange } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { SEO_CHANGE_ERROR_MESSAGES } from "@/lib/seo/apply/copy";
import { mockMatchesSite, seoApplyEnabledFor } from "@/lib/seo/apply/flags";
import { SEO_APPLY_LEASE_MS, isUndoable } from "@/lib/seo/apply/lifecycle";
import {
  SEO_CHANGE_KINDS,
  type SeoChangeErrorCode,
  type SeoChangeKind,
  type SeoChangeParams,
  type SeoChangeSource,
  type SeoChangeStatus,
  type SeoFieldsCapability,
  type WpSnapshot,
  type WpType,
} from "@/lib/seo/apply/types";
import { snapshotOf } from "@/lib/seo/apply/wp/snapshot";
import {
  planUndo,
  undoPrecondition,
  verifyUndo,
  type UndoOp,
} from "@/lib/seo/apply/wp/undo";
import type { WpObject } from "@/lib/seo/apply/wp/wp-types";
import type { WordPressClient } from "@/server/integrations/wordpress/client";
import { wpErrorToChangeCode } from "@/server/integrations/wordpress/errors";

import { enqueueIndexNow, syncDraftChainAfter } from "./apply";
import { onChangeUndone } from "./action-link";
import { recordSeoApplyAudit } from "./audit";
import { resolveApplyDeps } from "./deps";
import { isManagerInline } from "./roles";
import { gateApplySite } from "./site";
import type { SeoApplyDeps } from "./types";

// SC-F8 geri alma (docs/website-apply.md, "Undo"): bilinçli OWNER/ADMIN
// tıklaması, ikinci onay değil. VERIFIED ya da yazısı inmiş FAILED ->
// UNDOING -> UNDONE; her başarısızlık geldiği duruma döner (error.undo =
// true; verifiedAt ayırt eder). Sayfa değişiklikten sonra yeniden
// düzenlendiyse üzerine yazılmaz (cannot_undo). İstemcinin yazan üyelerini
// yalnız apply.ts ve bu dosya çağırır.

const ADOPT_WINDOW_MS = 30 * 60_000;

const NOT_MANAGER_MESSAGE = "Only a workspace owner or admin can undo this.";
const NOT_FOUND_MESSAGE = "This change was not found.";
const NOT_UNDOABLE_MESSAGE = "This change can't be undone.";
const BUSY_MESSAGE = "This change is busy right now. Try again in a moment.";

type UndoResult = { ok: true } | { ok: false; message: string };
type Row = SeoChange & { site: CmsSite };

function isChangeKind(value: string): value is SeoChangeKind {
  return (SEO_CHANGE_KINDS as readonly string[]).includes(value);
}

function refuse(code: SeoChangeErrorCode): UndoResult {
  return { ok: false, message: SEO_CHANGE_ERROR_MESSAGES[code] };
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

function logName(step: string, error: unknown): void {
  console.error(
    `[seo-apply] undo ${step} failed:`,
    error instanceof Error ? error.name : "unknown",
  );
}

// Geri almayı yazan koşunun sonucu: hedef nesne ve kalıcı durum.
function targetOf(
  change: Row,
  params: SeoChangeParams,
  after: WpSnapshot | null,
): { type: WpType; id: number } | null {
  if (params.kind !== "PUBLISH_ARTICLE") {
    return { type: params.wpType, id: params.wpId };
  }
  const id = change.wpId ?? after?.id ?? null;
  return id === null ? null : { type: "post", id };
}

// wpId bilinmeyen (yazısı indi ama yanıtı kayboldu) makale taslağını bulur:
// aynı başlık, taslak ve uygulama anına yakın değişmiş tek aday.
async function findDraftForUndo(
  client: WordPressClient,
  params: SeoChangeParams,
  appliedAt: Date | null,
): Promise<WpObject | null> {
  if (params.kind !== "PUBLISH_ARTICLE") return null;
  const found = await client.searchDrafts(params.title);
  const base = (appliedAt ?? new Date()).getTime();
  const matches = found.filter(
    (object) =>
      object.status === "draft" &&
      (params.title === object.title ||
        params.title.startsWith(object.title)) &&
      Math.abs(Date.parse(object.modified) - base) <= ADOPT_WINDOW_MS,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

// Geri alma işlemi. Silmede (çöpe taşıma) 404 "zaten yok" sayılır: kaybolan
// yanıttan sonraki DELETE yeniden denemesi 404 görebilir.
async function executeUndo(
  client: WordPressClient,
  undo: UndoOp,
): Promise<void> {
  switch (undo.op) {
    case "trash":
      try {
        await client.trashObject(undo.type, undo.id);
      } catch (error) {
        const gone =
          typeof error === "object" &&
          error !== null &&
          "httpStatus" in error &&
          (error as { httpStatus: unknown }).httpStatus === 404;
        const named =
          typeof error === "object" &&
          error !== null &&
          "errorClass" in error &&
          (error as { errorClass: unknown }).errorClass === "NOT_FOUND";
        if (!gone && !named) throw error;
      }
      return;
    case "unpublish":
      await client.updateObject(undo.type, undo.id, { status: "draft" });
      return;
    case "restore":
      if (Object.keys(undo.body).length > 0) {
        await client.updateObject(undo.type, undo.id, undo.body);
      }
      if (undo.endpointMeta) {
        await client.rankMathUpdateMeta(undo.id, undo.endpointMeta);
      }
      return;
  }
}

function errorJson(code: SeoChangeErrorCode, retryable?: boolean) {
  return json({
    code,
    message: SEO_CHANGE_ERROR_MESSAGES[code],
    ...(retryable !== undefined ? { retryable } : {}),
    undo: true,
  });
}

export async function undoSeoChange(
  input: { projectId: string; changeId: string; userId: string },
  deps?: SeoApplyDeps,
): Promise<UndoResult> {
  const d = resolveApplyDeps(deps);

  const change: Row | null = await prisma.seoChange.findFirst({
    where: { id: input.changeId, projectId: input.projectId },
    include: { site: true },
  });
  if (!change) return { ok: false, message: NOT_FOUND_MESSAGE };

  // Yetki ilk kapı: istemciye hiçbir çağrı yapılmadan reddedilir.
  if (!(await isManagerInline(input.userId, change.workspaceId))) {
    return { ok: false, message: NOT_MANAGER_MESSAGE };
  }
  if (!isChangeKind(change.kind)) {
    return { ok: false, message: NOT_UNDOABLE_MESSAGE };
  }
  const kind = change.kind;
  if (
    !isUndoable(
      {
        kind,
        status: change.status as SeoChangeStatus,
        noop: change.noop,
        appliedAt: change.appliedAt,
      },
      d.now,
    )
  ) {
    return { ok: false, message: NOT_UNDOABLE_MESSAGE };
  }
  const params = change.params as unknown as SeoChangeParams;
  if (params.kind !== kind) return { ok: false, message: NOT_UNDOABLE_MESSAGE };

  // Bayrak kapalıyken ya da süreç kipi satırın kipiyle uyuşmuyorsa dokunulmaz.
  if (
    !seoApplyEnabledFor(change.projectId) ||
    !mockMatchesSite(d.mock, change.isMock)
  ) {
    return refuse("not_enabled");
  }

  const gate = await gateApplySite(change.projectId, kind, {
    mock: d.mock,
    wpType: params.kind === "PUBLISH_ARTICLE" ? null : params.wpType,
  });
  if (!gate.ok) return refuse(gate.code);
  if (gate.site.id !== change.siteId) return refuse("not_connected");
  const client = await d.clientFor(gate.site);
  if (!client) return refuse("reconnect");
  const fields: SeoFieldsCapability = gate.fields;

  // Geldiği durum: verifiedAt doluysa VERIFIED, değilse (yazısı inmiş) FAILED.
  const cameFrom = change.status === "VERIFIED" ? "VERIFIED" : "FAILED";
  const owner = `seo-undo:${process.pid}:${d.now.getTime()}:${change.id}`;
  const claimed = await prisma.seoChange.updateMany({
    where: {
      id: change.id,
      status: cameFrom,
      AND: [{ OR: [{ leaseUntil: null }, { leaseUntil: { lt: d.now } }] }],
    },
    data: {
      status: "UNDOING",
      leaseUntil: new Date(d.now.getTime() + SEO_APPLY_LEASE_MS),
      leaseOwner: owner,
    },
  });
  if (claimed.count !== 1) return { ok: false, message: BUSY_MESSAGE };

  const backTo = async (
    code: SeoChangeErrorCode,
    retryable?: boolean,
  ): Promise<UndoResult> => {
    await prisma.seoChange.updateMany({
      where: { id: change.id, status: "UNDOING", leaseOwner: owner },
      data: {
        status: cameFrom,
        error: errorJson(code, retryable),
        leaseUntil: null,
        leaseOwner: null,
      },
    });
    return { ok: false, message: SEO_CHANGE_ERROR_MESSAGES[code] };
  };

  const finish = async (live: WpObject | null): Promise<UndoResult> => {
    const done = await prisma.seoChange.updateMany({
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

    const snapshot = snapshotOf(live, fields, { withContentRaw: false });
    try {
      if (kind === "PUBLISH_LIVE") {
        await syncDraftChainAfter(change, snapshot);
      }
    } catch (error) {
      logName("draft chain update", error);
    }
    try {
      if (change.seoActionId || change.creativeId) {
        const fresh = await prisma.seoChange.findUnique({
          where: { id: change.id },
        });
        if (fresh) await onChangeUndone(fresh, { userId: input.userId });
      }
    } catch (error) {
      logName("action link", error);
    }
    try {
      await enqueueIndexNow(change, snapshot, d.now);
    } catch (error) {
      logName("indexnow enqueue", error);
    }
    try {
      await recordSeoApplyAudit(
        "seo_change.undone",
        {
          changeId: change.id,
          kind,
          source: change.source as SeoChangeSource,
        },
        {
          workspaceId: change.workspaceId,
          projectId: change.projectId,
          userId: input.userId,
        },
      );
    } catch (error) {
      logName("audit", error);
    }
    return { ok: true };
  };

  try {
    const before = change.before as unknown as WpSnapshot | null;
    let after = change.after as unknown as WpSnapshot | null;

    let target = targetOf(change, params, after);
    if (!target && params.kind === "PUBLISH_ARTICLE") {
      // wpId yok: önce taslağı arayıp sahiplen, bulunamazsa geri alınamaz.
      const adopted = await findDraftForUndo(client, params, change.appliedAt);
      if (!adopted) return await backTo("cannot_undo");
      target = { type: "post", id: adopted.id };
      after = snapshotOf(adopted, fields, { withContentRaw: false });
    }
    if (!target) return await backTo("cannot_undo");

    const live = await client.getObject(target.type, target.id);

    // Makale taslağı WordPress'te zaten silinmişse (404) geri alınacak bir şey
    // kalmamıştır: UNDONE.
    if (kind === "PUBLISH_ARTICLE" && live === null) return await finish(null);

    if (
      !undoPrecondition(
        { kind, status: change.status as SeoChangeStatus, after },
        live,
      )
    ) {
      return await backTo("cannot_undo");
    }

    const planned = planUndo(
      {
        kind,
        noop: change.noop,
        status: change.status as SeoChangeStatus,
        before,
        after,
        params,
        appliedAt: change.appliedAt,
      },
      { fields, now: d.now },
    );
    if (!planned.ok) return await backTo("cannot_undo");
    const undo = planned.undo;

    await executeUndo(client, undo);

    const checked = await client.getObject(target.type, target.id);
    if (!verifyUndo(undo, checked, before)) {
      return await backTo("readback_mismatch");
    }
    return await finish(checked);
  } catch (error) {
    const mapped = wpErrorToChangeCode(error);
    if (mapped.code === "reconnect") {
      await prisma.cmsSite
        .updateMany({
          where: { id: change.siteId },
          data: {
            health: "AUTH",
            healthReason: "reconnect",
            lastCheckedAt: d.now,
          },
        })
        .catch((authError: unknown) => logName("health mark", authError));
    }
    try {
      return await backTo(mapped.code, mapped.retryable);
    } catch (restoreError) {
      // Durum yazılamadıysa kira süresi dolunca reconcile geldiği duruma döndürür.
      logName("state restore", restoreError);
      return { ok: false, message: SEO_CHANGE_ERROR_MESSAGES[mapped.code] };
    }
  }
}
