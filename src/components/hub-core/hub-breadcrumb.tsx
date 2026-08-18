import Link from "next/link";

import { buildHubHref, type PanelKey } from "./hub-core-params";
import { LINEAGE, PANEL_LABEL, RELATION_LABEL } from "./lineage-map";

// Panel açıldığında üstte görünen "besliyor / beslenir / yapılandırır"
// rozet şeridi — bir çocuğun bile "bu nereden geliyor, nereye gidiyor"
// sorusuna cevap bulabilmesi için.
export function HubBreadcrumb({
  projectId,
  panel,
}: {
  projectId: string;
  panel: PanelKey;
}) {
  const edges = LINEAGE[panel];
  if (edges.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {edges.map((edge) => (
        <Link
          key={`${edge.relation}-${edge.panel}`}
          href={buildHubHref(projectId, {
            panel: edge.panel,
            sub: null,
            entity: null,
          })}
          scroll={false}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground"
        >
          <span className="text-muted-foreground/70">
            {RELATION_LABEL[edge.relation]}:
          </span>
          <span className="font-medium text-primary">
            {PANEL_LABEL[edge.panel]}
          </span>
        </Link>
      ))}
    </div>
  );
}
