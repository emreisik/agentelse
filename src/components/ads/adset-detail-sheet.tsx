import Link from "next/link";
import { Pencil } from "lucide-react";

import { EntitySheet } from "@/components/shared/entity-sheet";
import { StatusBadge } from "@/components/shared/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { countryLabel } from "@/lib/locales";
import { GENDER_OPTIONS } from "@/lib/meta-ad-targeting-data";
import type { MetaAdSetSummary } from "@/server/integrations/meta-client";

function statusTone(status: string): "positive" | "waiting" | "neutral" {
  if (status === "ACTIVE") return "positive";
  if (status === "PAUSED") return "waiting";
  return "neutral";
}

function formatMoney(cents: number | undefined, currency: string): string {
  if (cents === undefined) return "—";
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

// Read-only full detail for one AdSet, driven by ?adsetDetail=<id> in
// ads/page.tsx — the targeting breakdown here is new: it was never fetched
// or displayed before this (see listMetaAdSets' `targeting` field in
// meta-client.ts).
export function AdSetDetailSheet({
  adSet,
  currency,
  closeHref,
  editHref,
}: {
  adSet: MetaAdSetSummary;
  currency: string;
  closeHref: string;
  editHref: string;
}) {
  const targeting = adSet.targeting;
  const genderLabel =
    GENDER_OPTIONS.find(
      (g) =>
        (g.value === "1" &&
          targeting?.genders?.length === 1 &&
          targeting.genders[0] === 1) ||
        (g.value === "2" &&
          targeting?.genders?.length === 1 &&
          targeting.genders[0] === 2),
    )?.label ?? "All";
  const localeLabels = (targeting?.locales ?? [])
    .map((l) => l.label ?? `Locale #${l.id}`)
    .join(", ");

  const rows: { label: string; value: React.ReactNode }[] = [
    {
      label: "Status",
      value: (
        <StatusBadge
          meta={{
            label: adSet.effectiveStatus,
            tone: statusTone(adSet.status),
          }}
        />
      ),
    },
    {
      label: "Daily budget",
      value: formatMoney(adSet.dailyBudgetCents, currency),
    },
    { label: "Billing event", value: adSet.billingEvent ?? "—" },
    { label: "Optimization goal", value: adSet.optimizationGoal ?? "—" },
    { label: "AdSet ID", value: adSet.adSetId },
  ];

  const targetingRows: { label: string; value: string }[] = [
    {
      label: "Countries",
      value: targeting?.countries.length
        ? targeting.countries.map(countryLabel).join(", ")
        : "—",
    },
    ...(targeting?.cities?.length
      ? [
          {
            label: "Cities",
            value: targeting.cities.map((c) => c.name ?? c.key).join(", "),
          },
        ]
      : []),
    {
      label: "Age range",
      value:
        targeting?.ageMin !== undefined || targeting?.ageMax !== undefined
          ? `${targeting?.ageMin ?? 13}–${targeting?.ageMax ?? 65}`
          : "—",
    },
    { label: "Gender", value: genderLabel },
    ...(localeLabels ? [{ label: "Languages", value: localeLabels }] : []),
  ];

  return (
    <EntitySheet
      closeHref={closeHref}
      title={adSet.name}
      description="Ad set details"
    >
      <dl className="divide-y divide-border/60 overflow-hidden rounded-xl ring-1 ring-foreground/10">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between gap-3 bg-muted/30 px-4 py-2.5"
          >
            <dt className="text-xs text-muted-foreground">{row.label}</dt>
            <dd className="text-sm font-medium">{row.value}</dd>
          </div>
        ))}
      </dl>
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">
          Targeting
        </p>
        <dl className="divide-y divide-border/60 overflow-hidden rounded-xl ring-1 ring-foreground/10">
          {targetingRows.map((row) => (
            <div
              key={row.label}
              className="flex items-center justify-between gap-3 bg-muted/30 px-4 py-2.5"
            >
              <dt className="text-xs text-muted-foreground">{row.label}</dt>
              <dd className="max-w-[65%] text-right text-sm font-medium">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <Link
        href={editHref}
        className={cn(buttonVariants({ size: "sm" }), "w-full gap-1.5")}
      >
        <Pencil className="size-3.5" /> Edit budget & targeting
      </Link>
    </EntitySheet>
  );
}
