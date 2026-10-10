import "server-only";

import { startOfMonth, subDays } from "date-fns";

import { paidPlanRunning } from "@/lib/billing/entitlements-core";
import { linkedForMode, type StripeModeName } from "@/lib/billing/linkage";
import {
  BACKGROUND_SHARE_PCT,
  PLANS,
  isUnitSellable,
  type PlanKey,
} from "@/lib/billing/plans";
import { prisma } from "@/lib/prisma";

import { getBillingConfig } from "./config";
import { getEntitlements } from "./entitlements";
import { toUsageView } from "./ledger";
import { HELD_BACK_CODE } from "./quota-errors";

// Everything the Plan & usage screens show, read for ONE workspace. A display
// model: it never decides, reserves or charges anything, and it is independent of
// BILLING_MODE on purpose (the ledger gates are invisible while billing is off, but
// the screens still show what is measured and what the workspace has).
//
// Customer wording: counts and percentages, never tokens or cost.

export type SubscriptionOverview = {
  planKey: PlanKey | null;
  planLabel: string | null;
  interval: "MONTH" | "YEAR" | null;
  status: string;
  // Paid up to (the renewal date), ISO.
  paidThrough: string | null;
  trialEndsAt: string | null;
  // The free trial is running right now (status TRIALING and its end is in the future).
  trialActive: boolean;
  cancelAtPeriodEnd: boolean;
  pending: {
    planKey: PlanKey | null;
    interval: string | null;
    effectiveAt: string | null;
  } | null;
  exempt: boolean;
  // A Stripe subscription of the RUNNING payment mode is linked (the workspace has paid
  // at least once): the plan buttons switch plans instead of opening a first checkout.
  // A test-mode link seen with the live key (shared database) counts as not linked.
  stripeLinked: boolean;
  // The first-month discount was used (it is offered once).
  introOffer: boolean;
  // The workspace has paid for a plan that is still running (extra packs can be bought):
  // paying, or in the payment grace period, or canceled with paid time left.
  paidAccess: boolean;
  // Why a canceled subscription ended (REFUNDED | CHARGEBACK | PAYMENT_FAILED | ...).
  endedReason: string | null;
};

export type AllowanceOverview = {
  unit: "IMAGE" | "AI_MICROS";
  // This window's allowance plus what is still left of the extra packs bought (their
  // lifetime counters are not part of it: a pack bought and used long ago says nothing
  // about this window).
  granted: number;
  // Spent from this window's allowance.
  used: number;
  reserved: number;
  // Left to spend now: this window's allowance plus extra packs.
  available: number;
  // Of which bought separately; never expires with the window.
  extraAvailable: number;
  endsAt: string | null;
};

export type ModuleUsage = {
  module: string;
  images: number;
  aiRequests: number;
};

export type DailyUsage = { day: string; images: number; aiRequests: number };

export type MeasuredUsage = {
  // Start of the window the numbers cover, ISO.
  since: string;
  images: number;
  aiRequests: number;
  byModule: ModuleUsage[];
  daily: DailyUsage[];
};

export type TaskRow = {
  id: string;
  title: string;
  capability: string;
  projectId: string;
  projectName: string;
  at: string;
  // Paused tasks only: why they wait. "held-back": the allowance is not used up,
  // automatic work reached its own share of it (the user's requests are unaffected).
  pausedFor?: "allowance" | "no-plan" | "held-back";
};

export type ApprovalRow = {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  at: string;
};

export type TasksOverview = {
  active: TaskRow[];
  paused: TaskRow[];
  awaitingApproval: ApprovalRow[];
  // Share of the plan automatic work may use (percent); only set while a paused task
  // waits because of it.
  backgroundSharePct?: number;
};

export type BillingOverview = {
  mode: "off" | "shadow" | "enforce";
  subscription: SubscriptionOverview | null;
  allowances: AllowanceOverview[];
  measured: MeasuredUsage;
  tasks: TasksOverview;
};

const ACTIVE_JOB_STATUSES = [
  "QUEUED",
  "RUNNING",
  "WAITING_PROVIDER",
  "WAITING_HUMAN",
] as const;

const LIST_LIMIT = 15;
const HISTORY_DAYS = 14;

const isPlanKey = (value: string | null): value is PlanKey =>
  value !== null && Object.hasOwn(PLANS, value);

function toSubscriptionOverview(
  row: {
    planKey: string | null;
    interval: string | null;
    status: string;
    paidThrough: Date | null;
    trialEndsAt: Date | null;
    cancelAtPeriodEnd: boolean;
    pendingPlanKey: string | null;
    pendingInterval: string | null;
    pendingEffectiveAt: Date | null;
    exempt: boolean;
    stripeSubscriptionId: string | null;
    stripeLivemode: boolean | null;
    graceUntil: Date | null;
    endedReason: string | null;
    introOffer: boolean;
  },
  now: Date,
  stripeMode: StripeModeName | null,
): SubscriptionOverview {
  const planKey = isPlanKey(row.planKey) ? row.planKey : null;
  const hasPending = Boolean(
    row.pendingPlanKey || row.pendingInterval || row.pendingEffectiveAt,
  );
  // Ekran modu bilinmiyorsa (ödeme kapalı) yalnız bir bağ olup olmadığına bakılır.
  const linked = stripeMode
    ? linkedForMode(row, stripeMode)
    : row.stripeSubscriptionId !== null;
  return {
    planKey,
    planLabel: planKey ? PLANS[planKey].label : null,
    interval:
      row.interval === "MONTH" || row.interval === "YEAR" ? row.interval : null,
    status: row.status,
    paidThrough: row.paidThrough?.toISOString() ?? null,
    trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
    trialActive:
      row.status === "TRIALING" &&
      row.trialEndsAt !== null &&
      row.trialEndsAt.getTime() > now.getTime(),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    pending: hasPending
      ? {
          planKey: isPlanKey(row.pendingPlanKey) ? row.pendingPlanKey : null,
          interval: row.pendingInterval,
          effectiveAt: row.pendingEffectiveAt?.toISOString() ?? null,
        }
      : null,
    exempt: row.exempt,
    stripeLinked: linked,
    introOffer: row.introOffer,
    paidAccess: linked && paidPlanRunning(row, now),
    endedReason: row.endedReason,
  };
}

async function measuredUsage(
  workspaceId: string,
  now: Date,
): Promise<MeasuredUsage> {
  const since = startOfMonth(now);
  const historyFrom = subDays(now, HISTORY_DAYS - 1);
  historyFrom.setUTCHours(0, 0, 0, 0);

  const [byKind, daily] = await Promise.all([
    prisma.usageEntry.groupBy({
      by: ["module", "kind"],
      where: {
        workspaceId,
        success: true,
        createdAt: { gte: since },
        kind: { in: ["IMAGE", "TEXT", "SEARCH"] },
      },
      _count: { _all: true },
      _sum: { units: true },
    }),
    prisma.$queryRaw<
      Array<{ day: string; images: number; requests: number }>
    >`SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS "day",
             COALESCE(SUM(CASE WHEN "kind" = 'IMAGE' THEN COALESCE("units", 1) ELSE 0 END), 0)::int AS "images",
             COALESCE(SUM(CASE WHEN "kind" IN ('TEXT', 'SEARCH') THEN 1 ELSE 0 END), 0)::int AS "requests"
        FROM "UsageEntry"
       WHERE "workspaceId" = ${workspaceId}
         AND "success" = true
         AND "kind" IN ('IMAGE', 'TEXT', 'SEARCH')
         AND "createdAt" >= (${historyFrom}::timestamptz AT TIME ZONE 'UTC')
       GROUP BY 1
       ORDER BY 1 DESC`,
  ]);

  const modules = new Map<string, ModuleUsage>();
  let images = 0;
  let aiRequests = 0;
  for (const row of byKind) {
    const key = row.module ?? "OTHER";
    const entry = modules.get(key) ?? { module: key, images: 0, aiRequests: 0 };
    if (row.kind === "IMAGE") {
      const count = row._sum.units ?? row._count._all;
      entry.images += count;
      images += count;
    } else {
      entry.aiRequests += row._count._all;
      aiRequests += row._count._all;
    }
    modules.set(key, entry);
  }

  return {
    since: since.toISOString(),
    images,
    aiRequests,
    byModule: [...modules.values()].sort(
      (a, b) => b.images + b.aiRequests - (a.images + a.aiRequests),
    ),
    daily: daily.map((row) => ({
      day: row.day,
      images: row.images,
      aiRequests: row.requests,
    })),
  };
}

function pausedForOf(errorCode: string | null): TaskRow["pausedFor"] {
  if (errorCode === "NO_PLAN") return "no-plan";
  return errorCode === HELD_BACK_CODE ? "held-back" : "allowance";
}

async function tasksOverview(workspaceId: string): Promise<TasksOverview> {
  const jobSelect = {
    id: true,
    projectId: true,
    capability: true,
    createdAt: true,
    updatedAt: true,
    errorCode: true,
    task: { select: { title: true } },
  } as const;

  const [active, paused, approvals] = await Promise.all([
    prisma.executionJob.findMany({
      where: { workspaceId, status: { in: [...ACTIVE_JOB_STATUSES] } },
      orderBy: { createdAt: "desc" },
      take: LIST_LIMIT,
      select: jobSelect,
    }),
    prisma.executionJob.findMany({
      where: { workspaceId, status: "WAITING_BUDGET" },
      orderBy: { updatedAt: "desc" },
      take: LIST_LIMIT,
      select: jobSelect,
    }),
    prisma.approval.findMany({
      where: { workspaceId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      take: LIST_LIMIT,
      select: {
        id: true,
        projectId: true,
        createdAt: true,
        entityType: true,
        task: { select: { title: true } },
      },
    }),
  ]);

  const projectIds = [
    ...new Set(
      [...active, ...paused, ...approvals].map((row) => row.projectId),
    ),
  ];
  const projects = projectIds.length
    ? await prisma.project.findMany({
        where: { workspaceId, id: { in: projectIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameOf = new Map(projects.map((project) => [project.id, project.name]));

  const toRow = (
    job: (typeof active)[number],
    at: Date,
    pausedFor?: TaskRow["pausedFor"],
  ): TaskRow => ({
    id: job.id,
    title: job.task?.title ?? job.capability,
    capability: job.capability,
    projectId: job.projectId,
    projectName: nameOf.get(job.projectId) ?? "Brand",
    at: at.toISOString(),
    ...(pausedFor ? { pausedFor } : {}),
  });

  const heldBack = paused.some((job) => job.errorCode === HELD_BACK_CODE);
  const share = heldBack
    ? BACKGROUND_SHARE_PCT[(await getEntitlements(workspaceId)).autonomy]
    : undefined;

  return {
    active: active.map((job) => toRow(job, job.createdAt)),
    paused: paused.map((job) =>
      toRow(job, job.updatedAt, pausedForOf(job.errorCode)),
    ),
    ...(share !== undefined ? { backgroundSharePct: share } : {}),
    awaitingApproval: approvals.map((approval) => ({
      id: approval.id,
      title: approval.task?.title ?? approval.entityType,
      projectId: approval.projectId,
      projectName: nameOf.get(approval.projectId) ?? "Brand",
      at: approval.createdAt.toISOString(),
    })),
  };
}

export async function getBillingOverview(
  workspaceId: string,
  now: Date = new Date(),
  // Çalışan ödeme anahtarının modu (ödeme kapalıysa null): başka moddaki abonelik bağı
  // "bağlı" sayılmaz.
  stripeMode: StripeModeName | null = null,
): Promise<BillingOverview> {
  const [subscription, balances, measured, tasks] = await Promise.all([
    prisma.subscription.findUnique({ where: { workspaceId } }),
    prisma.usageBalance.findMany({ where: { workspaceId } }),
    measuredUsage(workspaceId, now),
    tasksOverview(workspaceId),
  ]);

  const allowances = balances
    .filter((row) => isUnitSellable(row.unit as "IMAGE"))
    .filter((row) => row.unit === "IMAGE" || row.unit === "AI_MICROS")
    .map((row) => {
      const view = toUsageView(row, now);
      return {
        unit: view.unit as "IMAGE" | "AI_MICROS",
        granted: view.period.granted + view.extra.available,
        used: view.period.used,
        reserved: view.period.reserved + view.extra.reserved,
        available: view.available,
        extraAvailable: view.extra.available,
        endsAt: view.period.endsAt,
      };
    })
    .sort((a, b) => (a.unit === b.unit ? 0 : a.unit === "IMAGE" ? -1 : 1));

  return {
    mode: getBillingConfig().mode,
    subscription: subscription
      ? toSubscriptionOverview(subscription, now, stripeMode)
      : null,
    allowances,
    measured,
    tasks,
  };
}
