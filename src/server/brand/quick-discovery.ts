import "server-only";

import { randomBytes } from "node:crypto";

import type { Row } from "@/lib/guided-discovery/contract";
import { applyTiers, type ConfidenceMap } from "@/lib/guided-discovery/tiers";
import { languageLabel, countryLabel } from "@/lib/locales";
import { prisma } from "@/lib/prisma";
import {
  BrandConstitutionPayloadSchema,
  type BrandConstitutionPayload,
} from "@/server/agency/constitution/constitution-schema";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import {
  fillEmptyConstitution,
  isGuidedOnlyRaw,
} from "@/server/brand/constitution-merge";
import { scrubDiscoveredPayload } from "@/server/brand/constitution-scrub";
import { normalizeScanUrl } from "@/server/brand/site-scan/scan";
import {
  quickDiscoveryDef,
  quickDiscoveryGuidedDef,
} from "@/server/reasoning/prompts/quick-discovery";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import {
  htmlToText,
  pageTitle,
  sectionLinks,
} from "@/server/research/page-text";
import {
  findFreshPageEvidence,
  recordPageEvidence,
} from "@/server/research/web-evidence";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { BrandConstitutionRepository } from "@/server/repositories/brand-constitution.repository";
import { isAgentelseError, type ErrorCode } from "@/server/security/errors";
import { safeFetch, UnsafeUrlError } from "@/server/security/safe-fetch";

// Quick Discovery: the first look at a new brand, done when the client first
// talks to the agent instead of as a long onboarding they must sit through.
// It reads the brand's own website (through the SSRF-safe fetcher), asks the
// model for one compact Brand Constitution with a little live web search, and
// stores it as version 1, so from the very next word the agent knows what the
// brand is. The 12-stage deep setup can still run later and writes version 2
// over it.
//
// Hard rules, because the input is public and untrusted:
//  - approvedClaims are ALWAYS empty. Nothing scraped from a page becomes a
//    claim the agency may publish; the client approves those.
//  - The page text is handed to the model as data (see the prompt), and only
//    ever ends up in Evidence and in the constitution the model writes from it.
//  - Anything that goes wrong is a FAILED result, never an exception: the chat
//    turn that triggered it carries on without brand context.

export type QuickDiscoveryTarget = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  brandName: string;
  domain?: string;
  language: string;
  country: string;
  // The client's own words (already filtered by the caller). Guided runs only.
  description?: string;
  // Set by claim(projectId, { guided: true }): switches on the fence, the
  // scrub, the late-landing merge and the relaxed claim gate. Without it a
  // run behaves exactly as it always did.
  guided?: true;
};

export type QuickDiscoveryResult =
  // reasoningCallId and rows are only set on guided runs (the runner reads the
  // cost; rows are the confidence tiers of the fields that were saved).
  | {
      status: "DONE";
      version: number;
      pages: number;
      reasoningCallId?: string;
      rows?: Row[];
    }
  | { status: "FAILED"; message: string; code?: ErrorCode }
  // The scan is still running when the caller stopped waiting for it; it
  // finishes on its own and the brand is known from the next turn.
  | { status: "PENDING" };

export type QuickDiscoveryDeps = {
  fetch?: typeof safeFetch;
  reason?: typeof ReasoningService.run;
};

// A started scan (running or just failed) blocks another for this long, so a
// chatty first minute cannot start the same paid scan over and over.
const COOLDOWN_MS = 10 * 60 * 1000;
// A page read this recently is reused, not fetched again.
const PAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HOME_CHARS = 7_000;
const SECTION_CHARS = 3_500;
const MIN_USEFUL_TEXT_CHARS = 80;
const HTML_LIMIT = 600_000;

type SitePage = {
  url: string;
  title?: string;
  text: string;
  evidenceId: string;
};

const STARTED = "brand.quick_discovery.started";

export const QuickDiscoveryService = {
  // Decides whether a scan should run now, and if so records that it has
  // started (which is also what makes it run once). Null means "not now":
  // mock mode, a project that is not active, a brand that already has a
  // constitution, or a scan that started in the last few minutes.
  async claim(
    projectId: string,
    options?: { guided?: boolean },
  ): Promise<QuickDiscoveryTarget | null> {
    // Mock mode is for tests and seeding; a made-up constitution has no place
    // in a real project's Brand Brain.
    if (ReasoningService.isMockMode()) return null;

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        workspaceId: true,
        name: true,
        domain: true,
        status: true,
        language: true,
        country: true,
        brands: {
          where: { isDefault: true },
          select: { id: true, name: true },
          take: 1,
        },
      },
    });
    const brand = project?.brands[0];
    if (!project || !brand || project.status !== "ACTIVE") return null;

    const active = await BrandConstitutionRepository.getActive(brand.id);
    if (active) {
      // A guided run may still look at a brand whose only "profile" is a mock
      // row or a thin one the guided setup wrote from a few taps.
      const relaxed =
        options?.guided === true &&
        (active.isMock || isGuidedOnlyRaw(active.payload));
      if (!relaxed) return null;
    }

    const recent = await prisma.auditLog.findFirst({
      where: {
        projectId,
        action: STARTED,
        createdAt: { gte: new Date(Date.now() - COOLDOWN_MS) },
      },
      select: { id: true },
    });
    if (recent) return null;

    await AuditLogRepository.record({
      workspaceId: project.workspaceId,
      projectId,
      brandId: brand.id,
      actorType: "SYSTEM",
      action: STARTED,
      entityType: "Project",
      entityId: projectId,
    });

    return {
      workspaceId: project.workspaceId,
      projectId,
      brandId: brand.id,
      brandName: brand.name || project.name,
      domain: project.domain?.trim() || undefined,
      language: project.language || "tr",
      country: project.country || "TR",
      ...(options?.guided === true ? { guided: true as const } : {}),
    };
  },

  // Never rejects: every failure comes back as { status: "FAILED" }.
  async run(
    target: QuickDiscoveryTarget,
    deps: QuickDiscoveryDeps = {},
  ): Promise<QuickDiscoveryResult> {
    const scope = {
      workspaceId: target.workspaceId,
      projectId: target.projectId,
      brandId: target.brandId,
    };
    try {
      const pages = await readSitePages(target, deps.fetch ?? safeFetch);

      // Guided runs only: a per-call fence around the (untrusted) page text.
      // Any occurrence inside a page is removed so a page cannot close it.
      const fence = target.guided ? randomBytes(8).toString("hex") : undefined;
      const description = target.description?.trim();

      const reason = deps.reason ?? ReasoningService.run.bind(ReasoningService);
      const context = {
        brandName: target.brandName,
        domain: target.domain,
        language: target.language,
        country: target.country,
        languageName: languageLabel(target.language),
        countryName: countryLabel(target.country),
        pages: pages.map(({ url, title, text }) =>
          fence
            ? {
                url: url.split(fence).join(""),
                title: title?.split(fence).join(""),
                text: text.split(fence).join(""),
              }
            : { url, title, text },
        ),
        ...(target.guided && description ? { description } : {}),
        ...(fence ? { fence } : {}),
      };
      // Guided runs use the same brief plus a per-field confidence; the
      // confidence is split off here so it never reaches the stored payload.
      let output: Record<string, unknown>;
      let confidence: ConfidenceMap = {};
      let isMock: boolean;
      let reasoningCallId: string | undefined;
      if (target.guided) {
        const called = await reason(quickDiscoveryGuidedDef, {
          ...scope,
          context,
        });
        const { confidence: given, ...rest } = called.output;
        output = rest;
        // A reasoner that returns no confidence at all means "not found".
        confidence = given ?? {};
        isMock = called.isMock;
        reasoningCallId = called.reasoningCallId;
      } else {
        const called = await reason(quickDiscoveryDef, { ...scope, context });
        output = called.output;
        isMock = called.isMock;
        reasoningCallId = called.reasoningCallId;
      }

      const parsed = BrandConstitutionPayloadSchema.parse({
        ...output,
        // The known-correct codes, not the model's paraphrase of them.
        language: target.language,
        country: target.country,
        // Never from public pages: a claim is the client's to approve.
        approvedClaims: [],
        logoAssetIds: [],
      });

      // Web-derived text reaches the constitution only through the scrub on
      // guided runs; what it drops is counted, never logged.
      let payload = parsed;
      // What may be written to the dossier: accepted fields only (guided).
      let dossierPayload = parsed;
      let rows: Row[] | undefined;
      if (target.guided) {
        const scrubbed = scrubDiscoveredPayload(parsed);
        payload = scrubbed.payload;
        if (scrubbed.dropped > 0) {
          await AuditLogRepository.record({
            ...scope,
            actorType: "SYSTEM",
            action: "brand.quick_discovery.scrubbed",
            entityType: "Project",
            entityId: target.projectId,
            metadata: { count: scrubbed.dropped },
          }).catch(() => undefined);
        }
        // Tiers go after the scrub and BEFORE anything is published: an
        // assumed value stays (plus an assumption line), an unknown one is
        // emptied, and only accepted values may reach the dossier.
        const applied = applyTiers(payload, confidence);
        payload = applied.payload;
        dossierPayload = applied.dossierPayload;
        rows = applied.rows;
      }

      const evidenceIds = pages.map((page) => page.evidenceId);
      let constitution: { id: string; version: number };
      if (!target.guided) {
        constitution = await ConstitutionService.publishVersion({
          scope,
          payload,
          isMock,
          sourceFindingIds: [],
          evidenceIds,
          note: "quick discovery",
        });
      } else {
        // The person's Approve may have landed while the model was working:
        // decide again from what is ACTIVE now, never from what claim() saw.
        const active = await BrandConstitutionRepository.getActive(
          target.brandId,
        );
        let toPublish = payload;
        let note = "quick discovery";
        if (active && !active.isMock) {
          if (!isGuidedOnlyRaw(active.payload)) {
            // A researched profile appeared: it is never overwritten.
            await AuditLogRepository.record({
              ...scope,
              actorType: "SYSTEM",
              action: "brand.quick_discovery.skipped",
              entityType: "Project",
              entityId: target.projectId,
              metadata: { reason: "profile_exists" },
            }).catch(() => undefined);
            return {
              status: "FAILED",
              message: "A brand profile already exists.",
            };
          }
          // The person's thin profile wins field by field; research fills gaps.
          const activePayload = BrandConstitutionPayloadSchema.parse(
            active.payload,
          );
          const merged = fillEmptyConstitution(activePayload, payload);
          if (!merged.changed) {
            await fillEmptyDossierFields(scope, target, dossierPayload).catch(
              logDossierFailure(target),
            );
            return {
              status: "DONE",
              version: active.version,
              pages: pages.length,
              reasoningCallId,
              ...(rows ? { rows } : {}),
            };
          }
          toPublish = merged.payload;
          note = "quick discovery (merged)";
        }
        // No ACTIVE row, or a MOCK one that this version supersedes.
        constitution = await ConstitutionService.publishVersion({
          scope,
          payload: toPublish,
          isMock,
          sourceFindingIds: [],
          evidenceIds,
          note,
          ifActiveVersion: active?.version ?? null,
        });
      }

      // The constitution is already stored at this point, so a dossier that
      // could not be filled must not turn a finished scan into a failure.
      await fillEmptyDossierFields(scope, target, dossierPayload).catch(
        logDossierFailure(target),
      );

      await AuditLogRepository.record({
        ...scope,
        actorType: "SYSTEM",
        action: "brand.quick_discovery.completed",
        entityType: "BrandConstitution",
        entityId: constitution.id,
        metadata: { version: constitution.version, pages: pages.length },
      }).catch(() => undefined);

      return {
        status: "DONE",
        version: constitution.version,
        pages: pages.length,
        ...(target.guided ? { reasoningCallId } : {}),
        ...(rows ? { rows } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[quick-discovery] failed for project ${target.projectId}:`,
        message,
      );
      await AuditLogRepository.record({
        ...scope,
        actorType: "SYSTEM",
        action: "brand.quick_discovery.failed",
        entityType: "Project",
        entityId: target.projectId,
        metadata: { error: message },
      }).catch(() => undefined);
      return {
        status: "FAILED",
        message,
        ...(isAgentelseError(error) ? { code: error.code } : {}),
      };
    }
  },

  // run(), but stops waiting after `waitMs`. The scan itself is not cancelled:
  // it finishes in the background and the brand is known from the next turn.
  async runWithin(
    target: QuickDiscoveryTarget,
    waitMs: number,
    deps: QuickDiscoveryDeps = {},
  ): Promise<QuickDiscoveryResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<QuickDiscoveryResult>((resolve) => {
      timer = setTimeout(() => resolve({ status: "PENDING" }), waitMs);
    });
    try {
      return await Promise.race([
        QuickDiscoveryService.run(target, deps),
        pending,
      ]);
    } finally {
      clearTimeout(timer);
    }
  },
};

function logDossierFailure(target: QuickDiscoveryTarget) {
  return (error: unknown) => {
    console.error(
      `[quick-discovery] dossier fill failed for project ${target.projectId}:`,
      error instanceof Error ? error.message : error,
    );
  };
}

// --- reading the site --------------------------------------------------------

const HTML_FETCH = {
  maxBytes: HTML_LIMIT,
  truncate: true,
  timeoutMs: 12_000,
  accept: "text/html,application/xhtml+xml",
  allowedContentTypes: /^(text\/html|application\/xhtml\+xml)/i,
} as const;

async function readSitePages(
  target: QuickDiscoveryTarget,
  fetcher: typeof safeFetch,
): Promise<SitePage[]> {
  if (!target.domain) return [];
  let homeUrl: string;
  try {
    homeUrl = normalizeScanUrl(target.domain);
  } catch {
    return [];
  }
  const scope = {
    workspaceId: target.workspaceId,
    projectId: target.projectId,
    brandId: target.brandId,
  };

  // The home page is always read fresh: its links are how we find the other
  // pages worth reading, and that needs the HTML, which the cache does not keep.
  const home = await fetchHtml(
    fetcher,
    homeUrl,
    !/^[a-z][a-z0-9+.-]*:\/\//i.test(target.domain),
  );
  if (!home) return [];

  const pages: SitePage[] = [];
  const homeText = htmlToText(home.html, HOME_CHARS);
  if (homeText.length >= MIN_USEFUL_TEXT_CHARS) {
    const title = pageTitle(home.html);
    pages.push({
      url: home.url,
      title,
      text: homeText,
      evidenceId: await recordPageEvidence(scope, {
        url: home.url,
        title,
        text: homeText,
      }),
    });
  }

  const sections = await Promise.all(
    sectionLinks(home.html, home.url).map(
      async (url): Promise<SitePage | null> => {
        const cached = await findFreshPageEvidence(
          target.projectId,
          url,
          PAGE_MAX_AGE_MS,
        );
        if (cached) {
          return {
            url: cached.url,
            title: cached.title ?? undefined,
            text: cached.text.slice(0, SECTION_CHARS),
            evidenceId: cached.id,
          };
        }
        const fetched = await fetchHtml(fetcher, url, false);
        if (!fetched) return null;
        const text = htmlToText(fetched.html, SECTION_CHARS);
        if (text.length < MIN_USEFUL_TEXT_CHARS) return null;
        const title = pageTitle(fetched.html);
        return {
          url: fetched.url,
          title,
          text,
          evidenceId: await recordPageEvidence(scope, {
            url: fetched.url,
            title,
            text,
          }),
        };
      },
    ),
  );
  pages.push(...sections.filter((page): page is SitePage => page !== null));
  return pages;
}

// One page, or null. An unsafe or unreachable page is simply skipped: the scan
// works with whatever it could read (and with web search alone if nothing).
async function fetchHtml(
  fetcher: typeof safeFetch,
  url: string,
  tryPlainHttp: boolean,
): Promise<{ url: string; html: string } | null> {
  const attempt = async (candidate: string) => {
    const response = await fetcher(candidate, HTML_FETCH);
    return { url: response.url, html: response.body.toString("utf-8") };
  };
  try {
    return await attempt(url);
  } catch (error) {
    if (error instanceof UnsafeUrlError) return null;
    // A bare domain defaults to https; some sites only answer on http.
    if (tryPlainHttp) {
      try {
        return await attempt(url.replace(/^https:/, "http:"));
      } catch {
        return null;
      }
    }
    return null;
  }
}

// --- the dossier -------------------------------------------------------------

// The execution context that briefs every creative and copy job reads the
// BrandDossier columns, not the constitution. Fill the ones that are still
// empty from the first read so those jobs are not briefed blind; anything the
// client (or an earlier setup) already wrote is left exactly as it is.
async function fillEmptyDossierFields(
  scope: { workspaceId: string; projectId: string; brandId: string },
  target: QuickDiscoveryTarget,
  payload: BrandConstitutionPayload,
): Promise<void> {
  const text = (value: string) => (value.trim() ? value.trim() : undefined);
  const list = (value: string[]) => (value.length > 0 ? value : undefined);
  const wanted = {
    summary: text(payload.identity),
    positioning: text(payload.positioning),
    toneOfVoice: text(payload.toneOfVoice),
    targetAudiences: list(payload.audiences),
    markets: list(payload.markets),
    products: list(payload.products),
    language: target.language,
    country: target.country,
  };

  const existing = await prisma.brandDossier.findUnique({
    where: { brandId: scope.brandId },
  });
  if (!existing) {
    await prisma.brandDossier.create({
      data: { ...scope, ...stripUndefined(wanted) },
    });
    return;
  }

  const empty = (value: unknown) =>
    value === null ||
    value === undefined ||
    (typeof value === "string" && !value.trim()) ||
    (Array.isArray(value) && value.length === 0);
  const fill = Object.fromEntries(
    Object.entries(stripUndefined(wanted)).filter(([key]) =>
      empty(existing[key as keyof typeof existing]),
    ),
  );
  if (Object.keys(fill).length > 0) {
    await prisma.brandDossier.update({
      where: { brandId: scope.brandId },
      data: fill,
    });
  }
}

function stripUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
}
