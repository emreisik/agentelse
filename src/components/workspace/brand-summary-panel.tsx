import Link from "next/link";
import { BadgeCheck, Settings } from "lucide-react";

import { buildHubHref } from "@/components/hub-core/hub-core-params";
import type { BrandTwin } from "@/server/brand-twin/brand-twin";

const CONFIDENCE_LABEL: Record<BrandTwin["confidence"], string> = {
  high: "Marka anlaşıldı",
  medium: "Hâlâ öğreniyor",
  low: "Yeni başlıyor",
};

export function BrandSummaryPanel({
  projectId,
  brand,
  website,
}: {
  projectId: string;
  brand: BrandTwin | null;
  website: string | null;
}) {
  if (!brand) {
    return (
      <div className="p-5 text-sm" style={{ color: "var(--ws-text-2)" }}>
        Marka henüz kurulmadı.
      </div>
    );
  }

  // "Creative direction" — the closest real field is visualDNA.description
  // (a short phrase like "Premium editorial, minimal compositions, soft
  // daylight"); split on commas/periods into short lines instead of
  // inventing structured data that doesn't exist yet.
  const creativeDirectionLines = brand.visualDNA.description
    ? brand.visualDNA.description
        .split(/[,.]\s*/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  return (
    <div className="flex flex-col gap-0 px-5 py-5 text-sm">
      <div className="mb-4 flex items-start justify-between gap-2">
        <div>
          <SectionLabel>MARKANIN ÖZÜ</SectionLabel>
          <p
            className="mt-1 text-lg leading-[1.3] font-semibold tracking-[-0.01em]"
            style={{ color: "var(--ws-text)" }}
          >
            {brand.valueProposition || "Her detayda, sen."}
          </p>
        </div>
        <Link
          href={buildHubHref(projectId, { panel: "brand-brain" })}
          scroll={false}
          aria-label="Marka ayarları"
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--ws-hover)]"
          style={{ color: "var(--ws-text-2)" }}
        >
          <Settings className="size-3.5" />
        </Link>
      </div>

      {/* Brand Book card — spec: dark brand-colored tile, wordmark
          centered, "BRAND BOOK" + position metadata top, category + arrow
          bottom. Falls back to the accent tile when there's no logo yet
          rather than fabricating one. */}
      <div
        className="mb-5 flex aspect-[16/9] w-full flex-col justify-between overflow-hidden rounded-[9px] p-4"
        style={{ background: "var(--ws-accent)" }}
      >
        <div className="flex items-center justify-between">
          <span
            className="text-[9px] font-semibold tracking-[0.15em]"
            style={{ color: "var(--ws-on-accent)", opacity: 0.7 }}
          >
            BRAND BOOK
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          {brand.visualDNA.logoAssetId ? (
            // eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image can't optimize it
            <img
              src={`/api/assets/${brand.visualDNA.logoAssetId}`}
              alt={brand.name}
              className="max-h-[55%] max-w-[60%] object-contain"
            />
          ) : (
            <span
              className="font-serif text-2xl italic"
              style={{ color: "var(--ws-on-accent)" }}
            >
              {brand.name}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between">
          <span
            className="text-[10px]"
            style={{ color: "var(--ws-on-accent)", opacity: 0.7 }}
          >
            {brand.visualDNA.description ? "Görsel kimlik" : "Marka"}
          </span>
        </div>
      </div>

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span
              className="truncate text-lg font-semibold tracking-[-0.02em]"
              style={{ color: "var(--ws-text)" }}
            >
              {brand.name}
            </span>
            {brand.confidence === "high" ? (
              <BadgeCheck
                className="size-4 shrink-0"
                style={{ color: "var(--ws-approved)" }}
              />
            ) : null}
          </div>
          {website ? (
            <a
              href={website.startsWith("http") ? website : `https://${website}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs hover:underline"
              style={{ color: "var(--ws-text-3)" }}
            >
              {website}
            </a>
          ) : (
            <div
              className="flex items-center gap-1.5 text-xs"
              style={{ color: "var(--ws-text-3)" }}
            >
              <span
                className="size-1.5 rounded-full"
                style={{ background: "var(--ws-approved)" }}
              />
              {CONFIDENCE_LABEL[brand.confidence]}
            </div>
          )}
        </div>
      </div>

      {brand.positioning ? (
        <p
          className="mt-2 text-sm leading-6"
          style={{ color: "var(--ws-text-2)" }}
        >
          {brand.positioning}
        </p>
      ) : null}

      {brand.currentFocus ? (
        <Section title="ŞİMDİKİ ODAK">
          <div
            className="flex items-start gap-2 rounded-xl border px-3 py-2.5"
            style={{
              borderColor: "var(--ws-olive)",
              background: "var(--ws-soft-green)",
            }}
          >
            <span
              className="mt-0.5 text-sm"
              style={{ color: "var(--ws-accent)" }}
            >
              ✳
            </span>
            <span
              className="text-sm leading-5"
              style={{ color: "var(--ws-text-body)" }}
            >
              {brand.currentFocus.title}
            </span>
          </div>
        </Section>
      ) : null}

      {brand.visualDNA.colors.length > 0 || brand.visualDNA.fonts.length > 0 ? (
        <Section title="GÖRSEL KİMLİK">
          <div className="flex flex-col gap-4">
            {brand.visualDNA.colors.length > 0 ? (
              <div className="flex flex-wrap gap-3">
                {brand.visualDNA.colors.map((swatch) => (
                  <div
                    key={swatch.hex}
                    className="flex flex-col items-center gap-1"
                  >
                    <span
                      className="size-9 rounded-lg border"
                      style={{
                        backgroundColor: swatch.hex,
                        borderColor: "var(--ws-border)",
                      }}
                    />
                    <span
                      className="text-[9px] uppercase"
                      style={{ color: "var(--ws-text-3)" }}
                    >
                      {swatch.hex}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {brand.visualDNA.fonts.length > 0 ? (
              <div className="flex items-center gap-3">
                <span
                  className="font-serif text-3xl leading-none"
                  style={{ color: "var(--ws-text)" }}
                >
                  Aa
                </span>
                <div className="min-w-0">
                  <div
                    className="text-xs font-medium"
                    style={{ color: "var(--ws-text)" }}
                  >
                    {brand.visualDNA.fonts.join(" · ")}
                  </div>
                  {creativeDirectionLines.length > 0 ? (
                    <div
                      className="text-[11px]"
                      style={{ color: "var(--ws-text-3)" }}
                    >
                      {creativeDirectionLines[0]}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
            {creativeDirectionLines.length > 0 ? (
              <div
                className="flex flex-col gap-1 text-sm leading-6"
                style={{ color: "var(--ws-text-body)" }}
              >
                {creativeDirectionLines.map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </div>
            ) : null}
          </div>
        </Section>
      ) : null}

      {brand.voice.personality || brand.voice.toneOfVoice ? (
        <Section title="MARKA SESİ">
          <div className="flex flex-wrap gap-1.5">
            {[brand.voice.personality, brand.voice.toneOfVoice]
              .filter((v): v is string => Boolean(v))
              .map((v) => (
                <Pill key={v}>{v}</Pill>
              ))}
          </div>
        </Section>
      ) : null}

      {brand.markets.length > 0 ? (
        <Section title="HEDEF PAZARLAR">
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
        <Section title="İŞE YARAYANLAR">
          <ul
            className="space-y-1.5 text-xs"
            style={{ color: "var(--ws-text-2)" }}
          >
            {brand.creativeMemory.works.slice(0, 5).map((item) => (
              <li key={item.insight} className="flex items-start gap-1.5">
                <span
                  className="mt-0.5"
                  style={{ color: "var(--ws-approved)" }}
                >
                  ✓
                </span>
                <span>{item.insight}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {brand.negativeRules.length > 0 ? (
        <Section title="ASLA YAPMA">
          <ul
            className="space-y-1.5 text-xs"
            style={{ color: "var(--ws-text-2)" }}
          >
            {brand.negativeRules.slice(0, 5).map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Link
        href={buildHubHref(projectId, { panel: "brand-brain" })}
        scroll={false}
        className="mt-4 rounded-xl border px-3 py-2.5 text-center text-xs font-medium transition-colors hover:bg-[var(--ws-hover)]"
        style={{ borderColor: "var(--ws-border)", color: "var(--ws-text)" }}
      >
        Marka profilini düzenle ↗
      </Link>
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
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="border-t py-[19px] first:border-0"
      style={{ borderColor: "var(--ws-border)" }}
    >
      <div
        className="mb-2.5 text-[10px] font-semibold tracking-[0.1em]"
        style={{ color: "var(--ws-text-3)" }}
      >
        {title}
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
