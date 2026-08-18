import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { entityHref, ENTITY_PANEL, type EntityRef } from "../hub-core-params";
import { PANEL_LABEL } from "../lineage-map";

// Turns FK fields into a badge that jumps to another module's record —
// updates the `entity=` param within the hub without changing pages. The
// linking side of the "no missing data" goal: every FK becomes a
// clickable chip.
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
