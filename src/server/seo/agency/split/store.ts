import "server-only";

import { randomUUID } from "node:crypto";

import type { GscSplitTest, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { CHECK_NOW_MIN_GAP_MS } from "@/lib/seo/actions/lifecycle";
import { evaluationWindows } from "@/lib/seo/actions/windows";
import { gscAgencyActiveFor, gscAgencyOn } from "@/lib/seo/agency/flags";
import {
  SPLIT_CMS_MAX_ARM,
  SPLIT_ERROR_TEXT,
  SPLIT_MAX_GROUPS,
  SPLIT_MAX_OPEN_PER_LINK,
  SPLIT_RECOMMENDED_ARM,
  assignArms,
  splitEligibility,
  type SplitCandidate,
  type SplitEligibility,
} from "@/lib/seo/agency/split/assign";
import { splitWindowDays } from "@/lib/seo/agency/split/evaluate";
import { sameSite, validatePattern } from "@/lib/seo/agency/split/patterns";
import {
  OPEN_SPLIT_STATUSES,
  SPLIT_LIMITS,
  isSplitChangeKind,
  isSplitStatus,
  parseSplitChange,
  parseSplitEvaluation,
  parseSplitVerification,
  type SplitChange,
  type SplitChangeKind,
  type SplitTestView,
} from "@/lib/seo/agency/split/types";
import { splitMeasuring } from "@/lib/seo/agency/split/verify";
import { addDays, gscToday } from "@/lib/seo/dates";
import { gscRestrictedProjects, gscSyncAllowedFor } from "@/lib/seo/flags";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";
import { readCrawledPage } from "@/server/seo/actions/page-check";
import { GscPageGroups } from "@/server/seo/agency/page-groups";

import {
  proposeSplitChanges,
  splitCmsReady,
  syncCmsChanges,
} from "./apply-cms";
import { evaluateSplitTest } from "./evaluate";
import { openPageIds, readPopulation, splitSiteScope } from "./population";
import { isCrawlerVerifiable, parseBaseline, verifySplitTest } from "./verify";

// Bölünmüş SEO testlerinin deposu (docs/search-agency.md). Bayrak kapalıyken
// ([off: no DB]) hiçbir giriş noktası veritabanına gitmez. Google'a gidilmez;
// ambar ve kendi tablolarımız okunur. Denetim kaydı yalnız kimlik ve sabit
// anahtar taşır (adres, sorgu ya da sayı yok).

const NOT_ALLOWED = "Split tests aren't available here.";
const DAY_MS = 86_400_000;
const LEASE_MS = 300_000;
const DRAFT_EXPIRE_DAYS = 30;
const LIST_LIMIT = 50;
const GROUP_LOOKUP_LIMIT = 200;
const PAGES_CHUNK = 1000;
const BASELINE_TEST_PAGES = 5;
const BASELINE_CONTROL_PAGES = 3;
const APPLIED_MAX_AGE_DAYS = 60;
const TITLE_PATTERN_MAX = 120;
const META_PATTERN_MAX = SPLIT_LIMITS.pattern;
const SCHEMA_TYPE = /^[A-Za-z]{1,40}$/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export type SplitCreateCode =
  "NOT_ALLOWED" | "NO_LINK" | "INVALID" | "LIMIT" | "NOT_ELIGIBLE";

type CreateResult =
  | { ok: true; test: SplitTestView }
  | { ok: false; code: SplitCreateCode; message: string };

type PreviewResult =
  | {
      ok: true;
      eligibility: SplitEligibility;
      pages: number;
      capped: boolean;
      groups: { group: string; pages: number }[];
    }
  | { ok: false; message: string };

type Done = { ok: true } | { ok: false; message: string };

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

async function audit(
  row: Pick<GscSplitTest, "id" | "workspaceId" | "projectId" | "changeKind">,
  action: string,
  userId: string,
): Promise<void> {
  try {
    await AuditLogRepository.record({
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      actorType: "USER",
      actorId: userId,
      action,
      entityType: "GscSplitTest",
      entityId: row.id,
      metadata: { kind: row.changeKind },
    });
  } catch {
    console.warn(`[gsc-split] audit failed: ${row.id}`);
  }
}

// --- görünüm -------------------------------------------------------------------

type ViewContext = {
  roles: Map<string, { isPrimary: boolean; isSecondary: boolean }>;
  hasSite: boolean;
  applyReady: boolean;
  cms: Map<
    string,
    { total: number; verified: number; failed: number; waiting: number }
  >;
};

function viewOf(row: GscSplitTest, ctx: ViewContext): SplitTestView {
  const kind: SplitChangeKind = isSplitChangeKind(row.changeKind)
    ? row.changeKind
    : "OTHER";
  const role = ctx.roles.get(row.linkId);
  const primary = Boolean(role?.isPrimary && !role.isSecondary);
  const population = record(row.population);
  const balance = record(row.balance);
  const change = parseSplitChange(row.change);
  const perGroup: SplitTestView["perGroup"] = [];
  for (const raw of Array.isArray(balance?.perGroup) ? balance.perGroup : []) {
    const item = record(raw);
    if (!item || typeof item.group !== "string") continue;
    perGroup.push({
      group: item.group.slice(0, 80),
      test: num(item.test),
      control: num(item.control),
    });
    if (perGroup.length >= SPLIT_MAX_GROUPS) break;
  }
  const pageGroups = (
    Array.isArray(population?.pageGroups) ? population.pageGroups : []
  )
    .filter((group): group is string => typeof group === "string")
    .slice(0, SPLIT_MAX_GROUPS);
  const status = isSplitStatus(row.status) ? row.status : "EXPIRED";
  const baseline = parseBaseline(row.baseline);
  const outcome =
    row.outcome === "WORKED" ||
    row.outcome === "DIDNT" ||
    row.outcome === "INCONCLUSIVE"
      ? row.outcome
      : null;
  return {
    id: row.id,
    projectId: row.projectId,
    linkId: row.linkId,
    isMock: row.isMock,
    isSecondarySite: Boolean(role?.isSecondary),
    name: row.name,
    changeKind: kind,
    description: row.description,
    status,
    pageGroups,
    capped: population?.capped === true,
    arms: { test: row.testPages, control: row.controlPages },
    perGroup,
    balance: {
      testClicks: num(balance?.testClicks),
      controlClicks: num(balance?.controlClicks),
      ratio: num(balance?.ratio),
      recommended: balance?.recommended === true,
    },
    change,
    appliedVia:
      row.appliedVia === "CMS"
        ? "CMS"
        : row.appliedVia === "MANUAL"
          ? "MANUAL"
          : null,
    appliedAt: iso(row.appliedAt),
    cms: ctx.cms.get(row.id) ?? null,
    verification: row.verification
      ? parseSplitVerification(row.verification)
      : null,
    measureFrom: iso(row.measureFrom),
    evaluateAfter: iso(row.evaluateAfter),
    windowDays: row.windowDays,
    evaluation: parseSplitEvaluation(row.evaluation),
    outcome,
    confidence:
      row.confidence === "SIGNIFICANT"
        ? "SIGNIFICANT"
        : row.confidence === "DIRECTIONAL"
          ? "DIRECTIONAL"
          : null,
    evaluatedAt: iso(row.evaluatedAt),
    createdAt: row.createdAt.toISOString(),
    canApplyViaCms:
      kind === "TITLE_META" &&
      primary &&
      status === "DRAFT" &&
      row.testPages <= SPLIT_CMS_MAX_ARM &&
      (change.titlePattern !== null || change.metaPattern !== null) &&
      ctx.applyReady,
    crawlerVerifiable: isCrawlerVerifiable({
      kind,
      change,
      baseline,
      linkPrimary: primary,
      hasSite: ctx.hasSite,
    }),
  };
}

async function contextFor(
  projectId: string,
  rows: readonly GscSplitTest[],
  now: Date,
): Promise<ViewContext> {
  const linkIds = [...new Set(rows.map((row) => row.linkId))];
  const links =
    linkIds.length > 0
      ? await prisma.gscSiteLink.findMany({
          where: { id: { in: linkIds } },
          select: { id: true, isPrimary: true, isSecondary: true },
        })
      : [];
  const roles = new Map(
    links.map((link) => [
      link.id,
      { isPrimary: link.isPrimary, isSecondary: link.isSecondary },
    ]),
  );
  const scope = rows.length > 0 ? await splitSiteScope(projectId) : null;
  const wantsCms = rows.some(
    (row) => row.changeKind === "TITLE_META" && row.status === "DRAFT",
  );
  // CMS hazır mı: liste başına TEK çağrı.
  const applyReady = wantsCms ? await splitCmsReady(projectId) : false;
  const cms: ViewContext["cms"] = new Map();
  for (const row of rows) {
    if (row.appliedVia === "CMS" && row.status === "APPLIED") {
      const sync = await syncCmsChanges(row, now);
      cms.set(row.id, {
        total: sync.total,
        verified: sync.verified,
        failed: sync.failed,
        waiting: sync.waiting,
      });
    }
  }
  return { roles, hasSite: scope !== null, applyReady, cms };
}

// --- doğrulama yardımcıları ----------------------------------------------------

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

type CleanInput =
  | {
      ok: true;
      change: SplitChange;
      groups: string[];
      name: string;
      description: string | null;
    }
  | { ok: false; message: string };

function cleanCreateInput(input: {
  name: string;
  changeKind: SplitChangeKind;
  description: string | null;
  pageGroups: string[];
  change: SplitChange;
}): CleanInput {
  const name = input.name.trim();
  if (name.length < 1 || name.length > SPLIT_LIMITS.name) {
    return {
      ok: false,
      message: "Give the test a name of up to 80 characters.",
    };
  }
  const description = cleanText(
    input.description,
    SPLIT_LIMITS.description + 1,
  );
  if (description && description.length > SPLIT_LIMITS.description) {
    return {
      ok: false,
      message: "The description can have up to 300 characters.",
    };
  }
  const groups = [
    ...new Set(input.pageGroups.map((group) => group.trim()).filter(Boolean)),
  ];
  if (groups.length < 1 || groups.length > SPLIT_MAX_GROUPS) {
    return { ok: false, message: "Choose between 1 and 5 page groups." };
  }
  const titlePattern = cleanText(
    input.change.titlePattern,
    META_PATTERN_MAX + 1,
  );
  const metaPattern = cleanText(input.change.metaPattern, META_PATTERN_MAX + 1);
  if (titlePattern && !validatePattern(titlePattern, TITLE_PATTERN_MAX)) {
    return {
      ok: false,
      message:
        "The title pattern can only use {title}, {h1}, {site} and {year}.",
    };
  }
  if (metaPattern && !validatePattern(metaPattern, META_PATTERN_MAX)) {
    return {
      ok: false,
      message:
        "The description pattern can only use {title}, {h1}, {site} and {year}.",
    };
  }
  const schemaType = cleanText(input.change.schemaType, 41);
  if (schemaType && !SCHEMA_TYPE.test(schemaType)) {
    return { ok: false, message: "Enter a schema type name, like FAQPage." };
  }
  if (input.changeKind === "SCHEMA" && !schemaType) {
    return {
      ok: false,
      message: "Enter the schema type you will add, like FAQPage.",
    };
  }
  const note = cleanText(input.change.note, SPLIT_LIMITS.note + 1);
  if (note && note.length > SPLIT_LIMITS.note) {
    return { ok: false, message: "The note can have up to 400 characters." };
  }
  return {
    ok: true,
    name,
    description,
    groups,
    change: {
      titlePattern: input.changeKind === "TITLE_META" ? titlePattern : null,
      metaPattern: input.changeKind === "TITLE_META" ? metaPattern : null,
      schemaType: input.changeKind === "SCHEMA" ? schemaType : null,
      note,
    },
  };
}

async function linkOf(projectId: string, linkId: string) {
  return prisma.gscSiteLink.findFirst({
    where: {
      id: linkId,
      projectId,
      isMock: gscMockMode(),
      OR: [{ isPrimary: true }, { isSecondary: true }],
    },
    select: { id: true, workspaceId: true, isPrimary: true, isSecondary: true },
  });
}

function preWeeksNow(now: Date): string[] {
  return evaluationWindows({ measureFrom: now, windowDays: 28 }).preWeeks;
}

// Uygulamadan ÖNCEKİ hâl: yalnız birincil bağda, kapsam içi adreslerden,
// kendi tarayıcımızın kaydından (en iyi çabayla).
async function sampleBaseline(input: {
  projectId: string;
  linkId: string;
  kind: SplitChangeKind;
  testIds: ReadonlySet<string>;
  controlIds: ReadonlySet<string>;
  candidates: readonly SplitCandidate[];
}): Promise<Prisma.InputJsonValue | null> {
  if (input.kind !== "TITLE_META" && input.kind !== "SCHEMA") return null;
  try {
    const scope = await splitSiteScope(input.projectId);
    if (!scope) return null;
    const pick = (ids: ReadonlySet<string>, limit: number) =>
      input.candidates
        .filter((candidate) => ids.has(candidate.pageId))
        .slice(0, limit)
        .map((candidate) => candidate.pageId);
    const testPick = pick(input.testIds, BASELINE_TEST_PAGES);
    const controlPick = pick(input.controlIds, BASELINE_CONTROL_PAGES);
    const pages = await prisma.gscPage.findMany({
      where: {
        id: { in: [...testPick, ...controlPick] },
        linkId: input.linkId,
      },
      select: { id: true, url: true },
    });
    const urlOf = new Map(pages.map((page) => [page.id, page.url]));
    const snap = async (ids: string[]) => {
      const out: {
        pageId: string;
        title: string | null;
        metaDescription: string | null;
        schemaTypes: string[];
      }[] = [];
      for (const pageId of ids) {
        const url = urlOf.get(pageId);
        if (!url || !sameSite(url, scope.hosts)) continue;
        const crawled = await readCrawledPage(scope.siteId, url);
        if (!crawled) continue;
        out.push({
          pageId,
          title: crawled.snapshot.title,
          metaDescription: crawled.snapshot.metaDescription,
          schemaTypes: crawled.snapshot.schemaTypes,
        });
      }
      return out;
    };
    const test = await snap(testPick);
    if (test.length === 0) return null;
    return json({ v: 1, test, control: await snap(controlPick) });
  } catch {
    return null;
  }
}

// --- depo ----------------------------------------------------------------------

async function populationPreview(input: {
  projectId: string;
  linkId: string;
  pageGroups: string[];
  now?: Date;
}): Promise<PreviewResult> {
  if (!gscAgencyActiveFor(input.projectId)) {
    return { ok: false, message: NOT_ALLOWED };
  }
  const now = input.now ?? new Date();
  const link = await linkOf(input.projectId, input.linkId);
  if (!link) return { ok: false, message: "That site isn't available." };
  const groups = [
    ...new Set(input.pageGroups.map((group) => group.trim()).filter(Boolean)),
  ];
  if (groups.length < 1 || groups.length > SPLIT_MAX_GROUPS) {
    return { ok: false, message: "Choose between 1 and 5 page groups." };
  }
  const exclude = await openPageIds({
    projectId: input.projectId,
    linkId: link.id,
    isMock: gscMockMode(),
  });
  const population = await readPopulation({
    linkId: link.id,
    pageGroups: groups,
    preWeeks: preWeeksNow(now),
    excludePageIds: exclude,
  });
  const eligibility = splitEligibility({
    candidates: population.candidates,
    groups,
    preWeeksCovered: population.coveredWeeks,
  });
  const counts = new Map(groups.map((group) => [group, 0]));
  for (const candidate of population.candidates) {
    counts.set(candidate.group, (counts.get(candidate.group) ?? 0) + 1);
  }
  return {
    ok: true,
    eligibility,
    pages: population.totalPages,
    capped: population.capped,
    groups: [...counts].map(([group, pages]) => ({ group, pages })),
  };
}

async function create(input: {
  projectId: string;
  linkId: string;
  userId: string;
  name: string;
  changeKind: SplitChangeKind;
  description: string | null;
  pageGroups: string[];
  change: SplitChange;
  now?: Date;
}): Promise<CreateResult> {
  if (!gscAgencyActiveFor(input.projectId)) {
    return { ok: false, code: "NOT_ALLOWED", message: NOT_ALLOWED };
  }
  const now = input.now ?? new Date();
  const link = await linkOf(input.projectId, input.linkId);
  if (!link) {
    return {
      ok: false,
      code: "NO_LINK",
      message: "That site isn't available.",
    };
  }
  const clean = cleanCreateInput(input);
  if (!clean.ok) {
    return { ok: false, code: "INVALID", message: clean.message };
  }
  const isMock = gscMockMode();
  const open = await prisma.gscSplitTest.count({
    where: { linkId: link.id, status: { in: [...OPEN_SPLIT_STATUSES] } },
  });
  if (open >= SPLIT_MAX_OPEN_PER_LINK) {
    return {
      ok: false,
      code: "LIMIT",
      message: "You can run up to 3 split tests per site at a time.",
    };
  }
  const known = new Set(
    (await GscPageGroups.listGroups(link.id, GROUP_LOOKUP_LIMIT)).map(
      (row) => row.group,
    ),
  );
  if (clean.groups.some((group) => !known.has(group))) {
    return {
      ok: false,
      code: "INVALID",
      message: "One of the page groups wasn't found. Reload and try again.",
    };
  }

  const preWeeks = preWeeksNow(now);
  const exclude = await openPageIds({
    projectId: input.projectId,
    linkId: link.id,
    isMock,
  });
  const population = await readPopulation({
    linkId: link.id,
    pageGroups: clean.groups,
    preWeeks,
    excludePageIds: exclude,
  });
  const eligibility = splitEligibility({
    candidates: population.candidates,
    groups: clean.groups,
    preWeeksCovered: population.coveredWeeks,
  });
  if (!eligibility.ok) {
    return {
      ok: false,
      code: "NOT_ELIGIBLE",
      message: SPLIT_ERROR_TEXT[eligibility.reason],
    };
  }

  const id = randomUUID();
  const assignment = assignArms({
    candidates: population.candidates,
    seed: id,
  });
  const testIds = new Set(assignment.test);
  const controlIds = new Set(assignment.control);
  const primary = link.isPrimary && !link.isSecondary;
  const baseline = primary
    ? await sampleBaseline({
        projectId: input.projectId,
        linkId: link.id,
        kind: input.changeKind,
        testIds,
        controlIds,
        candidates: population.candidates,
      })
    : null;
  const groupOf = new Map(
    population.candidates.map((c) => [c.pageId, c.group]),
  );
  const rows = [
    ...assignment.test.map((pageId) => ({ pageId, arm: "TEST" })),
    ...assignment.control.map((pageId) => ({ pageId, arm: "CONTROL" })),
  ].map(({ pageId, arm }) => ({
    testId: id,
    linkId: link.id,
    pageId,
    pageGroup: groupOf.get(pageId) ?? "",
    arm,
  }));
  const recommended =
    Math.min(assignment.test.length, assignment.control.length) >=
    SPLIT_RECOMMENDED_ARM;

  const created = await prisma.$transaction(
    async (tx) => {
      const test = await tx.gscSplitTest.create({
        data: {
          id,
          workspaceId: link.workspaceId,
          projectId: input.projectId,
          linkId: link.id,
          isMock,
          name: clean.name,
          changeKind: input.changeKind,
          description: clean.description,
          status: "DRAFT",
          population: json({
            v: 1,
            pageGroups: clean.groups,
            capped: population.capped,
            preWeeks,
          }),
          seed: id,
          testPages: assignment.test.length,
          controlPages: assignment.control.length,
          balance: json({
            ...assignment.balance,
            recommended,
            perGroup: assignment.perGroup,
          }),
          change: json(clean.change),
          ...(baseline ? { baseline } : {}),
          windowDays: splitWindowDays(input.changeKind),
          createdByUserId: input.userId,
        },
      });
      for (let offset = 0; offset < rows.length; offset += PAGES_CHUNK) {
        await tx.gscSplitTestPage.createMany({
          data: rows.slice(offset, offset + PAGES_CHUNK),
        });
      }
      return test;
    },
    { timeout: 60_000 },
  );
  await audit(created, "gsc_split_test.created", input.userId);
  const ctx = await contextFor(input.projectId, [created], now);
  return { ok: true, test: viewOf(created, ctx) };
}

async function list(
  projectId: string,
  linkId?: string,
): Promise<SplitTestView[]> {
  if (!gscAgencyOn()) return [];
  const rows = await prisma.gscSplitTest.findMany({
    where: {
      projectId,
      isMock: gscMockMode(),
      ...(linkId ? { linkId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: LIST_LIMIT,
  });
  if (rows.length === 0) return [];
  const ctx = await contextFor(projectId, rows, new Date());
  return rows.map((row) => viewOf(row, ctx));
}

async function get(
  projectId: string,
  testId: string,
): Promise<SplitTestView | null> {
  if (!gscAgencyOn()) return null;
  const row = await prisma.gscSplitTest.findFirst({
    where: { id: testId, projectId, isMock: gscMockMode() },
  });
  if (!row) return null;
  const ctx = await contextFor(projectId, [row], new Date());
  return viewOf(row, ctx);
}

async function markApplied(input: {
  projectId: string;
  testId: string;
  userId: string;
  appliedOn: string;
  now?: Date;
}): Promise<Done> {
  if (!gscAgencyActiveFor(input.projectId))
    return { ok: false, message: NOT_ALLOWED };
  const now = input.now ?? new Date();
  if (!DAY_KEY.test(input.appliedOn)) {
    return { ok: false, message: "Pick the day you made the change." };
  }
  const today = gscToday(now);
  if (input.appliedOn > today) {
    return { ok: false, message: "That day is in the future." };
  }
  if (input.appliedOn < addDays(today, -APPLIED_MAX_AGE_DAYS)) {
    return { ok: false, message: "That was more than 60 days ago." };
  }
  const appliedAt = new Date(`${input.appliedOn}T12:00:00.000Z`);
  if (Number.isNaN(appliedAt.getTime())) {
    return { ok: false, message: "Pick the day you made the change." };
  }
  const row = await prisma.gscSplitTest.findFirst({
    where: {
      id: input.testId,
      projectId: input.projectId,
      isMock: gscMockMode(),
    },
  });
  if (!row || row.status !== "DRAFT" || !isSplitChangeKind(row.changeKind)) {
    return { ok: false, message: "This test isn't waiting for a change." };
  }
  const kind = row.changeKind;
  const link = await prisma.gscSiteLink.findUnique({
    where: { id: row.linkId },
    select: { isPrimary: true, isSecondary: true },
  });
  const scope = link?.isPrimary ? await splitSiteScope(row.projectId) : null;
  const crawler = isCrawlerVerifiable({
    kind,
    change: parseSplitChange(row.change),
    baseline: parseBaseline(row.baseline),
    linkPrimary: Boolean(link?.isPrimary && !link.isSecondary),
    hasSite: scope !== null,
  });

  const common = {
    appliedVia: "MANUAL",
    appliedAt,
    appliedByUserId: input.userId,
  };
  let data: Prisma.GscSplitTestUpdateManyMutationInput;
  if (crawler) {
    // Tarayıcı doğrulaması sıradaki turda başlar.
    data = { ...common, status: "APPLIED", nextCheckAt: now };
  } else {
    // Doğrulanacak bir şey yok: kullanıcının beyanıyla hemen ölçüme geçer.
    const fields = splitMeasuring({
      kind,
      appliedAt,
      verifiedAt: now,
      method: "USER",
    });
    data = {
      ...common,
      status: "EVALUATING",
      measureFrom: fields.measureFrom,
      evaluateAfter: fields.evaluateAfter,
      nextCheckAt: fields.nextCheckAt,
      verification: json({
        v: 1,
        attempts: 0,
        lastCheckedAt: null,
        checks: [],
        method: "USER",
        reason: null,
      }),
    };
  }
  const moved = await prisma.gscSplitTest.updateMany({
    where: { id: row.id, status: "DRAFT" },
    data,
  });
  if (moved.count !== 1) {
    return { ok: false, message: "This test isn't waiting for a change." };
  }
  await audit(row, "gsc_split_test.applied", input.userId);
  return { ok: true };
}

async function applyViaCms(input: {
  projectId: string;
  testId: string;
  userId: string;
  now?: Date;
}): Promise<
  | { ok: true; proposed: number; skipped: number }
  | { ok: false; message: string }
> {
  if (!gscAgencyActiveFor(input.projectId))
    return { ok: false, message: NOT_ALLOWED };
  const now = input.now ?? new Date();
  const row = await prisma.gscSplitTest.findFirst({
    where: {
      id: input.testId,
      projectId: input.projectId,
      isMock: gscMockMode(),
    },
  });
  if (!row || row.status !== "DRAFT") {
    return { ok: false, message: "This test isn't waiting for a change." };
  }
  const result = await proposeSplitChanges({
    projectId: input.projectId,
    userId: input.userId,
    test: row,
    now,
  });
  if (result.proposed === 0) {
    return {
      ok: false,
      message:
        result.skipped > 0
          ? "None of the test pages could be changed through your site. You can apply the change yourself instead."
          : "This test can't be applied through your site.",
    };
  }
  await audit(row, "gsc_split_test.applied", input.userId);
  return { ok: true, proposed: result.proposed, skipped: result.skipped };
}

async function cancel(input: {
  projectId: string;
  testId: string;
  userId: string;
}): Promise<Done> {
  if (!gscAgencyActiveFor(input.projectId))
    return { ok: false, message: NOT_ALLOWED };
  const row = await prisma.gscSplitTest.findFirst({
    where: {
      id: input.testId,
      projectId: input.projectId,
      isMock: gscMockMode(),
    },
  });
  if (!row) return { ok: false, message: "This test no longer exists." };
  const moved = await prisma.gscSplitTest.updateMany({
    where: { id: row.id, status: { in: [...OPEN_SPLIT_STATUSES] } },
    data: { status: "CANCELLED", nextCheckAt: null },
  });
  if (moved.count !== 1) {
    return { ok: false, message: "This test is already finished." };
  }
  await audit(row, "gsc_split_test.cancelled", input.userId);
  return { ok: true };
}

async function checkNow(
  projectId: string,
  testId: string,
  now: Date = new Date(),
): Promise<"queued" | "too_soon" | "not_found"> {
  if (!gscAgencyOn()) return "not_found";
  const row = await prisma.gscSplitTest.findFirst({
    where: { id: testId, projectId, isMock: gscMockMode() },
  });
  if (!row || (row.status !== "APPLIED" && row.status !== "EVALUATING")) {
    return "not_found";
  }
  const last = parseSplitVerification(row.verification).lastCheckedAt;
  const lastMs = last ? Date.parse(last) : Number.NaN;
  if (!Number.isNaN(lastMs) && now.getTime() - lastMs < CHECK_NOW_MIN_GAP_MS) {
    return "too_soon";
  }
  const moved = await prisma.gscSplitTest.updateMany({
    where: { id: row.id, status: row.status },
    data: { nextCheckAt: now },
  });
  return moved.count === 1 ? "queued" : "not_found";
}

// Tick adımı. Kapalıyken veritabanına gitmez; her test kendi kirasıyla
// işlenir, yeni teste başlamadan önce süre bakılır, hiçbir koşulda fırlatmaz.
async function runDue(
  limit = 5,
  now: Date = new Date(),
  deadlineAt?: number,
): Promise<number> {
  if (!gscAgencyOn()) return 0;
  const restricted = gscRestrictedProjects();
  if (restricted && restricted.length === 0) return 0;
  const isMock = gscMockMode();
  const scope = {
    isMock,
    ...(restricted ? { projectId: { in: restricted } } : {}),
  };

  // Dokunulmayan taslaklar 30 gün sonra düşer.
  await prisma.gscSplitTest.updateMany({
    where: {
      ...scope,
      status: "DRAFT",
      createdAt: { lt: new Date(now.getTime() - DRAFT_EXPIRE_DAYS * DAY_MS) },
    },
    data: { status: "EXPIRED", nextCheckAt: null },
  });

  const candidates = await prisma.gscSplitTest.findMany({
    where: {
      ...scope,
      AND: [
        { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        {
          OR: [
            { status: "APPLIED", nextCheckAt: { lte: now } },
            {
              status: "EVALUATING",
              evaluateAfter: { lte: now },
              OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }],
            },
          ],
        },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: limit * 3,
    select: { id: true, projectId: true, status: true },
  });

  let processed = 0;
  for (const candidate of candidates) {
    if (processed >= limit) break;
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) break;
    if (!gscSyncAllowedFor(candidate.projectId)) continue;
    const owner = randomUUID();
    const claimed = await prisma.gscSplitTest.updateMany({
      where: {
        id: candidate.id,
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      data: {
        leaseOwner: owner,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
      },
    });
    if (claimed.count !== 1) continue;
    processed += 1;
    try {
      if (candidate.status === "APPLIED") {
        await verifySplitTest(candidate.id, now, {
          remaining: () =>
            deadlineAt === undefined
              ? Number.POSITIVE_INFINITY
              : deadlineAt - Date.now(),
        });
      } else {
        await evaluateSplitTest(candidate.id, now);
      }
    } catch (error) {
      console.warn(
        `[gsc-split] run failed: ${candidate.id} ${error instanceof Error ? error.name : "unknown"}`,
      );
    } finally {
      await prisma.gscSplitTest
        .updateMany({
          where: { id: candidate.id, leaseOwner: owner },
          data: { leaseOwner: null, leaseUntil: null },
        })
        .catch(() => undefined);
    }
  }
  return processed;
}

export const GscSplitTests = {
  populationPreview,
  create,
  list,
  get,
  markApplied,
  applyViaCms,
  cancel,
  checkNow,
  runDue,
};
