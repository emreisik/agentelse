import Link from "next/link";
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  FileSearch,
  Gavel,
  Gem,
  GitBranch,
  GraduationCap,
  Palette,
  ShieldCheck,
  Type as FontIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ActorType, EvidenceSourceType } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/dates";
import {
  CONSTITUTION_SECTIONS,
  CONSTITUTION_STATUS,
  FACT_CLASSIFICATION,
} from "@/lib/labels";
import { BrandDossierEditSheet } from "@/components/brand/brand-dossier-edit-sheet";
import { BrandLogoCard } from "@/components/brand/brand-logo-card";
import { VisualIdentitySection } from "@/components/brand/visual-identity-section";
import { EmptyState } from "@/components/shared/empty-state";
import { ScoreBar } from "@/components/shared/score-bar";
import { StatusBadge } from "@/components/shared/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { updateBrandDossierAction } from "@/server/actions/project-actions";
import {
  BRAND_BRAIN_SUB_KEYS,
  buildHubHref,
  entityHref,
  type BrandBrainSubKey,
} from "../hub-core-params";
import { parseColorSwatches, parseFontNames } from "@/lib/color-swatches";
import { AssetPreview } from "../primitives/asset-preview";
import { CrossLinkChip } from "../primitives/cross-link-chip";
import { FieldGrid, type FieldSpec } from "../primitives/field-grid";
import { JsonViewer } from "../primitives/json-viewer";
import type { PanelProps } from "./panel-props";

const ACTOR_TYPE_LABEL: Record<ActorType, string> = {
  USER: "User",
  SYSTEM: "System",
  AI: "AI",
  OPENCLAW: "OpenClaw",
  API: "API",
  PARTNER: "Partner",
};

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

const BRAND_BRAIN_TAB_LABEL: Record<BrandBrainSubKey, string> = {
  assets: "Assets",
  rules: "Rules & Knowledge",
  "visual-identity": "Visual Identity",
  constitution: "Constitution",
  strategy: "Strategy",
  decisions: "Decisions",
  evidence: "Evidence",
  learnings: "Learnings",
};

const BRAND_BRAIN_TAB_ICON: Record<BrandBrainSubKey, LucideIcon> = {
  assets: Gem,
  rules: ShieldCheck,
  "visual-identity": Palette,
  constitution: BookOpen,
  strategy: GitBranch,
  decisions: Gavel,
  evidence: FileSearch,
  learnings: GraduationCap,
};

function isBrandBrainSub(value: string | null): value is BrandBrainSubKey {
  return !!value && (BRAND_BRAIN_SUB_KEYS as readonly string[]).includes(value);
}

// The "Brand Brain" node — the codified/reference output layer: constitution,
// brand assets, strategy versions, decisions, evidence, learnings
// (the HUB CORE-migrated + expanded version of brand-brain-tab.tsx). Purely
// read-only/dashboard — editing goes through BrandDossierEditSheet and the
// Visual Identity forms, not a chat (the chat-based revision flow was
// removed). `constitution` is the only type in ENTITY_PANEL that belongs to
// this panel — entity depth only kicks in for that type.
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

  const activeSub: BrandBrainSubKey = isBrandBrainSub(sub) ? sub : "assets";

  const [
    constitutionCount,
    strategyCount,
    decisionCount,
    evidenceCount,
    learningCount,
    knowledge,
  ] = await Promise.all([
    prisma.brandConstitution.count({ where: { brandId } }),
    prisma.brandStrategyVersion.count({ where: { brandId } }),
    prisma.brandDecision.count({ where: { brandId } }),
    prisma.brandEvidence.count({ where: { brandId } }),
    prisma.brandLearning.count({ where: { projectId } }),
    countBrandKnowledge(brandId),
  ]);

  const tabCount: Partial<Record<BrandBrainSubKey, number>> = {
    rules:
      knowledge.negativeRules +
      knowledge.claims +
      knowledge.facts +
      knowledge.assumptions,
    constitution: constitutionCount,
    strategy: strategyCount,
    decisions: decisionCount,
    evidence: evidenceCount,
    learnings: learningCount,
  };

  return (
    <div className="space-y-6 py-6">
      <div className="flex flex-wrap items-center gap-1 border-b border-border">
        {BRAND_BRAIN_SUB_KEYS.map((key) => {
          const isActive = key === activeSub;
          const Icon = BRAND_BRAIN_TAB_ICON[key];
          const count = tabCount[key];
          return (
            <Link
              key={key}
              href={buildHubHref(projectId, {
                panel: "brand-brain",
                sub: key,
                entity: null,
              })}
              scroll={false}
              className={cn(
                "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
                isActive
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" />
              {BRAND_BRAIN_TAB_LABEL[key]}
              {count !== undefined ? (
                <span
                  className={cn(
                    "flex h-4 min-w-4 items-center justify-center rounded-4xl px-1 text-[10px] font-medium tabular-nums",
                    isActive
                      ? "bg-primary/15 text-primary"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {count}
                </span>
              ) : null}
            </Link>
          );
        })}
      </div>

      {activeSub === "visual-identity" ? (
        <VisualIdentitySection projectId={projectId} brandId={brandId} />
      ) : activeSub === "constitution" ? (
        <ConstitutionSection
          projectId={projectId}
          brandId={brandId}
          focusedId={null}
        />
      ) : activeSub === "strategy" ? (
        <StrategyVersionsSection brandId={brandId} />
      ) : activeSub === "decisions" ? (
        <DecisionsSection brandId={brandId} />
      ) : activeSub === "evidence" ? (
        <EvidenceSection brandId={brandId} />
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
        hint="The brand constitution is synthesized from research findings during stage 3 of setup."
      >
        <Link
          href={buildHubHref(projectId, {
            panel: "setup",
            entity: null,
          })}
          scroll={false}
          className="text-xs text-primary underline-offset-2 hover:underline"
        >
          Go to setup →
        </Link>
      </EmptyState>
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

type BrandKnowledgeCounts = {
  negativeRules: number;
  claims: number;
  facts: number;
  assumptions: number;
};

// Counts only — the lists themselves live on the Rules & Knowledge tab so
// they don't stretch the Assets overview. Same filters RulesSection uses.
async function countBrandKnowledge(
  brandId: string,
): Promise<BrandKnowledgeCounts> {
  const [negativeRules, claims, facts, assumptions] = await Promise.all([
    prisma.negativeBriefRule.count({ where: { brandId, active: true } }),
    prisma.approvedClaim.count({ where: { brandId, active: true } }),
    prisma.brandFact.count({ where: { brandId } }),
    prisma.brandAssumption.count({ where: { brandId } }),
  ]);
  return { negativeRules, claims, facts, assumptions };
}

// Rules & Knowledge group anchors — the Assets chips deep-link to them.
const KNOWLEDGE_GROUP_ID = {
  negativeRules: "never-do",
  claims: "approved-claims",
  facts: "brand-facts",
  assumptions: "assumptions",
} as const;

function KnowledgeChip({
  projectId,
  group,
  label,
  value,
}: {
  projectId: string;
  group: keyof typeof KNOWLEDGE_GROUP_ID;
  label: string;
  value: number;
}) {
  return (
    <Link
      href={`${buildHubHref(projectId, {
        panel: "brand-brain",
        sub: "rules",
        entity: null,
      })}#${KNOWLEDGE_GROUP_ID[group]}`}
      className="inline-flex items-center gap-1.5 rounded-full bg-background/70 px-2.5 py-1 text-xs ring-1 ring-foreground/10 transition-colors hover:bg-background"
    >
      <span className="font-semibold tabular-nums">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </Link>
  );
}

async function AssetsSection({
  projectId,
  brandId,
  knowledge,
}: {
  projectId: string;
  brandId: string;
  knowledge: BrandKnowledgeCounts;
}) {
  const dossier = await prisma.brandDossier.findUnique({ where: { brandId } });

  let strategyVersionLabel: string | null = null;
  if (dossier?.currentStrategyVersionId) {
    const version = await prisma.brandStrategyVersion.findUnique({
      where: { id: dossier.currentStrategyVersionId },
      select: { version: true },
    });
    strategyVersionLabel = version
      ? `v${version.version}`
      : dossier.currentStrategyVersionId;
  }

  const colors = parseColorSwatches(dossier?.approvedColors);
  const fonts = parseFontNames(dossier?.approvedFonts);
  // If colors/fonts arrive in a shape that doesn't fit a list (e.g. free
  // text or an unexpected object shape), the raw data stays below the
  // swatch list as a JsonViewer — the "don't let data go missing" principle.
  const colorsUnparsed =
    hasContent(dossier?.approvedColors) && colors.length === 0;
  const fontsUnparsed =
    hasContent(dossier?.approvedFonts) && fonts.length === 0;

  const dossierFields: FieldSpec[] = dossier
    ? [
        { type: "text", label: "Summary", value: dossier.summary },
        { type: "text", label: "Language", value: dossier.language },
        { type: "text", label: "Country", value: dossier.country },
        {
          type: "text",
          label: "Current Strategy",
          value: strategyVersionLabel,
        },
        {
          type: "json",
          label: "Target Audiences",
          value: dossier.targetAudiences,
        },
        { type: "json", label: "Markets", value: dossier.markets },
        { type: "json", label: "Products", value: dossier.products },
        { type: "json", label: "Services", value: dossier.services },
        {
          type: "json",
          label: "Visual Guidelines",
          value: dossier.visualGuidelines,
        },
        {
          type: "date",
          label: "Updated",
          value: dossier.updatedAt,
          relative: true,
        },
      ]
    : [];

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background">
          <Gem className="size-4" />
        </span>
        <div>
          <p className="font-heading text-base font-semibold tracking-tight text-foreground">
            Assets
          </p>
          <p className="text-xs text-muted-foreground">
            The brand&apos;s protected core identity — logo, positioning, tone
            of voice, approved colors and fonts
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl ring-1 ring-foreground/10">
        <div className="grid gap-5 bg-gradient-to-b from-accent/50 via-accent/15 to-transparent p-5 sm:grid-cols-[minmax(0,15rem)_1fr] sm:p-6">
          <BrandLogoCard projectId={projectId} brandId={brandId} />

          <div className="min-w-0 space-y-4">
            {dossier?.positioning ? (
              <blockquote className="border-l-2 border-foreground/20 pl-4">
                <p className="text-balance text-base leading-relaxed font-medium text-foreground">
                  “{dossier.positioning}”
                </p>
              </blockquote>
            ) : !dossier ? (
              <p className="text-sm text-muted-foreground">
                Brand dossier hasn&apos;t been created yet.
              </p>
            ) : null}

            {dossier?.toneOfVoice ? (
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">
                  Tone of Voice:{" "}
                </span>
                {dossier.toneOfVoice}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-1.5">
              <KnowledgeChip
                projectId={projectId}
                group="negativeRules"
                label="never-do rules"
                value={knowledge.negativeRules}
              />
              <KnowledgeChip
                projectId={projectId}
                group="claims"
                label="approved claims"
                value={knowledge.claims}
              />
              <KnowledgeChip
                projectId={projectId}
                group="facts"
                label="brand facts"
                value={knowledge.facts}
              />
              <KnowledgeChip
                projectId={projectId}
                group="assumptions"
                label="assumptions"
                value={knowledge.assumptions}
              />
            </div>
          </div>
        </div>

        {colors.length > 0 || fonts.length > 0 ? (
          <div className="grid gap-5 border-t border-foreground/10 bg-card p-5 sm:grid-cols-2 sm:p-6">
            {colors.length > 0 ? (
              <div className="space-y-2">
                <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  <Palette className="size-3.5" />
                  Approved Colors
                </p>
                <div className="flex flex-wrap gap-3">
                  {colors.map((color, index) => (
                    <div
                      key={`${color.hex}-${index}`}
                      className="flex flex-col items-center gap-1.5"
                    >
                      <span
                        className="size-9 rounded-full shadow-sm ring-1 ring-foreground/15"
                        style={{ backgroundColor: color.hex }}
                        title={color.name ?? color.hex}
                      />
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {color.name ?? color.hex}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {fonts.length > 0 ? (
              <div className="space-y-2">
                <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  <FontIcon className="size-3.5" />
                  Approved Fonts
                </p>
                <div className="flex flex-wrap gap-2">
                  {fonts.map((font, index) => (
                    <span
                      key={`${font}-${index}`}
                      className="rounded-lg bg-muted px-3 py-1.5 text-sm text-foreground"
                    >
                      <span className="mr-2 text-muted-foreground">Aa</span>
                      {font}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {colorsUnparsed || fontsUnparsed ? (
          <div className="grid gap-3 border-t border-foreground/10 bg-card p-5 sm:grid-cols-2 sm:p-6">
            {colorsUnparsed ? (
              <JsonViewer
                label="Approved Colors (raw)"
                value={dossier?.approvedColors}
              />
            ) : null}
            {fontsUnparsed ? (
              <JsonViewer
                label="Approved Fonts (raw)"
                value={dossier?.approvedFonts}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">Brand Dossier</CardTitle>
          <BrandDossierEditSheet
            projectId={projectId}
            dossier={{
              summary: dossier?.summary ?? null,
              positioning: dossier?.positioning ?? null,
              toneOfVoice: dossier?.toneOfVoice ?? null,
              language: dossier?.language ?? null,
              country: dossier?.country ?? null,
              targetAudiences: dossier?.targetAudiences ?? null,
              markets: dossier?.markets ?? null,
              products: dossier?.products ?? null,
              services: dossier?.services ?? null,
              visualGuidelines: dossier?.visualGuidelines ?? null,
            }}
            action={updateBrandDossierAction}
          />
        </CardHeader>
        <CardContent>
          {dossier ? (
            <FieldGrid fields={dossierFields} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Brand dossier hasn&apos;t been created yet.
            </p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------

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
      where: { brandId },
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
      <p className="text-sm text-muted-foreground">No strategy versions.</p>
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

async function DecisionsSection({ brandId }: { brandId: string }) {
  const decisions = await prisma.brandDecision.findMany({
    where: { brandId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  if (decisions.length === 0) {
    return <p className="text-sm text-muted-foreground">No brand decisions.</p>;
  }

  return (
    <Card>
      <CardContent className="divide-y divide-border/40">
        {decisions.map((decision) => (
          <div
            key={decision.id}
            className="space-y-1 py-2.5 first:pt-0 last:pb-0"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">{decision.topic}</span>
              <StatusBadge
                meta={{
                  label: ACTOR_TYPE_LABEL[decision.decidedByType],
                  tone: "neutral",
                }}
                className="h-4 px-1.5 text-[10px]"
              />
            </div>
            <p className="text-sm">{decision.decision}</p>
            {decision.rationale ? (
              <p className="text-xs text-muted-foreground">
                {decision.rationale}
              </p>
            ) : null}
            <p className="text-[11px] text-muted-foreground">
              {timeAgo(decision.createdAt)}
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

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
    return <p className="text-sm text-muted-foreground">No evidence.</p>;
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
        title="No learnings"
        hint="As measurement results from completed work are analyzed, brand learnings accumulate here and feed into the context of subsequent work."
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
