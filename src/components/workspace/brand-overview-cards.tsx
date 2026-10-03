import type { ReactNode } from "react";
import Link from "next/link";
import {
  Briefcase,
  ChevronDown,
  Fingerprint,
  Link2,
  MapPin,
  MessageSquareQuote,
  Palette,
  Pencil,
  Settings2,
  Users,
} from "lucide-react";

import { BrandIdentityLine } from "@/components/brand/brand-kit-sections";
import { BrandIcon, type BrandKey } from "@/components/integrations/brand-icons";
import { CardTitle } from "@/components/workspace/card-title";
import type {
  ConnectedAccount,
  ConnectedAccountKey,
} from "@/lib/connected-accounts";
import type { BrandTwin } from "@/server/brand-twin/brand-twin";
import { assetUrl } from "@/lib/asset-url";

// The right panel's Brand tab opens with where the brand's accounts stand (one
// row of icons) and the brand at a glance (name, site and the few facts every
// post leans on). The rest of the tab (the visual kit, the strategy text) sits
// in collapsed cards below. Every card and row has an icon beside its title,
// so the tab reads at a glance. Labels are Turkish, as designed.

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

export type SummaryRowKey = "sector" | "audience" | "tone" | "markets";
export type SummaryRow = { key: SummaryRowKey; label: string; value: string };

const ROW_ICON: Record<SummaryRowKey, ReactNode> = {
  sector: <Briefcase />,
  audience: <Users />,
  tone: <MessageSquareQuote />,
  markets: <MapPin />,
};

// The facts under the brand's name. A row with nothing behind it is left out:
// the card never shows an empty label. There is no separate "industry" field on
// a brand, so "Sektör" is what the constitution says the business is (its
// business model), else its positioning.
export function brandSummaryRows(brand: BrandTwin): SummaryRow[] {
  const rows: SummaryRow[] = [];
  const sector = brand.businessModel?.trim() || brand.positioning?.trim();
  if (sector) rows.push({ key: "sector", label: "Sektör", value: sector });
  if (brand.audience.length > 0) {
    rows.push({ key: "audience", label: "Hedef kitle", value: brand.audience.join(", ") });
  }
  const tone = toneOfVoice(brand.voice);
  if (tone) rows.push({ key: "tone", label: "Ses tonu", value: tone });
  if (brand.markets.length > 0) {
    rows.push({ key: "markets", label: "Pazarlar", value: brand.markets.join(", ") });
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
          src={assetUrl(src, "thumb")}
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
      <CardTitle
        icon={<Fingerprint />}
        aside={
          <Link
            href={editHref}
            scroll={false}
            className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--ws-hover)]"
            style={{ borderColor: "var(--ws-border)", color: "var(--ws-text-2)" }}
          >
            <Pencil className="size-2.5" />
            Düzenle
          </Link>
        }
      >
        Marka özeti
      </CardTitle>

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

      <dl className="mt-1">
        {rows.map((row) => (
          <SummaryLine key={row.key} icon={ROW_ICON[row.key]} label={row.label}>
            <dd
              className="line-clamp-2 text-xs leading-snug font-medium"
              style={{ color: "var(--ws-text)" }}
              title={row.value}
            >
              {row.value}
            </dd>
          </SummaryLine>
        ))}
        {colors.length > 0 ? (
          <SummaryLine row="brand-colors" icon={<Palette />} label="Renkler">
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
          </SummaryLine>
        ) : null}
      </dl>
    </section>
  );
}

// One fact in the summary card: icon and label on the left, the value beside.
function SummaryLine({
  icon,
  label,
  row,
  children,
}: {
  icon: ReactNode;
  label: string;
  row?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-row={row}
      className="grid grid-cols-[92px_1fr] items-baseline gap-2 border-b py-2 last:border-b-0"
      style={{ borderColor: "var(--ws-border)" }}
    >
      <dt
        className="flex items-center gap-1.5 text-[11px] [&>svg]:size-3 [&>svg]:shrink-0"
        style={{ color: "var(--ws-text-3)" }}
      >
        {icon}
        {label}
      </dt>
      {children}
    </div>
  );
}

// Each account's own mark. Only accounts that can really be linked have one:
// the website is not an account (its address is in the summary card).
const ACCOUNT_BRAND: Partial<Record<ConnectedAccountKey, BrandKey>> = {
  instagram: "instagram",
  facebook: "facebook",
  "meta-ads": "meta-ads",
  ga4: "ga4",
  "search-console": "search-console",
  tiktok: "tiktok",
  linkedin: "linkedin",
  x: "x",
};

// "Instagram · @webhealth": the hover text and the accessible name of an
// account's icon, since the row shows no words.
export function accountTitle(account: ConnectedAccount): string {
  return [account.label, account.detail].filter(Boolean).join(" · ");
}

// Only what is really linked: a half-set-up Google account (no property or
// site chosen yet), one not linked at all, and the website are left out.
export function linkedAccounts(
  accounts: ConnectedAccount[],
): (ConnectedAccount & { brand: BrandKey })[] {
  return accounts.flatMap((account) => {
    const brand = ACCOUNT_BRAND[account.key];
    return account.state === "connected" && brand ? [{ ...account, brand }] : [];
  });
}

// One row of icons, one per linked account, in the brands' own colours.
export function ConnectedAccountsCard({
  projectId,
  accounts,
}: {
  projectId: string;
  accounts: ConnectedAccount[];
}) {
  const href = `/projects/${projectId}/integrations`;
  const linked = linkedAccounts(accounts);
  return (
    <section
      aria-label="Bağlı hesaplar"
      data-card="connected-accounts"
      className={CARD_CLASS}
      style={CARD_STYLE}
    >
      <CardTitle
        icon={<Link2 />}
        aside={
          linked.length > 0 ? (
            <Link
              href={href}
              className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--ws-hover)]"
              style={{ borderColor: "var(--ws-border)", color: "var(--ws-text-2)" }}
            >
              <Settings2 className="size-2.5" />
              Yönet
            </Link>
          ) : null
        }
      >
        Bağlı hesaplar
      </CardTitle>
      {accounts.length === 0 ? (
        <p className="mt-2 text-xs" style={{ color: "var(--ws-text-3)" }}>
          Hesap durumu şu an okunamadı.
        </p>
      ) : linked.length === 0 ? (
        <p className="mt-2 text-xs" style={{ color: "var(--ws-text-3)" }}>
          Henüz bağlı hesap yok.{" "}
          <Link
            href={href}
            className="font-medium underline underline-offset-2"
            style={{ color: "var(--ws-text)" }}
          >
            Hesap bağla
          </Link>
        </p>
      ) : (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {linked.map((account) => (
            <li key={account.key}>
              <Link
                href={href}
                title={accountTitle(account)}
                aria-label={accountTitle(account)}
                data-account={account.key}
                className="flex size-8 items-center justify-center rounded-lg border transition-colors hover:bg-[var(--ws-hover)]"
                style={{
                  borderColor: "var(--ws-border)",
                  background: "var(--ws-surface-2)",
                  color: "var(--ws-text)",
                }}
              >
                <BrandIcon brand={account.brand} className="size-4" />
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
  icon,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon: ReactNode;
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
      <summary className="cursor-pointer list-none px-3.5 py-3 [&::-webkit-details-marker]:hidden">
        <CardTitle
          icon={icon}
          aside={
            <ChevronDown
              className="size-3.5 transition-transform group-open:rotate-180"
              style={{ color: "var(--ws-text-3)" }}
            />
          }
        >
          {title}
        </CardTitle>
      </summary>
      <div className="px-3.5 pb-3.5">{children}</div>
    </details>
  );
}
