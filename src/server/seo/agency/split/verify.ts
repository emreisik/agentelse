import "server-only";

import type { GscSplitTest, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { verifySchedule, verifyTimingFor } from "@/lib/seo/actions/lifecycle";
import type { VerificationCheck } from "@/lib/seo/actions/types";
import type { ObservedPage } from "@/lib/seo/actions/verify-checks";
import { splitFixKind } from "@/lib/seo/agency/split/evaluate";
import { sameSite } from "@/lib/seo/agency/split/patterns";
import {
  parseSplitChange,
  parseSplitVerification,
  isSplitChangeKind,
  type SplitChange,
  type SplitChangeKind,
  type SplitVerification,
} from "@/lib/seo/agency/split/types";
import {
  isCrawlerKind,
  splitMeasuring,
  verifySplitSample,
  type SampleSnapshot,
} from "@/lib/seo/agency/split/verify";
import type { SiteFetchDeps } from "@/server/seo/crawl/fetcher";
import { checkPage, pageCheckSite } from "@/server/seo/actions/page-check";

import { syncCmsChanges } from "./apply-cms";
import { markCmsFailed } from "./cms-items";
import { splitSiteScope } from "./population";

// Bölünmüş testin günlük doğrulayıcısı (docs/search-agency.md). APPLIED
// testin değişikliğini yalnız crawlerVerifiable testlerde KENDİ tarayıcımızla
// görür (örnek en çok 5 test + 3 kontrol sayfası); CMS yolunda SC-F8
// değişikliklerinin durumuna bakar; her iki yol da doğrulanınca testi ölçüme
// geçirir. Kapsam dışı adresler ve ikincil siteler hiç getirilmez.

export type SplitVerifyResult =
  "verified" | "pending" | "asked" | "expired" | "deadline";

export type SplitVerifyDeps = {
  fetch?: Partial<SiteFetchDeps>;
  remaining?: () => number;
};

const MIN_FETCH_MS = 3_000;

type Baseline = { test: SampleSnapshot[]; control: SampleSnapshot[] };

function samples(value: unknown): SampleSnapshot[] {
  if (!Array.isArray(value)) return [];
  const out: SampleSnapshot[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.pageId !== "string") continue;
    out.push({
      pageId: item.pageId,
      title: typeof item.title === "string" ? item.title : null,
      metaDescription:
        typeof item.metaDescription === "string" ? item.metaDescription : null,
      schemaTypes: Array.isArray(item.schemaTypes)
        ? item.schemaTypes.filter((t): t is string => typeof t === "string")
        : [],
    });
  }
  return out;
}

export function parseBaseline(raw: unknown): Baseline | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const test = samples(item.test);
  if (test.length === 0) return null;
  return { test, control: samples(item.control) };
}

// Tarayıcıyla doğrulanabilir mi: tür, birincil bağ, kapsamı olan site ve
// karşılaştırılacak bir taban (başlık/meta için örnek, şema için tür adı).
export function isCrawlerVerifiable(input: {
  kind: SplitChangeKind;
  change: SplitChange;
  baseline: Baseline | null;
  linkPrimary: boolean;
  hasSite: boolean;
}): boolean {
  if (!isCrawlerKind(input.kind) || !input.linkPrimary || !input.hasSite) {
    return false;
  }
  return input.kind === "SCHEMA"
    ? input.change.schemaType !== null
    : input.baseline !== null;
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function verificationOf(
  previous: SplitVerification,
  now: Date,
  patch: Partial<SplitVerification>,
): SplitVerification {
  return {
    ...previous,
    attempts: previous.attempts + 1,
    lastCheckedAt: now.toISOString(),
    ...patch,
  };
}

// Doğrulanmış test ölçüme geçer (yalnız hâlâ APPLIED ise).
async function startMeasuring(
  row: GscSplitTest,
  kind: SplitChangeKind,
  now: Date,
  method: "CRAWLER" | "USER" | "CMS",
  verification: SplitVerification,
  appliedAt: Date,
  extra: Prisma.GscSplitTestUpdateManyMutationInput = {},
): Promise<SplitVerifyResult> {
  const fields = splitMeasuring({ kind, appliedAt, verifiedAt: now, method });
  const moved = await prisma.gscSplitTest.updateMany({
    where: { id: row.id, status: "APPLIED" },
    data: {
      status: "EVALUATING",
      measureFrom: fields.measureFrom,
      evaluateAfter: fields.evaluateAfter,
      nextCheckAt: fields.nextCheckAt,
      verification: json({ ...verification, method }),
      verifyAttempts: { increment: 1 },
      ...extra,
    },
  });
  return moved.count === 1 ? "verified" : "pending";
}

// Doğrulanamayan testin sonraki bakışı; süre aşımı EXPIRED yapar.
async function reschedule(
  row: GscSplitTest,
  kind: SplitChangeKind,
  now: Date,
  verification: SplitVerification,
  fetchFailed: boolean,
): Promise<SplitVerifyResult> {
  const plan = verifySchedule({
    now,
    appliedAt: row.appliedAt ?? row.createdAt,
    askedAt: row.askedAt,
    fetchFailed,
    quickRetries: null,
    timing: verifyTimingFor(splitFixKind(kind), null),
  });
  if (plan.expire) {
    await prisma.gscSplitTest.updateMany({
      where: { id: row.id, status: "APPLIED" },
      data: {
        status: "EXPIRED",
        nextCheckAt: null,
        verification: json(verification),
        verifyAttempts: { increment: 1 },
      },
    });
    return "expired";
  }
  await prisma.gscSplitTest.updateMany({
    where: { id: row.id, status: "APPLIED" },
    data: {
      nextCheckAt: plan.nextCheckAt,
      verification: json(verification),
      verifyAttempts: { increment: 1 },
      ...(plan.ask ? { askedAt: now } : {}),
    },
  });
  return plan.ask ? "asked" : "pending";
}

async function verifyCms(
  row: GscSplitTest,
  kind: SplitChangeKind,
  now: Date,
  previous: SplitVerification,
): Promise<SplitVerifyResult> {
  const sync = await syncCmsChanges(row, now);
  // Hepsi doğrulandıysa ya da bekleyen kalmadı ve en az biri doğrulandıysa
  // ölçüm başlar. Başarısız değişikliklerin sayfaları kolun dışında tutulur
  // (öğe "FAILED" işaretlenir); yoksa test süre aşımına kadar takılı kalırdı.
  const settled = sync.waiting === 0 && sync.verified > 0;
  if (sync.total > 0 && (sync.verified === sync.total || settled)) {
    const verification = verificationOf(previous, now, {
      method: "CMS",
      reason: null,
      checks: [
        {
          key: "cms_changes",
          label: "Every change was confirmed on your site",
          ok: true,
          observed: `${sync.verified} of ${sync.total} pages`,
        },
      ],
    });
    return startMeasuring(
      row,
      kind,
      now,
      "CMS",
      verification,
      sync.allVerifiedAt ?? now,
      sync.failedIds.length > 0
        ? {
            cmsChanges: markCmsFailed(
              row.cmsChanges,
              sync.failedIds,
            ) as Prisma.InputJsonValue,
          }
        : {},
    );
  }
  const verification = verificationOf(previous, now, {
    method: "CMS",
    reason: sync.failed > 0 ? "CMS_CHANGE_FAILED" : null,
    checks: [
      {
        key: "cms_changes",
        label: "Every change was confirmed on your site",
        ok: false,
        observed: `${sync.verified} of ${sync.total} pages`,
      },
    ],
  });
  return reschedule(row, kind, now, verification, false);
}

export async function verifySplitTest(
  testId: string,
  now: Date,
  deps: SplitVerifyDeps = {},
): Promise<SplitVerifyResult> {
  const row = await prisma.gscSplitTest.findUnique({ where: { id: testId } });
  if (!row || row.status !== "APPLIED") return "pending";
  if (!isSplitChangeKind(row.changeKind)) return "pending";
  const kind = row.changeKind;
  const change = parseSplitChange(row.change);
  const previous = parseSplitVerification(row.verification);
  const appliedAt = row.appliedAt ?? row.createdAt;

  if (row.appliedVia === "CMS") return verifyCms(row, kind, now, previous);

  const link = await prisma.gscSiteLink.findUnique({
    where: { id: row.linkId },
    select: { isPrimary: true, isSecondary: true },
  });
  const scope = link?.isPrimary ? await splitSiteScope(row.projectId) : null;
  const baseline = parseBaseline(row.baseline);
  const crawlerOk = isCrawlerVerifiable({
    kind,
    change,
    baseline,
    linkPrimary: Boolean(link?.isPrimary && !link.isSecondary),
    hasSite: scope !== null,
  });
  // Tarayıcı bu testi hiç göremez: kullanıcının beyanı geçerlidir.
  if (!crawlerOk || !scope) {
    return startMeasuring(
      row,
      kind,
      now,
      "USER",
      verificationOf(previous, now, { method: "USER", reason: null }),
      appliedAt,
    );
  }

  const site = await pageCheckSite(row.projectId);
  if (!site) {
    return startMeasuring(
      row,
      kind,
      now,
      "USER",
      verificationOf(previous, now, { method: "USER", reason: "NO_SITE" }),
      appliedAt,
    );
  }

  // Örnek sayfalar: kapsam içinde olanlar; öteki adresler örnekten düşer.
  const ids = [
    ...(baseline?.test ?? []).map((s) => s.pageId),
    ...(baseline?.control ?? []).map((s) => s.pageId),
  ];
  const pages = await prisma.gscPage.findMany({
    where: { id: { in: ids }, linkId: row.linkId },
    select: { id: true, url: true },
  });
  const urlOf = new Map(pages.map((page) => [page.id, page.url]));
  const keep = (snapshots: SampleSnapshot[]) =>
    snapshots.flatMap((snapshot) => {
      const url = urlOf.get(snapshot.pageId);
      return url && sameSite(url, scope.hosts) ? [{ snapshot, url }] : [];
    });
  const testSample = keep(baseline?.test ?? []);
  const controlSample = keep(baseline?.control ?? []);
  if (testSample.length === 0) {
    return startMeasuring(
      row,
      kind,
      now,
      "USER",
      verificationOf(previous, now, { method: "USER", reason: null }),
      appliedAt,
    );
  }

  const remaining = deps.remaining ?? (() => Number.POSITIVE_INFINITY);
  const fetchAll = async (
    list: { snapshot: SampleSnapshot; url: string }[],
  ): Promise<(ObservedPage | null)[] | "deadline"> => {
    const out: (ObservedPage | null)[] = [];
    for (const { url } of list) {
      if (remaining() < MIN_FETCH_MS) return "deadline";
      const result = await checkPage(site, url, {
        ...(deps.fetch ? { deps: deps.fetch } : {}),
        now,
      });
      out.push(result.page);
    }
    return out;
  };
  const observedTest = await fetchAll(testSample);
  if (observedTest === "deadline") return "deadline";
  const observedControl = await fetchAll(controlSample);
  if (observedControl === "deadline") return "deadline";

  const result = verifySplitSample({
    kind,
    change,
    baseline: {
      test: testSample.map((item) => item.snapshot),
      control: controlSample.map((item) => item.snapshot),
    },
    observedTest,
    observedControl,
  });
  const checks: VerificationCheck[] = result.checks;
  if (result.verified) {
    return startMeasuring(
      row,
      kind,
      now,
      "CRAWLER",
      verificationOf(previous, now, {
        method: "CRAWLER",
        reason: null,
        checks,
      }),
      appliedAt,
    );
  }
  const verification = verificationOf(previous, now, {
    method: "CRAWLER",
    reason: result.reason,
    checks,
  });
  return reschedule(row, kind, now, verification, false);
}
