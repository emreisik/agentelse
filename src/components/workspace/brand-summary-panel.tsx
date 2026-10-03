import type { ReactNode } from "react";
import {
  Ban,
  Compass,
  Crosshair,
  Gem,
  Palette,
  Sparkle,
  ThumbsUp,
} from "lucide-react";

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
import { InstagramOverviewCard } from "@/components/workspace/instagram-overview-card";
import { buildHubHref } from "@/components/hub-core/hub-core-params";
import {
  allPaletteHexes,
  buildBrandKit,
  kitIsEmpty,
  type BrandKit,
} from "@/lib/brand-kit";
import type { ConnectedAccount } from "@/lib/connected-accounts";
import type { BrandTwin } from "@/server/brand-twin/brand-twin";

// The Brand tab, most used first: where the accounts stand (a row of icons),
// the brand at a glance, the Instagram numbers while it is connected, then two
// collapsed cards: the visual kit (logo on brand-coloured surfaces, palette,
// type, style, post layouts) and the strategy text (essence, focus, what
// works, never-do). Voice and markets live in the summary only, not twice.
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

  return (
    <div className="flex flex-col gap-3 px-4 py-4 text-sm">
      <ConnectedAccountsCard projectId={projectId} accounts={connections} />

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

      {connections.some(
        (account) => account.key === "instagram" && account.state === "connected",
      ) ? (
        <InstagramOverviewCard projectId={projectId} />
      ) : null}

      <CollapsibleCard
        title="Marka kiti"
        icon={<Palette />}
        defaultOpen={empty}
      >
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

      <CollapsibleCard title="Marka stratejisi" icon={<Compass />}>
        <div className="pb-1">
          <Section title="Marka özü" icon={<Gem />}>
            {/* A glanceable summary, not the full text: Brand Brain has it
                in full; the title shows it on hover. */}
            <p
              className="line-clamp-3 text-sm leading-snug font-semibold"
              style={{ color: "var(--ws-text)" }}
              title={brand.valueProposition || undefined}
            >
              {brand.valueProposition || "You, in every detail."}
            </p>
          </Section>

          {brand.currentFocus ? (
            <Section title="Şu anki odak" icon={<Crosshair />}>
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
                  className="text-xs leading-5"
                  style={{ color: "var(--ws-text-body)" }}
                >
                  {brand.currentFocus.title}
                </span>
              </div>
            </Section>
          ) : null}

          {brand.creativeMemory.works.length > 0 ? (
            <Section title="İşe yarayanlar" icon={<ThumbsUp />}>
              <ul
                className="space-y-1.5 text-xs"
                style={{ color: "var(--ws-text-2)" }}
              >
                {brand.creativeMemory.works.slice(0, 3).map((item) => (
                  <li key={item.insight} className="line-clamp-2" title={item.insight}>
                    {item.insight}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {brand.negativeRules.length > 0 ? (
            <Section title="Asla yapma" icon={<Ban />}>
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
        </div>
      </CollapsibleCard>
    </div>
  );
}

// One part of the strategy card: a small icon and title above its content.
function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="border-t py-3 first:border-0 first:pt-0"
      style={{ borderColor: "var(--ws-border)" }}
    >
      <div
        className="mb-2 flex items-center gap-1.5 text-[11px] font-medium [&>svg]:size-3"
        style={{ color: "var(--ws-text-3)" }}
      >
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}
