import Link from "next/link";

import type { WordPressConnectionView } from "@/lib/seo/apply/view-types";
import type { StatusTone } from "@/lib/labels/types";
import { StatusBadge } from "@/components/shared/status-badge";
import { BrandTile } from "@/components/integrations/brand-icons";

// Connectors sayfasındaki WordPress kartı (SC-F8). Yalnız SEO_APPLY açıkken
// görünüm gelir (view null ise kart hiç çizilmez); sayfa kartı paylaşılan
// düzenlemeyle ekler. Kimlik bilgisi bu görünümde yoktur.

function toneOf(view: WordPressConnectionView): StatusTone {
  if (!view.connected) return "neutral";
  if (view.health === "OK") return "positive";
  if (view.health === "LIMITED" || view.health === "UNKNOWN") return "waiting";
  return "danger";
}

export function WordPressTile({
  base,
  kategori,
  view,
}: {
  base: string;
  kategori: string | undefined;
  view: WordPressConnectionView | null;
}) {
  if (!view) return null;
  const params = new URLSearchParams({ integration: "wordpress" });
  if (kategori) params.set("kategori", kategori);

  const subtitle = view.connected
    ? (view.host ?? view.accountLabel ?? "Connected")
    : "Publish articles and edit pages";
  const label = view.connected ? view.healthLabel : "Not connected";

  return (
    <Link
      href={`${base}?${params.toString()}`}
      className="flex flex-col gap-3 rounded-xl border border-border p-3.5 transition-colors hover:bg-muted/50"
    >
      <div className="flex items-center justify-between gap-2">
        <BrandTile brand="wordpress" className="size-9" iconClassName="size-5" />
        <StatusBadge meta={{ label, tone: toneOf(view) }} />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">
          WordPress
        </p>
        <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
      </div>
    </Link>
  );
}
