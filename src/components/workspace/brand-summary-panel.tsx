import Link from "next/link";
import { Sparkle } from "lucide-react";

import {
  EmptyKitCard,
  LayoutSection,
  LogoTiles,
  PaletteSection,
  StyleSection,
  TypographySection,
} from "@/components/brand/brand-kit-sections";
import { BrandScanButton } from "@/components/brand/brand-scan-dialog";
import {
  BrandSummaryCard,
  CollapsibleCard,
  ConnectedAccountsCard,
  brandSummaryRows,
} from "@/components/workspace/brand-overview-cards";
import { buildHubHref } from "@/components/hub-core/hub-core-params";
import {
  allPaletteHexes,
  buildBrandKit,
  kitIsEmpty,
  type BrandKit,
} from "@/lib/brand-kit";
import type { ConnectedAccount } from "@/lib/connected-accounts";
import type { BrandTwin } from "@/server/brand-twin/brand-twin";

// The Brand tab: two cards lead (the brand at a glance, and where its accounts
// stand), then two collapsed ones for what used to fill the tab: the visual kit
// (logo on brand-coloured surfaces, role-labelled palette, type specimens, style,
// the post layout every creative gets) and the strategy text (essence, focus,
// voice, markets, what works, never-do). Nothing was taken away, only folded.
export function BrandSummaryPanel({
  projectId,
  brand,
  website,
  kit,
  connections = [],
}: {
  projectId: string;
  brand: BrandTwin | null;
  website: string | null;
  // Absent only for callers that have the twin but not the kit; a kit is then
  // derived from the twin's flat visual summary.
  kit?: BrandKit | null;
  // Where the project's accounts stand (Bağlı hesaplar), read by the page.
  connections?: ConnectedAccount[];
}) {
  if (!brand) {
    return (
      <div className="p-4 text-sm" style={{ color: "var(--ws-text-2)" }}>
        Brand not set up yet.
      </div>
    );
  }

  const brandKit =
    kit ??
    buildBrandKit({
      legacyColors: brand.visualDNA.colors,
      fonts: brand.visualDNA.fonts,
      logoAssetId: brand.visualDNA.logoAssetId,
      darkLogoAssetId: null,
      identity: null,
    });
  const empty = kitIsEmpty(brandKit);
  const hasLogo = Boolean(brandKit.logos.light || brandKit.logos.dark);

  // personality/toneOfVoice are each a single free-text field, but the AI
  // often writes them as a comma-separated list of traits in one string
  // (e.g. "Confident, playful, direct") — split so each trait gets its own
  // pill instead of one long run-on pill. Deduped since both fields can
  // repeat a trait.
  const voiceTags = Array.from(
    new Set(
      [brand.voice.personality, brand.voice.toneOfVoice]
        .filter((v): v is string => Boolean(v))
        .flatMap((v) => v.split(",").map((s) => s.trim()))
        .filter(Boolean),
    ),
  );

  return (
    <div className="flex flex-col gap-3 px-4 py-4 text-sm">
      <BrandSummaryCard
        name={brand.name}
        website={website}
        verified={brand.confidence === "high"}
        confidence={brand.confidence}
        isMock={brand.isMock}
        rows={brandSummaryRows(brand)}
        colors={allPaletteHexes(brandKit)}
        logos={brandKit.logos}
        // Editing the profile happens in Brand Brain (its Assets tab has the
        // dossier form, the Visual Identity tab the look).
        editHref={buildHubHref(projectId, { panel: "brand-brain" })}
      />

      <ConnectedAccountsCard projectId={projectId} accounts={connections} />

      <CollapsibleCard title="Marka kiti" defaultOpen={empty}>
        {empty ? (
          <EmptyKitCard
            projectId={projectId}
            website={website}
            kit={brandKit}
          />
        ) : (
          <>
            <div className="mb-3 flex justify-end">
              <BrandScanButton
                projectId={projectId}
                website={website}
                hasLogo={hasLogo}
                kit={brandKit}
              />
            </div>
            <LogoTiles kit={brandKit} projectId={projectId} />
            <PaletteSection kit={brandKit} projectId={projectId} />
            <TypographySection kit={brandKit} />
            <StyleSection kit={brandKit} projectId={projectId} />
            <LayoutSection kit={brandKit} projectId={projectId} />
          </>
        )}
      </CollapsibleCard>

      <CollapsibleCard title="Marka stratejisi">
        <div className="pb-1">
          <div className="mb-3.5">
            <SectionLabel>BRAND ESSENCE</SectionLabel>
            {/* A glanceable summary, not the full text — Brand Brain has it
                in full; the title shows it on hover. */}
            <p
              className="mt-1 line-clamp-3 text-base leading-[1.3] font-semibold tracking-[-0.01em]"
              style={{ color: "var(--ws-text)" }}
              title={brand.valueProposition || undefined}
            >
              {brand.valueProposition || "You, in every detail."}
            </p>
          </div>

          {brand.currentFocus ? (
            <Section title="CURRENT FOCUS" dot>
              <div
                className="flex items-start gap-2 rounded-xl border px-3 py-2.5"
                style={{
                  borderColor: "var(--ws-olive)",
                  background: "var(--ws-soft-green)",
                }}
              >
                <Sparkle
                  className="mt-0.5 size-3.5 shrink-0"
                  style={{ color: "var(--ws-accent)" }}
                />
                <span
                  className="text-sm leading-5"
                  style={{ color: "var(--ws-text-body)" }}
                >
                  {brand.currentFocus.title}
                </span>
              </div>
            </Section>
          ) : null}

          {voiceTags.length > 0 ? (
            <Section title="BRAND VOICE">
              <div className="flex flex-wrap gap-1.5">
                {voiceTags.slice(0, 6).map((tag) => (
                  <Pill key={tag}>{tag}</Pill>
                ))}
              </div>
            </Section>
          ) : null}

          {brand.markets.length > 0 ? (
            <Section title="TARGET MARKETS">
              <div className="flex flex-col gap-1.5">
                {brand.markets.map((market, index) => (
                  <div
                    key={market}
                    className="flex items-center gap-2 text-sm"
                    style={{ color: "var(--ws-text-body)" }}
                  >
                    <span
                      className="text-[11px] font-medium tabular-nums"
                      style={{ color: "var(--ws-text-3)" }}
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    {market}
                  </div>
                ))}
              </div>
            </Section>
          ) : null}

          {brand.creativeMemory.works.length > 0 ? (
            <Section title="WHAT WORKS">
              <ul
                className="space-y-1.5 text-xs"
                style={{ color: "var(--ws-text-2)" }}
              >
                {brand.creativeMemory.works.slice(0, 3).map((item) => (
                  <li key={item.insight} className="flex items-start gap-1.5">
                    <span
                      className="mt-0.5"
                      style={{ color: "var(--ws-approved)" }}
                    >
                      ✓
                    </span>
                    <span className="line-clamp-2" title={item.insight}>
                      {item.insight}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {brand.negativeRules.length > 0 ? (
            <Section title="NEVER DO">
              <ul
                className="space-y-1.5 text-xs"
                style={{ color: "var(--ws-text-2)" }}
              >
                {brand.negativeRules.slice(0, 3).map((rule) => (
                  <li key={rule} className="line-clamp-2" title={rule}>
                    {rule}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          <Link
            href={buildHubHref(projectId, { panel: "brand-brain" })}
            scroll={false}
            className="mt-3.5 block rounded-xl border px-3 py-2.5 text-center text-xs font-medium transition-colors hover:bg-[var(--ws-hover)]"
            style={{ borderColor: "var(--ws-border)", color: "var(--ws-text)" }}
          >
            Edit brand profile ↗
          </Link>
        </div>
      </CollapsibleCard>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="text-[10px] font-semibold tracking-[0.1em]"
      style={{ color: "var(--ws-text-3)" }}
    >
      {children}
    </div>
  );
}

function Section({
  title,
  dot,
  action,
  children,
}: {
  title: string;
  dot?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className="border-t py-3 first:border-0"
      style={{ borderColor: "var(--ws-border)" }}
    >
      <div className="mb-2.5 flex items-center justify-between">
        <span
          className="text-[10px] font-semibold tracking-[0.1em]"
          style={{ color: "var(--ws-text-3)" }}
        >
          {title}
        </span>
        {action ?? null}
        {!action && dot ? (
          <span
            className="size-1.5 rounded-full"
            style={{ background: "var(--ws-approved)" }}
          />
        ) : null}
      </div>
      {children}
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="inline-flex rounded-full border px-2.5 py-1 text-[11px]"
      style={{ borderColor: "var(--ws-border)", color: "var(--ws-text-2)" }}
    >
      {children}
    </span>
  );
}
