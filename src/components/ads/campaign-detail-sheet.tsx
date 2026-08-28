import Link from "next/link";
import { Pencil } from "lucide-react";

import { EntitySheet } from "@/components/shared/entity-sheet";
import { StatusBadge } from "@/components/shared/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { MetaCampaignSummary } from "@/server/integrations/meta-client";

function statusTone(status: string): "positive" | "waiting" | "neutral" {
  if (status === "ACTIVE") return "positive";
  if (status === "PAUSED") return "waiting";
  return "neutral";
}

function formatMoney(cents: number | undefined, currency: string): string {
  if (cents === undefined) return "—";
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

// Read-only full detail for one Campaign, driven by ?campaignDetail=<id> in
// ads/page.tsx. Campaigns carry the least editable surface of the three
// levels — Meta doesn't allow changing `objective` after creation — so the
// Edit link only ever opens a budget+status form (see campaign-edit-form.tsx).
export function CampaignDetailSheet({
  campaign,
  currency,
  closeHref,
  editHref,
}: {
  campaign: MetaCampaignSummary;
  currency: string;
  closeHref: string;
  editHref: string;
}) {
  const rows: { label: string; value: React.ReactNode }[] = [
    {
      label: "Status",
      value: (
        <StatusBadge
          meta={{
            label: campaign.effectiveStatus,
            tone: statusTone(campaign.status),
          }}
        />
      ),
    },
    { label: "Objective", value: campaign.objective },
    {
      label: "Daily budget",
      value: formatMoney(campaign.dailyBudgetCents, currency),
    },
    {
      label: "Lifetime budget",
      value: formatMoney(campaign.lifetimeBudgetCents, currency),
    },
    { label: "Campaign ID", value: campaign.campaignId },
  ];

  return (
    <EntitySheet
      closeHref={closeHref}
      title={campaign.name}
      description="Campaign details"
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
      <Link
        href={editHref}
        className={cn(buttonVariants({ size: "sm" }), "w-full gap-1.5")}
      >
        <Pencil className="size-3.5" /> Edit budget & status
      </Link>
    </EntitySheet>
  );
}
