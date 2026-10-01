import type { ReactNode } from "react";
import Link from "next/link";
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  Globe,
  Infinity as InfinityIcon,
  Pencil,
  Search,
} from "lucide-react";

import { BrandIdentityLine } from "@/components/brand/brand-kit-sections";
import type {
  ConnectedAccount,
  ConnectedAccountKey,
  ConnectedAccountState,
} from "@/lib/connected-accounts";
import type { BrandTwin } from "@/server/brand-twin/brand-twin";

// The right panel's Brand tab opens with two cards: the brand at a glance
// (name, site and the few facts that matter) and where its accounts stand. The
// rest of the tab (the visual kit, the strategy text) sits in collapsed cards
// below. Labels are Turkish, as designed. Sizes follow the other tabs (Files,
// Outputs, Calendar): text-sm titles, text-xs values, 10-11px meta, size-8
// icon boxes.

const CARD_CLASS = "rounded-xl border p-3.5";
const CARD_STYLE = {
  borderColor: "var(--ws-border)",
  background: "var(--ws-surface)",
} as const;

// "Profesyonel, net, güvenilir": the tone and personality as one line. Both
// fields are free text that is often a comma-separated list; split, deduped.
function toneOfVoice(voice: BrandTwin["voice"]): string | null {
  const traits = Array.from(
    new Set(
      [voice.personality, voice.toneOfVoice]
        .filter((value): value is string => Boolean(value))
        .flatMap((value) => value.split(",").map((trait) => trait.trim()))
        .filter(Boolean),
    ),
  );
  return traits.length > 0 ? traits.join(", ") : null;
}

export type SummaryRow = { label: string; value: string };

// The facts under the brand's name. A row with nothing behind it is left out:
// the card never shows an empty label. There is no separate "industry" field on
// a brand, so "Sektör" is what the constitution says the business is (its
// business model), else its positioning.
export function brandSummaryRows(brand: BrandTwin): SummaryRow[] {
  const rows: SummaryRow[] = [];
  const sector = brand.businessModel?.trim() || brand.positioning?.trim();
  if (sector) rows.push({ label: "Sektör", value: sector });
  if (brand.audience.length > 0) {
    rows.push({ label: "Hedef Kitle", value: brand.audience.join(", ") });
  }
  const tone = toneOfVoice(brand.voice);
  if (tone) rows.push({ label: "Tone of Voice", value: tone });
  if (brand.markets.length > 0) {
    rows.push({ label: "Pazarlar", value: brand.markets.join(", ") });
  }
  return rows;
}

const CONFIDENCE_NOTE: Partial<Record<BrandTwin["confidence"], string>> = {
  medium: "Marka hâlâ öğreniliyor",
  low: "Marka profili yeni başlıyor",
};

// The brand's logo on a tile it can be read on: the dark-coloured mark on a
// light tile, else the light-coloured mark on a dark one. No logo: the
// brand's initial.
function LogoTile({
  name,
  logos,
}: {
  name: string;
  logos: { light: string | null; dark: string | null };
}) {
  const src = logos.dark ?? logos.light;
  const onDark = !logos.dark && Boolean(logos.light);
  return (
    <span
      className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg"
      style={{
        background: onDark ? "#111827" : "var(--ws-surface-2)",
        color: "var(--ws-text)",
      }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image can't optimize it
        <img
          src={`/api/assets/${src}`}
          alt={`${name} logo`}
          className="size-7 object-contain"
        />
      ) : (
        <span className="font-serif text-lg font-bold">
          {name.trim().charAt(0).toUpperCase() || "?"}
        </span>
      )}
    </span>
  );
}

export function BrandSummaryCard({
  name,
  website,
  verified,
  confidence,
  isMock,
  rows,
  colors,
  logos,
  editHref,
}: {
  name: string;
  website: string | null;
  verified: boolean;
  confidence: BrandTwin["confidence"];
  isMock: boolean;
  rows: SummaryRow[];
  colors: string[];
  logos: { light: string | null; dark: string | null };
  editHref: string;
}) {
  return (
    <section
      aria-label="Marka özeti"
      data-card="brand-summary"
      className={CARD_CLASS}
      style={CARD_STYLE}
    >
      <div className="flex items-center justify-between gap-2">
        <h2
          className="text-sm font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          Marka özeti
        </h2>
        <Link
          href={editHref}
          scroll={false}
          className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--ws-hover)]"
          style={{ borderColor: "var(--ws-border)", color: "var(--ws-text-2)" }}
        >
          <Pencil className="size-2.5" />
          Düzenle
        </Link>
      </div>

      <div
        className="mt-3 flex items-center gap-2.5 border-b pb-3"
        style={{ borderColor: "var(--ws-border)" }}
      >
        <LogoTile name={name} logos={logos} />
        <div className="min-w-0">
          <BrandIdentityLine
            name={name}
            website={website}
            verified={verified}
            fallbackLabel={CONFIDENCE_NOTE[confidence] ?? "Marka anlaşıldı"}
          />
          {website && CONFIDENCE_NOTE[confidence] ? (
            <p className="text-[10px]" style={{ color: "var(--ws-text-3)" }}>
              {CONFIDENCE_NOTE[confidence]}
            </p>
          ) : null}
        </div>
      </div>

      {isMock ? (
        <p
          className="mt-2.5 inline-flex w-fit rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{ background: "var(--ws-soft-green)", color: "var(--ws-accent)" }}
        >
          Örnek marka profili
        </p>
      ) : null}

      <dl>
        {rows.map((row) => (
          <div
            key={row.label}
            className="grid grid-cols-[76px_1fr] items-baseline gap-2.5 border-b py-2 last:border-b-0"
            style={{ borderColor: "var(--ws-border)" }}
          >
            <dt className="text-[11px]" style={{ color: "var(--ws-text-3)" }}>
              {row.label}
            </dt>
            <dd
              className="line-clamp-3 text-xs leading-snug font-medium"
              style={{ color: "var(--ws-text)" }}
              title={row.value}
            >
              {row.value}
            </dd>
          </div>
        ))}
        {colors.length > 0 ? (
          <div
            data-row="brand-colors"
            className="grid grid-cols-[76px_1fr] items-center gap-2.5 pt-2"
          >
            <dt className="text-[11px]" style={{ color: "var(--ws-text-3)" }}>
              Marka Renkleri
            </dt>
            <dd className="flex flex-wrap gap-1.5">
              {colors.slice(0, 5).map((hex) => (
                <span
                  key={hex}
                  title={hex}
                  className="size-4 rounded-full ring-1 ring-black/10"
                  style={{ backgroundColor: hex }}
                />
              ))}
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

const ACCOUNT_MARK: Record<ConnectedAccountKey, ReactNode> = {
  instagram: <span className="text-[10px] font-bold">IG</span>,
  facebook: <span className="text-sm font-bold">f</span>,
  "meta-ads": <InfinityIcon className="size-3.5" />,
  ga4: <BarChart3 className="size-3.5" />,
  "search-console": <Search className="size-3.5" />,
  website: <Globe className="size-3.5" />,
  tiktok: <span className="text-[10px] font-bold">TT</span>,
  linkedin: <span className="text-[11px] font-bold">in</span>,
  x: <span className="text-[11px] font-bold">X</span>,
};

const STATE_WORD: Record<ConnectedAccountState, string> = {
  connected: "Bağlı",
  active: "Aktif",
  setup: "Kurulum gerekli",
  off: "Bağlı değil",
};
const STATE_COLOR: Record<ConnectedAccountState, string> = {
  connected: "var(--ws-approved)",
  active: "var(--ws-approved)",
  setup: "var(--ws-pending)",
  off: "var(--ws-text-3)",
};

// A website nobody set is "not added", not "not connected": there is nothing
// to connect.
function stateWord(account: ConnectedAccount): string {
  return account.key === "website" && account.state === "off"
    ? "Eklenmedi"
    : STATE_WORD[account.state];
}

export function ConnectedAccountsCard({
  projectId,
  accounts,
}: {
  projectId: string;
  accounts: ConnectedAccount[];
}) {
  return (
    <section
      aria-label="Bağlı hesaplar"
      data-card="connected-accounts"
      className={CARD_CLASS}
      style={CARD_STYLE}
    >
      <h2 className="text-sm font-semibold" style={{ color: "var(--ws-text)" }}>
        Bağlı hesaplar
      </h2>
      {accounts.length === 0 ? (
        <p className="mt-2 text-xs" style={{ color: "var(--ws-text-3)" }}>
          Hesap durumu şu an okunamadı.
        </p>
      ) : (
        <ul className="mt-1.5">
          {accounts.map((account) => (
            <li
              key={account.key}
              className="border-b last:border-b-0"
              style={{ borderColor: "var(--ws-border)" }}
            >
              <Link
                href={`/projects/${projectId}/integrations`}
                title={account.detail}
                data-account={account.key}
                className="flex items-center gap-2.5 py-2 transition-colors hover:opacity-80"
              >
                <span
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg"
                  style={{
                    background: "var(--ws-surface-2)",
                    color: "var(--ws-text)",
                  }}
                >
                  {ACCOUNT_MARK[account.key]}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-xs font-medium"
                  style={{ color: "var(--ws-text-body)" }}
                >
                  {account.label}
                </span>
                <span
                  className="flex shrink-0 items-center gap-1 text-[10px]"
                  style={{ color: "var(--ws-text-2)" }}
                >
                  <span
                    aria-hidden
                    className="size-1.5 rounded-full"
                    style={{ background: STATE_COLOR[account.state] }}
                  />
                  {stateWord(account)}
                </span>
                <ChevronRight
                  className="size-3.5 shrink-0"
                  style={{ color: "var(--ws-text-3)" }}
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// A card that stays closed until asked for: the visual kit and the strategy
// text, which the panel used to lead with.
export function CollapsibleCard({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      data-card={`collapsible-${title}`}
      className="group rounded-xl border"
      style={CARD_STYLE}
    >
      <summary
        className="flex cursor-pointer list-none items-center justify-between px-3.5 py-3 [&::-webkit-details-marker]:hidden"
        style={{ color: "var(--ws-text)" }}
      >
        <span className="text-sm font-semibold">{title}</span>
        <ChevronDown
          className="size-3.5 transition-transform group-open:rotate-180"
          style={{ color: "var(--ws-text-3)" }}
        />
      </summary>
      <div className="px-3.5 pb-3.5">{children}</div>
    </details>
  );
}
