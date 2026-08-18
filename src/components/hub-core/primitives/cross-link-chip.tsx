import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { entityHref, ENTITY_PANEL, type EntityRef } from "../hub-core-params";
import { PANEL_LABEL } from "../lineage-map";

// FK alanlarını başka bir modülün kaydına atlayan bir rozete çevirir —
// hub içinde sayfa değişmeden `entity=` param'ını günceller. "Eksik veri
// kalmasın" hedefinin bağlantı tarafı: her FK, tıklanabilir bir chip olur.
export function CrossLinkChip({
  projectId,
  entity,
  text,
  sub,
  className,
}: {
  projectId: string;
  entity: EntityRef;
  text: string;
  sub?: string | null;
  className?: string;
}) {
  return (
    <Link
      href={entityHref(projectId, entity, sub)}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs text-accent-foreground transition-colors hover:brightness-110",
        className,
      )}
      title={`${PANEL_LABEL[ENTITY_PANEL[entity.kind]]} — ${text}`}
    >
      <span className="min-w-0 truncate">{text}</span>
      <ArrowUpRight className="size-3 shrink-0 opacity-70" />
    </Link>
  );
}
