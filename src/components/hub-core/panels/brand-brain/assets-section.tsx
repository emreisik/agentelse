import Link from "next/link";
import {
  Ban,
  BadgeCheck,
  Check,
  Globe2,
  ImagePlus,
  Lightbulb,
  Megaphone,
  Palette,
  Quote,
  ScrollText,
  Type as FontIcon,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { parseColorSwatches, parseFontNames } from "@/lib/color-swatches";
import {
  ASSET_READINESS_LABEL,
  assetReadiness,
  parseAssetItems,
} from "@/lib/brand-assets";
import { BrandDossierEditSheet } from "@/components/brand/brand-dossier-edit-sheet";
import { BrandDossierSuggestButton } from "@/components/brand/brand-dossier-suggest-button";
import { BrandLogoSlots } from "@/components/brand/brand-logo-card";
import { CopyableSwatch } from "@/components/brand/copyable-swatch";
import { FontSpecimen } from "@/components/brand/font-specimen";
import { suggestBrandDossierAction } from "@/server/actions/brand-dossier-actions";
import { updateBrandDossierAction } from "@/server/actions/project-actions";
import { isGuidedSetupEnabled } from "@/server/guided-setup/flag";
import { buildHubHref } from "../../hub-core-params";
import { JsonViewer } from "../../primitives/json-viewer";

export type BrandKnowledgeCounts = {
  negativeRules: number;
  claims: number;
  facts: number;
  assumptions: number;
};

// Rules & Knowledge group anchors — the Assets tiles deep-link to them.
export const KNOWLEDGE_GROUP_ID = {
  negativeRules: "never-do",
  claims: "approved-claims",
  facts: "brand-facts",
  assumptions: "assumptions",
} as const;

function hasContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

// The Assets tab: the brand's protected core identity, laid out as five
// plain blocks in the order a person reads a brand — what it looks like
// (logo, colors, fonts), how it speaks (positioning, tone), who it is for
// (audience, markets, products, services) and the rules it keeps. A checklist
// on top says what is still missing. Everything here is editable through the
// "Edit details" sheet, the logo slots, or the Visual Identity tab.
export async function AssetsSection({
  projectId,
  brandId,
  knowledge,
}: {
  projectId: string;
  brandId: string;
  knowledge: BrandKnowledgeCounts;
}) {
  const dossier = await prisma.brandDossier.findUnique({ where: { brandId } });
  // The fields an AI suggestion filled (see brand/dossier-suggest.ts): the
  // note stays until a person edits the dossier afterwards.
  const suggestionsOn = isGuidedSetupEnabled();
  const aiNote = suggestionsOn ? await aiSuggestedFieldsOf(brandId) : null;

  const colors = parseColorSwatches(dossier?.approvedColors);
  const fonts = parseFontNames(dossier?.approvedFonts);
  // If colors/fonts arrive in a shape that doesn't fit a list (free text or an
  // unexpected object), the raw data stays visible as a JsonViewer — nothing
  // goes missing.
  const colorsUnparsed =
    hasContent(dossier?.approvedColors) && colors.length === 0;
  const fontsUnparsed =
    hasContent(dossier?.approvedFonts) && fonts.length === 0;

  const audiences = parseAssetItems(dossier?.targetAudiences);

  const readiness = assetReadiness({
    hasLogo: !!(dossier?.logoAssetId || dossier?.darkLogoAssetId),
    positioning: dossier?.positioning,
    toneOfVoice: dossier?.toneOfVoice,
    colorCount: colors.length,
    fontCount: fonts.length,
    audienceCount:
      audiences?.length ?? (hasContent(dossier?.targetAudiences) ? 1 : 0),
  });
  const doneCount = readiness.filter((item) => item.done).length;

  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-xl">
          <h2 className="font-heading text-lg font-semibold tracking-tight">
            Assets
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            What the agency knows about your brand&apos;s identity. Every post,
            image and caption it makes starts from this page.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {suggestionsOn ? (
            <BrandDossierSuggestButton
              projectId={projectId}
              action={suggestBrandDossierAction}
            />
          ) : null}
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
        </div>
      </header>

      {aiNote ? (
        <p className="-mt-6 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          AI-suggested: {aiNote}. These are starting points, not verified facts.
          Review and edit them.
        </p>
      ) : null}

      <section
        aria-label="Brand basics checklist"
        className="rounded-xl bg-card p-4 ring-1 ring-foreground/10"
      >
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium">Brand basics</p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {doneCount} of {readiness.length} ready
          </p>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-foreground transition-[width]"
            style={{ width: `${(doneCount / readiness.length) * 100}%` }}
          />
        </div>
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {readiness.map((item) => (
            <li
              key={item.key}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs",
                item.done
                  ? "bg-foreground/[0.06] text-foreground"
                  : "text-muted-foreground ring-1 ring-foreground/15 ring-dashed",
              )}
            >
              {item.done ? (
                <Check className="size-3 text-success" aria-hidden />
              ) : (
                <span
                  className="size-3 rounded-full ring-1 ring-foreground/25"
                  aria-hidden
                />
              )}
              {ASSET_READINESS_LABEL[item.key]}
              <span className="sr-only">{item.done ? "ready" : "missing"}</span>
            </li>
          ))}
        </ul>
      </section>

      <AssetBlock
        icon={ImagePlus}
        title="Logo"
        description="Add both versions. Creatives automatically use the one that reads clearly on the background."
      >
        <BrandLogoSlots
          projectId={projectId}
          lightAssetId={dossier?.logoAssetId ?? null}
          darkAssetId={dossier?.darkLogoAssetId ?? null}
        />
      </AssetBlock>

      <AssetBlock
        icon={Palette}
        title="Colors & fonts"
        description="The approved palette and typefaces. Click a color to copy its code."
        action={
          <Link
            href={buildHubHref(projectId, {
              panel: "brand-brain",
              sub: "visual-identity",
              entity: null,
            })}
            scroll={false}
            className="text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            Fine-tune in Visual Identity
          </Link>
        }
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-2">
            <SubLabel icon={Palette}>Colors</SubLabel>
            {colors.length > 0 ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {colors.map((color, index) => (
                  <CopyableSwatch
                    key={`${color.hex}-${index}`}
                    hex={color.hex}
                    name={color.name}
                    size="lg"
                  />
                ))}
              </div>
            ) : colorsUnparsed ? (
              <JsonViewer
                label="Approved colors (raw)"
                value={dossier?.approvedColors}
              />
            ) : (
              <NotSet>No approved colors yet.</NotSet>
            )}
          </div>

          <div className="space-y-2">
            <SubLabel icon={FontIcon}>Fonts</SubLabel>
            {fonts.length > 0 ? (
              <div className="space-y-2">
                {fonts.map((font, index) => (
                  <FontSpecimen
                    key={`${font}-${index}`}
                    name={font}
                    index={index}
                  />
                ))}
              </div>
            ) : fontsUnparsed ? (
              <JsonViewer
                label="Approved fonts (raw)"
                value={dossier?.approvedFonts}
              />
            ) : (
              <NotSet>No approved fonts yet.</NotSet>
            )}
          </div>
        </div>
      </AssetBlock>

      <AssetBlock
        icon={Megaphone}
        title="Voice"
        description="How the brand introduces itself and how it sounds."
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="rounded-xl bg-card p-5 ring-1 ring-foreground/10">
            <SubLabel icon={Quote}>Positioning</SubLabel>
            {dossier?.positioning ? (
              <p className="mt-2 text-balance text-base leading-relaxed font-medium">
                {dossier.positioning}
              </p>
            ) : (
              <NotSet className="mt-2">
                {dossier
                  ? "No positioning statement yet."
                  : "The brand dossier hasn't been created yet."}
              </NotSet>
            )}
            {dossier?.summary ? (
              <p className="mt-3 border-t border-border pt-3 text-sm text-muted-foreground">
                {dossier.summary}
              </p>
            ) : null}
          </div>
          <div className="rounded-xl bg-card p-5 ring-1 ring-foreground/10">
            <SubLabel icon={ScrollText}>Tone of voice</SubLabel>
            {dossier?.toneOfVoice ? (
              <p className="mt-2 text-sm leading-relaxed">
                {dossier.toneOfVoice}
              </p>
            ) : (
              <NotSet className="mt-2">No tone of voice yet.</NotSet>
            )}
            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-border pt-3 text-xs">
              <MetaItem label="Language" value={dossier?.language} />
              <MetaItem label="Country" value={dossier?.country} />
            </dl>
          </div>
        </div>
      </AssetBlock>

      <AssetBlock
        icon={Users}
        title="Audience & offer"
        description="Who the brand talks to, where, and what it sells."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <ListCard
            icon={Users}
            title="Target audiences"
            value={dossier?.targetAudiences}
            empty="No audiences yet."
          />
          <ListCard
            icon={Globe2}
            title="Markets"
            value={dossier?.markets}
            empty="No markets yet."
          />
          <ListCard
            icon={BadgeCheck}
            title="Products"
            value={dossier?.products}
            empty="No products yet."
          />
          <ListCard
            icon={Lightbulb}
            title="Services"
            value={dossier?.services}
            empty="No services yet."
          />
        </div>
        {hasContent(dossier?.visualGuidelines) ? (
          <div className="mt-3">
            <ListCard
              icon={Palette}
              title="Visual guidelines"
              value={dossier?.visualGuidelines}
              empty=""
            />
          </div>
        ) : null}
      </AssetBlock>

      <AssetBlock
        icon={Ban}
        title="Rules & knowledge"
        description="Hard limits and facts the agency must respect on every output."
        action={
          <Link
            href={buildHubHref(projectId, {
              panel: "brand-brain",
              sub: "rules",
              entity: null,
            })}
            scroll={false}
            className="text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            Open all rules
          </Link>
        }
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KnowledgeTile
            projectId={projectId}
            group="negativeRules"
            label="Never-do rules"
            value={knowledge.negativeRules}
          />
          <KnowledgeTile
            projectId={projectId}
            group="claims"
            label="Approved claims"
            value={knowledge.claims}
          />
          <KnowledgeTile
            projectId={projectId}
            group="facts"
            label="Brand facts"
            value={knowledge.facts}
          />
          <KnowledgeTile
            projectId={projectId}
            group="assumptions"
            label="Assumptions"
            value={knowledge.assumptions}
          />
        </div>
      </AssetBlock>
    </div>
  );
}

function AssetBlock({
  icon: Icon,
  title,
  description,
  action,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
            <Icon className="size-4" />
          </span>
          <div>
            <h3 className="font-heading text-base font-semibold tracking-tight">
              {title}
            </h3>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function SubLabel({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <p className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
      <Icon className="size-3.5" aria-hidden />
      {children}
    </p>
  );
}

function NotSet({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground",
        className,
      )}
    >
      {children}
    </p>
  );
}

function MetaItem({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value?.trim() ? value : "—"}</dd>
    </div>
  );
}

// A Json dossier field as a readable list. A shape the parser cannot read
// keeps the raw JSON visible rather than losing it.
function ListCard({
  icon,
  title,
  value,
  empty,
}: {
  icon: LucideIcon;
  title: string;
  value: unknown;
  empty: string;
}) {
  const items = parseAssetItems(value);
  return (
    <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <SubLabel icon={icon}>{title}</SubLabel>
      <div className="mt-2.5">
        {items === null ? (
          <JsonViewer label={`${title} (raw)`} value={value} />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="space-y-1.5">
            {items.map((item, index) => (
              <li key={`${item.title}-${index}`} className="text-sm">
                <span className="font-medium">{item.title}</span>
                {item.detail ? (
                  <span className="text-muted-foreground">
                    {" "}
                    — {item.detail}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function KnowledgeTile({
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
      className="group rounded-xl bg-card p-4 ring-1 ring-foreground/10 transition-colors hover:bg-accent/50"
    >
      <p className="font-heading text-2xl font-semibold tabular-nums">
        {value}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground group-hover:text-foreground">
        {label}
      </p>
    </Link>
  );
}

const DOSSIER_FIELD_LABEL: Record<string, string> = {
  summary: "Summary",
  positioning: "Positioning",
  services: "Services",
  products: "Products",
  markets: "Markets",
  visualGuidelines: "Visual guidelines",
};

// The labels of the fields the latest AI suggestion filled, or null when there
// was none or a person edited the dossier after it.
async function aiSuggestedFieldsOf(brandId: string): Promise<string | null> {
  const [filled, edited] = await Promise.all([
    prisma.auditLog.findFirst({
      where: { brandId, action: "brand_dossier.autofilled" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, metadata: true },
    }),
    prisma.auditLog.findFirst({
      where: { brandId, action: "brand_dossier.updated" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);
  if (!filled || (edited && edited.createdAt > filled.createdAt)) return null;
  const fields = (filled.metadata as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields)) return null;
  const labels = fields
    .filter((field): field is string => typeof field === "string")
    .map((field) => DOSSIER_FIELD_LABEL[field])
    .filter((label): label is string => Boolean(label));
  return labels.length > 0 ? labels.join(", ") : null;
}
