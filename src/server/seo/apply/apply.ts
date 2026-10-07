import "server-only";

import { Prisma, type CmsSite, type SeoChange } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { mockMatchesSite, seoApplyEnabledFor } from "@/lib/seo/apply/flags";
import { SEO_CHANGE_ERROR_MESSAGES } from "@/lib/seo/apply/copy";
import {
  SEO_APPLY_LEASE_MS,
  SEO_APPLY_MAX_ATTEMPTS,
  changeBackoffMs,
  rateWindow,
} from "@/lib/seo/apply/lifecycle";
import {
  SEO_CHANGE_KINDS,
  type SeoChangeErrorCode,
  type SeoChangeKind,
  type SeoChangeParams,
  type SeoChangeSource,
  type SeoFieldsCapability,
  type WpCapabilities,
  type WpSnapshot,
  type WpType,
} from "@/lib/seo/apply/types";
import { clampDailyLimit } from "@/lib/seo/apply/validate";
import { planChange, type WpWrite } from "@/lib/seo/apply/wp/plan";
import { verifyReadBack } from "@/lib/seo/apply/wp/readback";
import {
  decodeEntities,
  snapshotOf,
  textHashOf,
} from "@/lib/seo/apply/wp/snapshot";
import type { WpObject } from "@/lib/seo/apply/wp/wp-types";
import type { WordPressClient } from "@/server/integrations/wordpress/client";
import { wpErrorToChangeCode } from "@/server/integrations/wordpress/errors";
import { TaskRepository } from "@/server/repositories/task.repository";

import { onChangeVerified } from "./action-link";
import { recordSeoApplyAudit } from "./audit";
import { resolveApplyDeps, type ResolvedApplyDeps } from "./deps";
import { isIndexNowReady } from "./indexnow";
import { appliedCountSince } from "./rate";
import { gateApplySite } from "./site";
import type { ApplyState, SeoApplyDeps } from "./types";

// SC-F8 uygulama motoru (docs/website-apply.md, "ENGINE TRANSITIONS").
// Sıra: bayrak + mock eşleşmesi -> CAS kirası -> kapılar (onay satırı, site) ->
// oran penceresi -> canlı okuma -> plan -> yazma (sırayla) -> canlı geri okuma ->
// doğrulama. İstemcinin yazan üyelerini (createPost, updateObject,
// trashObject, rankMathUpdateMeta) yalnız bu dosya ve undo.ts çağırır
// (write-guard.test.ts pinler). Onaysız, bayrak kapalıyken ya da kapı düşmüşken
// siteye asla yazılmaz; her yazma geri okunur ve geri okuma uyuşmazlığında
// ikinci bir yazma yapılmaz.

const HOUR_MS = 3_600_000;
// Yarım kalmış bir create'in taslağını sahiplenme penceresi (retry/adoption).
const ADOPT_WINDOW_MS = 30 * 60_000;

// Kapı ve mantık hataları: yazıcı çağrılmadan önce fırlatılır, kodu sabittir.
class ApplyStop extends Error {
  constructor(readonly code: SeoChangeErrorCode) {
    super(code);
    this.name = "ApplyStop";
  }
}

type Row = SeoChange & { site: CmsSite };

type Run = {
  change: Row;
  kind: SeoChangeKind;
  params: SeoChangeParams;
  d: ResolvedApplyDeps;
  owner: string;
  // "pre": hiçbir yazma dönmedi (APPLYING); "applied": en az bir yazma döndü
  // (APPLIED).
  phase: "pre" | "applied";
  // Hata anında hangi adımda olduğumuz: yazma mı, geri okuma mı.
  step: "write" | "readback";
  // appliedAt ilk yazma döndüğünde (ya da önceki denemeden) dolar.
  appliedAt: Date | null;
};

type Columns = {
  wpId?: number;
  wpType?: WpType;
  targetUrl?: string | null;
  liveUrl?: string | null;
};

function isChangeKind(value: string): value is SeoChangeKind {
  return (SEO_CHANGE_KINDS as readonly string[]).includes(value);
}

function wpTypeOf(params: SeoChangeParams): WpType | null {
  return params.kind === "PUBLISH_ARTICLE" ? null : params.wpType;
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

function logName(step: string, error: unknown): void {
  console.error(
    `[seo-apply] ${step} failed:`,
    error instanceof Error ? error.name : "unknown",
  );
}

function runFrom(run: Run): "APPLYING" | "APPLIED" {
  return run.phase === "pre" ? "APPLYING" : "APPLIED";
}

function leaseEnd(run: Run): Date {
  return new Date(run.d.now.getTime() + SEO_APPLY_LEASE_MS);
}

// Yalnız kirayı hâlâ elinde tutan koşu günceller; düşmüşse sessizce çıkar.
async function advance(
  run: Run,
  from: "APPLYING" | "APPLIED",
  data: Prisma.SeoChangeUpdateManyMutationInput,
): Promise<boolean> {
  const result = await prisma.seoChange.updateMany({
    where: { id: run.change.id, status: from, leaseOwner: run.owner },
    data,
  });
  return result.count === 1;
}

// Task'ı kapatır (en iyi çaba). WAITING_APPROVAL/QUEUED -> RUNNING -> son durum.
async function finishTask(
  change: SeoChange,
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

// PUBLISH_LIVE (uygulama ve geri alma) taslak değişikliğin after görüntüsünü
// canlı duruma eşitler: makale -> yayına al -> yayından kaldır -> makaleyi geri
// al zinciri undoPrecondition'ın beklediği modified/status ile çalışsın.
export async function syncDraftChainAfter(
  change: Pick<SeoChange, "projectId" | "params">,
  snapshot: WpSnapshot,
): Promise<void> {
  const params = change.params as unknown as SeoChangeParams;
  if (params.kind !== "PUBLISH_LIVE") return;
  const draft = await prisma.seoChange.findFirst({
    where: { id: params.draftChangeId, projectId: change.projectId },
    select: { id: true, after: true },
  });
  if (!draft) return;
  const previous = (draft.after ?? {}) as Partial<WpSnapshot>;
  await prisma.seoChange.updateMany({
    where: { id: draft.id },
    data: {
      after: json({
        ...previous,
        modified: snapshot.modified,
        status: snapshot.status,
        link: snapshot.link ?? previous.link ?? null,
      }),
    },
  });
}

// IndexNow kuyruğu: yalnız herkese açık adresi olan (taslak olmayan) değişiklik
// ve yalnız proje IndexNow'u hazırsa. Siteye yazı değildir; gönderimi
// SeoIndexNow.flushDue yapar.
export async function enqueueIndexNow(
  change: Pick<SeoChange, "id" | "projectId" | "kind">,
  snapshot: WpSnapshot | null,
  now: Date,
): Promise<void> {
  if (
    change.kind !== "TITLE_META" &&
    change.kind !== "INTERNAL_LINKS" &&
    change.kind !== "PUBLISH_LIVE"
  ) {
    return;
  }
  if (!(await isIndexNowReady(change.projectId))) return;
  // PUBLISH_LIVE geri alınınca sayfa taslağa döner; yine de arama motoruna
  // adresin değiştiğini bildirmek doğrudur. Diğer türlerde yayında olmayan
  // sayfa bildirilmez.
  if (
    change.kind !== "PUBLISH_LIVE" &&
    snapshot !== null &&
    snapshot.status !== null &&
    snapshot.status !== "publish"
  ) {
    return;
  }
  await prisma.seoChange.updateMany({
    where: { id: change.id, status: { in: ["VERIFIED", "UNDONE"] } },
    data: { indexNow: json({ state: "PENDING", at: now.toISOString() }) },
  });
}

// Son durum sonrası adımlar: her biri kendi try/catch'inde, yalnız ad loglar.
async function postSteps(
  run: Run,
  outcome:
    | { ok: true; snapshot: WpSnapshot; noop: boolean }
    | { ok: false; code: SeoChangeErrorCode },
): Promise<void> {
  const { change, kind, d } = run;
  if (outcome.ok) {
    try {
      if (kind === "PUBLISH_LIVE") {
        await syncDraftChainAfter(change, outcome.snapshot);
      }
    } catch (error) {
      logName("draft chain update", error);
    }
    try {
      if (change.seoActionId || change.creativeId) {
        const fresh = await prisma.seoChange.findUnique({
          where: { id: change.id },
        });
        if (fresh) {
          await onChangeVerified(fresh, { userId: fresh.approvedByUserId });
        }
      }
    } catch (error) {
      logName("action link", error);
    }
    try {
      if (!outcome.noop) {
        await enqueueIndexNow(change, outcome.snapshot, d.now);
      }
    } catch (error) {
      logName("indexnow enqueue", error);
    }
  }
  try {
    await recordSeoApplyAudit(
      outcome.ok ? "seo_change.verified" : "seo_change.failed",
      {
        changeId: change.id,
        kind,
        source: change.source as SeoChangeSource,
        ...(outcome.ok ? {} : { code: outcome.code }),
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
      outcome.ok ? undefined : SEO_CHANGE_ERROR_MESSAGES[outcome.code],
    );
  } catch (error) {
    logName("task finish", error);
  }
}

// Task failureReason ve satırın error.message'ı HER ZAMAN sabit metindir;
// WordPress'ten gelen hiçbir metin saklanmaz.
async function failRun(
  run: Run,
  code: SeoChangeErrorCode,
  extra: { retryable?: boolean; after?: WpSnapshot | null } = {},
): Promise<{ state: ApplyState }> {
  const moved = await advance(run, runFrom(run), {
    status: "FAILED",
    openKey: null,
    failedAt: run.d.now,
    error: json({
      code,
      message: SEO_CHANGE_ERROR_MESSAGES[code],
      ...(extra.retryable !== undefined ? { retryable: extra.retryable } : {}),
    }),
    ...(extra.after ? { after: json(withoutRaw(extra.after)) } : {}),
    leaseUntil: null,
    leaseOwner: null,
  });
  if (!moved) return { state: "busy" };
  await postSteps(run, { ok: false, code });
  return { state: "failed" };
}

async function verifyRun(
  run: Run,
  data: {
    before?: WpSnapshot;
    after: WpSnapshot;
    noop: boolean;
    columns?: Columns;
  },
): Promise<{ state: ApplyState }> {
  const { now } = run.d;
  const columns = data.columns ?? {};
  const moved = await advance(run, runFrom(run), {
    status: "VERIFIED",
    openKey: null,
    verifiedAt: now,
    after: json(withoutRaw(data.after)),
    ...(data.before ? { before: json(data.before) } : {}),
    noop: data.noop,
    // Yazısı inmiş (noop olmayan) her değişiklik sayılır; plain noop saymaz.
    ...(!data.noop && !run.appliedAt ? { appliedAt: now } : {}),
    ...(columns.wpId !== undefined ? { wpId: columns.wpId } : {}),
    ...(columns.wpType !== undefined ? { wpType: columns.wpType } : {}),
    ...(columns.targetUrl !== undefined
      ? { targetUrl: columns.targetUrl }
      : {}),
    ...(columns.liveUrl !== undefined ? { liveUrl: columns.liveUrl } : {}),
    error: Prisma.DbNull,
    leaseUntil: null,
    leaseOwner: null,
  });
  if (!moved) return { state: "busy" };
  await postSteps(run, { ok: true, snapshot: data.after, noop: data.noop });
  return { state: data.noop ? "noop" : "verified" };
}

// after görüntüsünde ham içerik saklanmaz (yalnız before'da, geri alma için).
function withoutRaw(snapshot: WpSnapshot): WpSnapshot {
  return snapshot.contentRaw === null ? snapshot : { ...snapshot, contentRaw: null };
}

function columnsFor(kind: SeoChangeKind, snapshot: WpSnapshot): Columns {
  if (kind === "PUBLISH_ARTICLE") {
    return {
      ...(snapshot.id !== null ? { wpId: snapshot.id } : {}),
      wpType: "post",
      targetUrl: snapshot.link,
      liveUrl: null,
    };
  }
  if (kind === "PUBLISH_LIVE") return { liveUrl: snapshot.link };
  return {};
}

type Gate = {
  site: CmsSite;
  client: WordPressClient;
  fields: SeoFieldsCapability;
  capabilities: WpCapabilities;
};

// Kapılar: herhangi biri düşerse yazıcı ASLA çağrılmaz. Onay kapısı yalnız
// Approval.status === 'APPROVED' ister, expiresAt'e bakmaz (decide() süreyi
// zaten sınar; onaylanmış satır onay süresi geçse de uygulanır).
async function passGates(run: Run): Promise<Gate> {
  const { change, d } = run;
  if (!change.approvalId) throw new ApplyStop("approval_missing");
  const approval = await prisma.approval.findFirst({
    where: { id: change.approvalId },
    select: { status: true },
  });
  if (approval?.status !== "APPROVED") throw new ApplyStop("approval_missing");

  const gate = await gateApplySite(change.projectId, run.kind, {
    mock: d.mock,
    wpType: wpTypeOf(run.params),
  });
  if (!gate.ok) throw new ApplyStop(gate.code);
  if (gate.site.id !== change.siteId) throw new ApplyStop("not_connected");

  const client = await d.clientFor(gate.site);
  if (!client) throw new ApplyStop("reconnect");
  return {
    site: gate.site,
    client,
    fields: gate.fields,
    capabilities: gate.capabilities,
  };
}

// Oran penceresi dolu: satır APPROVED kalır, pencerenin açılacağı ana ertelenir.
// Başarısızlık değil; deneme sayısı da artmaz.
async function rateGate(run: Run, siteId: string): Promise<Date | null> {
  const { change, d } = run;
  const setting = await prisma.seoApplySetting.findUnique({
    where: { projectId: change.projectId },
    select: { dailyLimit: true },
  });
  const limit = clampDailyLimit(setting?.dailyLimit);
  const since = new Date(d.now.getTime() - 24 * HOUR_MS);
  const applied = await appliedCountSince(siteId, since);
  const window = rateWindow(applied, limit, d.now);
  if (window.allowed) return null;
  return window.nextAt ?? new Date(d.now.getTime() + HOUR_MS);
}

// Zaman aşımına uğrayan create'in yazısı gerçekten inmiş olabilir: aynı başlık,
// aynı metin özeti ve son 30 dakikada değişmiş taslak bizimdir (sahiplenilir).
async function adoptDraft(run: Run, gate: Gate): Promise<WpObject | null> {
  const dry = planChange(run.params, null, {
    fields: gate.fields,
    capabilities: gate.capabilities,
    prior: null,
  });
  if (dry.kind !== "write") return null;
  const create = dry.writes.find((write) => write.op === "create");
  if (!create || create.op !== "create") return null;

  const found = await gate.client.searchDrafts(create.body.title);
  const wanted = textHashOf(create.body.content);
  const since = run.d.now.getTime() - ADOPT_WINDOW_MS;
  const matches = found
    .filter(
      (object) =>
        decodeEntities(object.title).trim() ===
          decodeEntities(create.body.title).trim() &&
        textHashOf(object.content ?? "") === wanted &&
        Date.parse(object.modified) >= since,
    )
    .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
  return matches[0] ?? null;
}

async function readLive(run: Run, gate: Gate): Promise<WpObject | null> {
  const { params, change } = run;
  if (params.kind === "PUBLISH_ARTICLE") {
    if (change.wpId !== null) return gate.client.getObject("post", change.wpId);
    return change.attempts > 1 ? adoptDraft(run, gate) : null;
  }
  return gate.client.getObject(params.wpType, params.wpId);
}

async function sendWrite(
  client: WordPressClient,
  write: WpWrite,
): Promise<WpObject | null> {
  switch (write.op) {
    case "create":
      return client.createPost(write.body);
    case "update":
      return client.updateObject(write.type, write.id, write.body);
    case "rankMathMeta":
      await client.rankMathUpdateMeta(write.id, write.meta);
      return null;
  }
}

function priorSnapshot(run: Run): WpSnapshot | null {
  return run.change.attempts > 1
    ? (run.change.before as unknown as WpSnapshot | null)
    : null;
}

async function applyRun(run: Run, gate: Gate): Promise<{ state: ApplyState }> {
  const { change, kind, params, d } = run;

  if (run.phase === "pre") {
    const until = await rateGate(run, change.siteId);
    if (until) {
      const moved = await advance(run, "APPLYING", {
        status: "APPROVED",
        nextAttemptAt: until,
        attempts: { decrement: 1 },
        leaseUntil: null,
        leaseOwner: null,
      });
      return { state: moved ? "waiting" : "busy" };
    }
  }

  const live = await readLive(run, gate);
  // Taslağı yazılmış makale WordPress'te silinmişse yeniden create edilmez.
  if (params.kind === "PUBLISH_ARTICLE" && change.wpId !== null && !live) {
    return failRun(run, "page_not_found");
  }
  const prior = priorSnapshot(run);
  const plan = planChange(params, live, {
    fields: gate.fields,
    capabilities: gate.capabilities,
    prior,
  });

  if (plan.kind === "refuse") return failRun(run, plan.code);

  if (plan.kind === "noop") {
    // Önceki denememizin yazısı indiyse (ya da yazması dönmüş satır geri
    // okunuyorsa) gerçek, geri alınabilir, sayılan bir değişikliktir.
    const landed = plan.landedEarlier || run.phase === "applied";
    if (!landed) {
      return verifyRun(run, {
        before: plan.snapshot,
        after: plan.snapshot,
        noop: true,
      });
    }
    const before =
      (change.before as unknown as WpSnapshot | null) ??
      snapshotOf(null, gate.fields, { withContentRaw: false });
    return verifyRun(run, {
      before,
      after: plan.snapshot,
      noop: false,
      columns: columnsFor(kind, plan.snapshot),
    });
  }

  // "Önce" görüntüsü yalnız ilk planlamada saklanır, sonra asla ezilmez.
  if (change.before === null) {
    const stored = await advance(run, runFrom(run), {
      before: json(plan.before),
    });
    if (!stored) return { state: "busy" };
  }

  let target: { type: WpType; id: number } | null =
    params.kind === "PUBLISH_ARTICLE"
      ? change.wpId !== null
        ? { type: "post", id: change.wpId }
        : null
      : { type: params.wpType, id: params.wpId };

  for (const write of plan.writes) {
    run.step = "write";
    const written = await sendWrite(gate.client, write);
    if (write.op === "create" && written) {
      target = { type: "post", id: written.id };
    }
    if (run.phase === "pre") {
      const columns: Columns =
        write.op === "create" && written
          ? {
              wpId: written.id,
              wpType: "post",
              targetUrl: written.link,
              liveUrl: null,
            }
          : kind === "PUBLISH_LIVE" && written
            ? { liveUrl: written.link }
            : {};
      const applied = await advance(run, "APPLYING", {
        status: "APPLIED",
        appliedAt: d.now,
        leaseUntil: leaseEnd(run),
        ...(columns.wpId !== undefined ? { wpId: columns.wpId } : {}),
        ...(columns.wpType !== undefined ? { wpType: columns.wpType } : {}),
        ...(columns.targetUrl !== undefined
          ? { targetUrl: columns.targetUrl }
          : {}),
        ...(columns.liveUrl !== undefined ? { liveUrl: columns.liveUrl } : {}),
      });
      if (!applied) return { state: "busy" };
      run.phase = "applied";
      run.appliedAt = d.now;
      try {
        await recordSeoApplyAudit(
          "seo_change.applied",
          {
            changeId: change.id,
            kind,
            source: change.source as SeoChangeSource,
          },
          { workspaceId: change.workspaceId, projectId: change.projectId },
        );
      } catch (error) {
        logName("audit", error);
      }
    } else {
      await advance(run, "APPLIED", { leaseUntil: leaseEnd(run) });
    }
  }

  // Geri okuma: yazma bitti, bundan sonra yalnız okuma (ikinci yazma yok).
  run.step = "readback";
  if (!target) throw new ApplyStop("unknown");
  const after = await gate.client.getObject(target.type, target.id);
  const check = verifyReadBack(plan.expectAfter, after, {
    fields: gate.fields,
    withContentRaw: false,
  });
  if (!check.ok) {
    return failRun(run, "readback_mismatch", { after: check.snapshot });
  }
  return verifyRun(run, {
    after: check.snapshot,
    noop: false,
    columns: columnsFor(kind, check.snapshot),
  });
}

// 401: kayıtlı parola kabul edilmiyor; bağlantı sağlığı AUTH'a çekilir.
async function markAuth(siteId: string, now: Date): Promise<void> {
  await prisma.cmsSite.updateMany({
    where: { id: siteId },
    data: {
      health: "AUTH",
      healthReason: "reconnect",
      lastCheckedAt: now,
    },
  });
}

// Site ya da mantık hatasını duruma çevirir (ENGINE TRANSITIONS).
async function handleError(
  run: Run,
  error: unknown,
): Promise<{ state: ApplyState }> {
  if (error instanceof ApplyStop) return failRun(run, error.code);

  const mapped = wpErrorToChangeCode(error);
  if (mapped.code === "reconnect") {
    await markAuth(run.change.siteId, run.d.now).catch((authError: unknown) =>
      logName("health mark", authError),
    );
  }
  const attempts = run.change.attempts;

  if (mapped.retryable && attempts < SEO_APPLY_MAX_ATTEMPTS) {
    const moved = await advance(run, runFrom(run), {
      status: run.phase === "pre" ? "APPROVED" : "APPLIED",
      nextAttemptAt: new Date(
        run.d.now.getTime() + changeBackoffMs(attempts, mapped.errorClass),
      ),
      leaseUntil: null,
      leaseOwner: null,
    });
    return { state: moved ? "retry" : "busy" };
  }

  // Geri okuma çağrısı denemeleri tüketti: yazı indi ama doğrulanamadı.
  // Satır geri alınabilir FAILED olur (appliedAt korunur).
  const code: SeoChangeErrorCode =
    mapped.retryable && run.phase === "applied" && run.step === "readback"
      ? "site_unavailable"
      : mapped.code;
  return failRun(run, code, { retryable: false });
}

export async function applySeoChange(
  changeId: string,
  deps?: SeoApplyDeps,
): Promise<{ state: ApplyState }> {
  const d = resolveApplyDeps(deps);

  const head = await prisma.seoChange.findUnique({
    where: { id: changeId },
    select: {
      id: true,
      status: true,
      kind: true,
      projectId: true,
      isMock: true,
    },
  });
  if (!head) return { state: "gone" };
  if (head.status === "APPLYING" || head.status === "UNDOING") {
    return { state: "busy" };
  }
  if (head.status !== "APPROVED" && head.status !== "APPLIED") {
    return { state: "skipped" };
  }
  if (!isChangeKind(head.kind)) return { state: "skipped" };
  const kind = head.kind;

  // Bayrak kapalıyken (ya da süreç kipi satırın kipiyle uyuşmuyorsa) satıra
  // dokunulmaz: onaylı satır bekler, FAILED'a çevrilmez.
  if (
    !seoApplyEnabledFor(head.projectId) ||
    !mockMatchesSite(d.mock, head.isMock)
  ) {
    return { state: "skipped" };
  }

  const resuming = head.status === "APPLIED";
  const owner = `seo-apply:${process.pid}:${d.now.getTime()}:${changeId}`;
  const claimed = await prisma.seoChange.updateMany({
    where: {
      id: changeId,
      status: head.status,
      AND: [
        { OR: [{ leaseUntil: null }, { leaseUntil: { lt: d.now } }] },
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: d.now } }] },
      ],
    },
    data: {
      status: resuming ? "APPLIED" : "APPLYING",
      leaseUntil: new Date(d.now.getTime() + SEO_APPLY_LEASE_MS),
      leaseOwner: owner,
      nextAttemptAt: null,
      attempts: { increment: 1 },
    },
  });
  if (claimed.count !== 1) return { state: "busy" };

  const change = await prisma.seoChange.findUnique({
    where: { id: changeId },
    include: { site: true },
  });
  if (!change) return { state: "gone" };
  if (change.leaseOwner !== owner) return { state: "busy" };

  const run: Run = {
    change,
    kind,
    params: change.params as unknown as SeoChangeParams,
    d,
    owner,
    phase: resuming ? "applied" : "pre",
    // Kaldığı yerden süren satırda canlı okuma da bir geri okumadır.
    step: resuming ? "readback" : "write",
    appliedAt: change.appliedAt,
  };

  try {
    if (run.params.kind !== kind) throw new ApplyStop("unknown");
    const gate = await passGates(run);
    return await applyRun(run, gate);
  } catch (error) {
    try {
      return await handleError(run, error);
    } catch (handlerError) {
      // Durum yazılamadıysa kira süresi dolunca reconcile devralır.
      logName("error handling", handlerError);
      return { state: "busy" };
    }
  }
}
