import Link from "next/link";
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  GraduationCap,
  ShieldCheck,
} from "lucide-react";
import type { EvidenceSourceType } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/dates";
import {
  CONSTITUTION_SECTIONS,
  CONSTITUTION_STATUS,
  FACT_CLASSIFICATION,
} from "@/lib/labels";
import { BrandKitSection } from "@/components/brand/brand-kit-section";
import { PostStyleSection } from "@/components/brand/post-style-section";
import { VisualIdentitySection } from "@/components/brand/visual-identity-section";
import { EmptyState } from "@/components/shared/empty-state";
import { ScoreBar } from "@/components/shared/score-bar";
import { StatusBadge } from "@/components/shared/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  BRAND_BRAIN_SUB_KEYS,
  ENTITY_SUB,
  buildHubHref,
  entityHref,
  type BrandBrainSubKey,
} from "../hub-core-params";
import { POST_STYLE_CATEGORY } from "@/lib/post-style";
import { AssetPreview } from "../primitives/asset-preview";
import { CrossLinkChip } from "../primitives/cross-link-chip";
import { FieldGrid } from "../primitives/field-grid";
import {
  AssetsSection,
  KNOWLEDGE_GROUP_ID,
  type BrandKnowledgeCounts,
} from "./brand-brain/assets-section";
import { BrandBrainNav } from "./brand-brain/brand-brain-nav";
import { GoalsSection } from "./brand-brain/goals-section";
import { MediaSection } from "./brand-brain/media-section";
import { IntelligenceSection } from "./brand-brain/intelligence-section";
import type { PanelProps } from "./panel-props";

const EVIDENCE_SOURCE_LABEL: Record<EvidenceSourceType, string> = {
  WEB_PAGE: "Web Page",
  SCREENSHOT: "Screenshot",
  API: "API",
  DOCUMENT: "Document",
  SOCIAL_MEDIA: "Social Media",
  AD_LIBRARY: "Ad Library",
  SEARCH_RESULT: "Search Result",
  USER_INPUT: "User Input",
  INTERNAL_DATA: "Internal Data",
  SYSTEM_VERIFICATION: "System Verification",
};

function isBrandBrainSub(value: string | null): value is BrandBrainSubKey {
  return !!value && (BRAND_BRAIN_SUB_KEYS as readonly string[]).includes(value);
}

// The "Brand Brain" node — everything the agency knows about the brand, in one
// place: the constitution (with its strategy versions and sources) and brand
// assets, the goals it works toward (Goals tab), what it has gathered about the
// market (Intelligence tab: findings, insights, opportunities, signals) and
// the chat's brand memory. Editing goes through BrandDossierEditSheet, the
// Visual Identity forms and the Goals tab's own approve/edit actions.
// Records opened by a cross-link (ENTITY_PANEL / ENTITY_SUB) pick their tab;
// a constitution opens its own detail view.
export async function BrandBrainPanel({ projectId, entity, sub }: PanelProps) {
  const brand = await prisma.brand.findFirst({
    where: { projectId, isDefault: true },
    select: { id: true },
  });

  if (!brand) {
    return (
      <div className="py-8">
        <EmptyState
          icon={BookOpen}
          title="Brand not found"
          hint="This project doesn't have a default brand yet."
        />
      </div>
    );
  }

  const brandId = brand.id;
  const focusedConstitutionId =
    entity && entity.kind === "constitution" ? entity.id : null;

  if (focusedConstitutionId) {
    return (
      <div className="space-y-4 py-6">
        <Link
          href={buildHubHref(projectId, {
            panel: "brand-brain",
            sub: "constitution",
            entity: null,
          })}
          scroll={false}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to list
        </Link>
        <ConstitutionSection
          projectId={projectId}
          brandId={brandId}
          focusedId={focusedConstitutionId}
        />
      </div>
    );
  }

  // A record opened by a cross-link decides its tab; otherwise `sub` does.
  const entitySub = entity ? ENTITY_SUB[entity.kind] : undefined;
  const activeSub: BrandBrainSubKey =
    entitySub ?? (isBrandBrainSub(sub) ? sub : "assets");

  const [
    constitutionCount,
    learningCount,
    knowledge,
    proposedGoalCount,
    findingCount,
    insightCount,
    opportunityCount,
    mediaCount,
  ] = await Promise.all([
    prisma.brandConstitution.count({ where: { brandId } }),
    prisma.brandLearning.count({ where: { projectId } }),
    countBrandKnowledge(brandId),
    prisma.projectGoal.count({ where: { projectId, status: "PROPOSED" } }),
    prisma.finding.count({ where: { projectId } }),
    prisma.insight.count({ where: { projectId } }),
    prisma.opportunity.count({ where: { projectId } }),
    prisma.brandMedia.count({ where: { projectId, archivedAt: null } }),
  ]);

  const tabCount: Partial<Record<BrandBrainSubKey, number>> = {
    rules:
      knowledge.negativeRules +
      knowledge.claims +
      knowledge.facts +
      knowledge.assumptions,
    constitution: constitutionCount,
    // Only the goals waiting for the client's decision: the tab says "needs you".
    goals: proposedGoalCount > 0 ? proposedGoalCount : undefined,
    intelligence: findingCount + insightCount + opportunityCount,
    learnings: learningCount,
    media: mediaCount > 0 ? mediaCount : undefined,
  };

  return (
    <div className="grid gap-6 py-6 md:grid-cols-[13.5rem_minmax(0,1fr)] md:gap-10">
      <BrandBrainNav
        projectId={projectId}
        active={activeSub}
        counts={tabCount}
      />

      <div className="min-w-0">
        {activeSub === "media" ? (
          <MediaSection projectId={projectId} />
        ) : activeSub === "visual-identity" ? (
          <div className="space-y-5">
            <BrandKitSection
              projectId={projectId}
              brandId={brandId}
              afterScan={
                <VisualIdentitySection
                  projectId={projectId}
                  brandId={brandId}
                />
              }
            />
            <PostStyleSection projectId={projectId} brandId={brandId} />
          </div>
        ) : activeSub === "constitution" ? (
          <div className="space-y-8">
            <ConstitutionSection
              projectId={projectId}
              brandId={brandId}
              focusedId={null}
            />
            <SubSection title="Strategy versions">
              <StrategyVersionsSection brandId={brandId} />
            </SubSection>
            <SubSection title="Sources">
              <EvidenceSection brandId={brandId} />
            </SubSection>
          </div>
        ) : activeSub === "goals" ? (
          <GoalsSection projectId={projectId} entity={entity} />
        ) : activeSub === "intelligence" ? (
          <IntelligenceSection projectId={projectId} entity={entity} />
        ) : activeSub === "learnings" ? (
          <LearningsSection projectId={projectId} />
        ) : activeSub === "rules" ? (
          <RulesSection brandId={brandId} knowledge={knowledge} />
        ) : (
          <AssetsSection
            projectId={projectId}
            brandId={brandId}
            knowledge={knowledge}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

async function ConstitutionSection({
  projectId,
  brandId,
  focusedId,
}: {
  projectId: string;
  brandId: string;
  focusedId: string | null;
}) {
  const versions = await prisma.brandConstitution.findMany({
    where: { brandId },
    orderBy: { version: "desc" },
    select: { id: true, version: true, status: true, createdAt: true },
  });

  if (versions.length === 0) {
    return (
      <EmptyState
        icon={BookOpen}
        title="Constitution not generated yet"
        hint="It is written from your website and the first conversation in the chat: start a chat about the brand and it appears here."
      />
    );
  }

  const selectedMeta =
    versions.find((v) => v.id === focusedId) ??
    versions.find((v) => v.status === "ACTIVE") ??
    versions[0]!;

  const constitution = await prisma.brandConstitution.findUnique({
    where: { id: selectedMeta.id },
  });
  if (!constitution) return null;

  const payload = (constitution.payload ?? {}) as Record<string, unknown>;
  const sourceFindings =
    constitution.sourceFindingIds.length > 0
      ? await prisma.finding.findMany({
          where: { id: { in: constitution.sourceFindingIds } },
          select: { id: true, statement: true },
        })
      : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {versions.map((v) => (
          <Link
            key={v.id}
            href={entityHref(
              projectId,
              { kind: "constitution", id: v.id },
              "constitution",
            )}
            scroll={false}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-4xl px-2.5 text-xs font-medium transition-colors",
              v.id === constitution.id
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-accent",
            )}
          >
            v{v.version}
          </Link>
        ))}
        <StatusBadge meta={CONSTITUTION_STATUS[constitution.status]} />
        {constitution.isMock ? (
          <StatusBadge meta={{ label: "Demo data", tone: "special" }} />
        ) : null}
      </div>

      <FieldGrid
        fields={[
          {
            type: "date",
            label: "Created",
            value: constitution.createdAt,
            relative: true,
          },
          {
            type: "date",
            label: "Updated",
            value: constitution.updatedAt,
            relative: true,
          },
          {
            type: "text",
            label: "Language",
            value: payload.language as string | undefined,
          },
          {
            type: "text",
            label: "Country",
            value: payload.country as string | undefined,
          },
        ]}
      />

      {sourceFindings.length > 0 ? (
        <details className="group/findings rounded-lg border border-border bg-secondary/40">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 select-none">
            <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
              <span className="flex h-5 min-w-5 items-center justify-center rounded-md bg-muted px-1 text-[10px] font-semibold text-muted-foreground">
                {constitution.sourceFindingIds.length}
              </span>
              Source Findings
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open/findings:rotate-180" />
          </summary>
          <div className="flex flex-wrap gap-1.5 border-t border-border px-3 py-3">
            {sourceFindings.map((finding) => (
              <CrossLinkChip
                key={finding.id}
                projectId={projectId}
                entity={{ kind: "finding", id: finding.id }}
                text={finding.statement}
              />
            ))}
          </div>
        </details>
      ) : null}

      {constitution.summary ? (
        <Card size="sm">
          <CardContent>
            <p className="text-sm">{constitution.summary}</p>
          </CardContent>
        </Card>
      ) : null}

      <div className="space-y-3">
        {CONSTITUTION_SECTIONS.filter((s) => hasContent(payload[s.key])).map(
          (section) => (
            <Card key={section.key} size="sm">
              <CardHeader>
                <CardTitle className="text-sm">{section.label}</CardTitle>
              </CardHeader>
              <CardContent>
                <SectionValue value={payload[section.key]} />
              </CardContent>
            </Card>
          ),
        )}
      </div>
    </div>
  );
}

function hasContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function SectionValue({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return <p className="text-sm leading-relaxed">{value}</p>;
  }
  if (Array.isArray(value)) {
    return (
      <ul className="space-y-1 text-sm">
        {value.map((item, i) => (
          <li key={i} className="flex gap-2">
            <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50" />
            <span className="min-w-0">
              {typeof item === "string" ? item : JSON.stringify(item)}
            </span>
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === "object" && value !== null) {
    return (
      <div className="space-y-1">
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <div
            key={k}
            className="flex items-start justify-between gap-4 text-sm"
          >
            <span className="text-xs text-muted-foreground">{k}</span>
            <span className="text-right">
              {typeof v === "string" ? v : JSON.stringify(v)}
            </span>
          </div>
        ))}
      </div>
    );
  }
  return <p className="text-sm">{String(value)}</p>;
}

// ---------------------------------------------------------------------------

// Counts only — the lists themselves live on the Rules & Knowledge tab so
// they don't stretch the Assets overview. Same filters RulesSection uses.
async function countBrandKnowledge(
  brandId: string,
): Promise<BrandKnowledgeCounts> {
  const [negativeRules, claims, facts, assumptions] = await Promise.all([
    prisma.negativeBriefRule.count({ where: { brandId, active: true } }),
    prisma.approvedClaim.count({ where: { brandId, active: true } }),
    prisma.brandFact.count({
      where: { brandId, category: { not: POST_STYLE_CATEGORY } },
    }),
    prisma.brandAssumption.count({ where: { brandId } }),
  ]);
  return { negativeRules, claims, facts, assumptions };
}

const KNOWLEDGE_LIST_LIMIT = 50;

// The brand's working rules and raw knowledge, split off the Assets tab so
// the overview stays short. Never-do rules and approved claims are sent to
// the creative engine as hard constraints on every generation; facts and
// assumptions feed the constitution. Each group starts collapsed with its
// count — the Assets chips deep-link to one via its id.
async function RulesSection({
  brandId,
  knowledge,
}: {
  brandId: string;
  knowledge: BrandKnowledgeCounts;
}) {
  const [negativeRules, claims, facts, assumptions] = await Promise.all([
    prisma.negativeBriefRule.findMany({
      where: { brandId, active: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.approvedClaim.findMany({
      where: { brandId, active: true },
      orderBy: { approvedAt: "desc" },
    }),
    prisma.brandFact.findMany({
      where: { brandId, category: { not: POST_STYLE_CATEGORY } },
      take: KNOWLEDGE_LIST_LIMIT,
      orderBy: { createdAt: "desc" },
    }),
    prisma.brandAssumption.findMany({
      where: { brandId },
      take: KNOWLEDGE_LIST_LIMIT,
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background">
          <ShieldCheck className="size-4" />
        </span>
        <div>
          <p className="font-heading text-base font-semibold tracking-tight text-foreground">
            Rules & Knowledge
          </p>
          <p className="text-xs text-muted-foreground">
            What the AI works from — never-do rules and approved claims are
            enforced on every creative
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <KnowledgeGroup
          id={KNOWLEDGE_GROUP_ID.negativeRules}
          title="Never do"
          count={knowledge.negativeRules}
          empty="No rules."
        >
          <ul className="space-y-2 text-sm">
            {negativeRules.map((rule) => (
              <li key={rule.id} className="space-y-0.5">
                <div className="flex gap-2">
                  <span className="mt-1.5 size-1 shrink-0 rounded-full bg-destructive/60" />
                  <span>{rule.rule}</span>
                </div>
                <p className="pl-3 text-[11px] text-muted-foreground">
                  {rule.category ? `${rule.category} · ` : ""}
                  {timeAgo(rule.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        </KnowledgeGroup>

        <KnowledgeGroup
          id={KNOWLEDGE_GROUP_ID.claims}
          title="Approved claims"
          count={knowledge.claims}
          empty="No approved claims."
        >
          <div className="space-y-2.5">
            {claims.map((claim) => (
              <div key={claim.id} className="space-y-0.5">
                <div className="flex items-center gap-2 text-sm">
                  <StatusBadge
                    meta={{ label: "Claim", tone: "positive" }}
                    className="h-4 px-1.5 text-[10px]"
                  />
                  <span className="min-w-0">{claim.claim}</span>
                </div>
                <p className="pl-1 text-[11px] text-muted-foreground">
                  {claim.category ? `${claim.category} · ` : ""}
                  approved {timeAgo(claim.approvedAt)}
                </p>
              </div>
            ))}
          </div>
        </KnowledgeGroup>

        <KnowledgeGroup
          id={KNOWLEDGE_GROUP_ID.facts}
          title="Brand facts"
          count={knowledge.facts}
          shown={facts.length}
          empty="No facts yet."
        >
          <div className="space-y-2.5 text-sm">
            {facts.map((fact) => (
              <div
                key={fact.id}
                className="space-y-1 border-b border-border/40 pb-2 last:border-0 last:pb-0"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="text-xs text-muted-foreground">
                    {fact.category} · {fact.key}
                  </span>
                  <span className="min-w-0 text-right text-xs">
                    {typeof fact.value === "string"
                      ? fact.value
                      : JSON.stringify(fact.value)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {fact.classification ? (
                    <StatusBadge
                      meta={FACT_CLASSIFICATION[fact.classification]}
                      className="h-4 px-1.5 text-[10px]"
                    />
                  ) : null}
                  {fact.source ? (
                    <span className="text-[10px] text-muted-foreground">
                      Source: {fact.source}
                    </span>
                  ) : null}
                  {fact.confidence !== null ? (
                    <span className="text-[10px] text-muted-foreground">
                      Confidence: {Math.round(fact.confidence * 100)}%
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </KnowledgeGroup>

        <KnowledgeGroup
          id={KNOWLEDGE_GROUP_ID.assumptions}
          title="Assumptions"
          count={knowledge.assumptions}
          shown={assumptions.length}
          empty="No assumptions."
        >
          <div className="space-y-2.5">
            {assumptions.map((assumption) => (
              <div key={assumption.id} className="space-y-0.5">
                <div className="flex items-center gap-2 text-sm">
                  <StatusBadge
                    meta={{ label: assumption.status, tone: "waiting" }}
                    className="h-4 px-1.5 text-[10px]"
                  />
                  <span className="min-w-0">{assumption.statement}</span>
                </div>
                <p className="pl-1 text-[11px] text-muted-foreground">
                  {timeAgo(assumption.createdAt)}
                </p>
              </div>
            ))}
          </div>
        </KnowledgeGroup>
      </div>
    </section>
  );
}

// Same collapsed-by-default <details> look as the constitution's Source
// Findings, with the count up front so the page reads as a short index.
function KnowledgeGroup({
  id,
  title,
  count,
  shown,
  empty,
  children,
}: {
  id: string;
  title: string;
  count: number;
  shown?: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <details
      id={id}
      className="group/knowledge scroll-mt-4 rounded-lg border border-border bg-secondary/40"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 select-none">
        <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
          <span className="flex h-5 min-w-5 items-center justify-center rounded-md bg-muted px-1 text-[10px] font-semibold text-muted-foreground tabular-nums">
            {count}
          </span>
          {title}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open/knowledge:rotate-180" />
      </summary>
      <div className="border-t border-border px-3 py-3">
        {count === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          children
        )}
        {shown !== undefined && shown < count ? (
          <p className="mt-3 text-[11px] text-muted-foreground">
            Showing the latest {shown} of {count}.
          </p>
        ) : null}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------

async function StrategyVersionsSection({ brandId }: { brandId: string }) {
  const versions = await prisma.brandStrategyVersion.findMany({
    where: { brandId },
    orderBy: { version: "desc" },
    take: 20,
  });

  if (versions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No strategy versions yet.</p>
    );
  }

  return (
    <div className="space-y-2">
      {versions.map((version) => (
        <Card key={version.id} size="sm">
          <CardContent className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">v{version.version}</span>
              <span className="text-xs text-muted-foreground">
                {timeAgo(version.createdAt)}
              </span>
            </div>
            {version.summary ? (
              <p className="text-sm">{version.summary}</p>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

async function EvidenceSection({ brandId }: { brandId: string }) {
  const items = await prisma.brandEvidence.findMany({
    where: { brandId },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      evidence: {
        include: {
          asset: {
            select: { id: true, filename: true, mimeType: true, size: true },
          },
        },
      },
    },
  });

  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No sources recorded yet.</p>
    );
  }

  return (
    <Card>
      <CardContent className="divide-y divide-border/40">
        {items.map((item) => (
          <div key={item.id} className="space-y-1 py-2.5 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusBadge
                meta={{
                  label: EVIDENCE_SOURCE_LABEL[item.evidence.sourceType],
                  tone: "neutral",
                }}
                className="h-4 px-1.5 text-[10px]"
              />
              <span className="text-xs text-muted-foreground">
                {item.relatedEntityType}
              </span>
            </div>
            <AssetPreview asset={item.evidence.asset} />
            {item.evidence.statement ? (
              <p className="text-sm">{item.evidence.statement}</p>
            ) : null}
            {item.evidence.pageTitle ? (
              <p className="text-xs text-muted-foreground">
                {item.evidence.pageTitle}
              </p>
            ) : null}
            {item.evidence.sourceUrl ? (
              <a
                href={item.evidence.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="block truncate text-xs text-primary underline-offset-2 hover:underline"
              >
                {item.evidence.sourceUrl}
              </a>
            ) : null}
            <p className="text-[11px] text-muted-foreground">
              {timeAgo(item.createdAt)}
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

async function LearningsSection({ projectId }: { projectId: string }) {
  const learnings = await prisma.brandLearning.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  if (learnings.length === 0) {
    return (
      <EmptyState
        icon={GraduationCap}
        title="Nothing remembered yet"
        hint="What you decide in the chat and what the brand learns from its posts are kept here, and the chat uses them in later work."
      />
    );
  }

  return (
    <Card>
      <CardContent className="divide-y divide-border/40">
        {learnings.map((learning) => (
          <div
            key={learning.id}
            className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0"
          >
            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
              <GraduationCap className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm">{learning.insight}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {learning.sourceType ? (
                  <span>{learning.sourceType}</span>
                ) : null}
                {learning.sourceRef ? (
                  <span>Source: {learning.sourceRef}</span>
                ) : null}
                <span>{timeAgo(learning.createdAt)}</span>
              </div>
            </div>
            {learning.confidence !== null ? (
              <div className="w-20 shrink-0">
                <ScoreBar value={learning.confidence} label="confidence" />
              </div>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// A titled block inside a tab (the Constitution tab's strategy versions and
// sources).
function SubSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}
