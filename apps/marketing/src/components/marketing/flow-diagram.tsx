import { cn } from "@/lib/utils";

export type FlowNodeKind =
  "signal" | "decision" | "coordination" | "execution" | "hub" | "node";

export type FlowNode = {
  id: string;
  label: string;
  sublabel?: string;
  kind?: FlowNodeKind;
  /** 0–100, percentage position within the diagram's viewBox */
  x: number;
  /** 0–100 */
  y: number;
};

export type FlowEdge = {
  id: string;
  from: string;
  to: string;
  animated?: boolean;
  broken?: boolean;
};

type FlowDiagramProps = {
  nodes: FlowNode[];
  edges: FlowEdge[];
  ariaLabel: string;
  viewBox?: { width: number; height: number };
  className?: string;
};

const KIND_CLASSES: Record<FlowNodeKind, string> = {
  signal: "border-border",
  decision: "border-border",
  coordination: "border-[var(--agentelse-accent)]/40",
  execution: "border-border",
  hub: "border-[var(--agentelse-accent)] bg-[var(--agentelse-accent-soft)]",
  node: "border-border",
};

/**
 * The recurring Agentelse motif: signal → decision → coordination →
 * execution, rendered as a percentage-positioned node/edge system so it
 * scales fluidly. One primitive, reused with different node/edge data
 * across the hero, the traditional-AI comparison, Brand Brain, and
 * Departments — see radialPositions() for hub-and-spoke layouts.
 */
export function FlowDiagram({
  nodes,
  edges,
  ariaLabel,
  viewBox = { width: 1200, height: 300 },
  className,
}: FlowDiagramProps) {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  return (
    <figure className={cn("relative w-full", className)}>
      <div
        aria-hidden="true"
        className="relative w-full"
        style={{ aspectRatio: `${viewBox.width} / ${viewBox.height}` }}
      >
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
          viewBox={`0 0 ${viewBox.width} ${viewBox.height}`}
          preserveAspectRatio="none"
        >
          {edges.map((edge) => {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (!from || !to) return null;
            const x1 = (from.x / 100) * viewBox.width;
            const y1 = (from.y / 100) * viewBox.height;
            const x2 = (to.x / 100) * viewBox.width;
            const y2 = (to.y / 100) * viewBox.height;
            const midX = (x1 + x2) / 2;
            const d = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
            return (
              <g key={edge.id}>
                <path
                  d={d}
                  fill="none"
                  stroke="var(--agentelse-line)"
                  strokeWidth={1.5}
                  strokeDasharray={edge.broken ? "3 5" : undefined}
                  opacity={edge.broken ? 0.6 : 1}
                />
                {edge.animated && !edge.broken ? (
                  <path
                    d={d}
                    fill="none"
                    stroke="var(--agentelse-accent)"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    className="agentelse-signal-path"
                  />
                ) : null}
              </g>
            );
          })}
        </svg>
        {nodes.map((node) => (
          <div
            key={node.id}
            className={cn(
              "absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5 rounded-lg border bg-background px-3 py-2 text-center shadow-[0_1px_2px_rgba(0,0,0,0.04)]",
              KIND_CLASSES[node.kind ?? "node"],
              node.kind === "hub" && "agentelse-hub-pulse",
            )}
            style={{ left: `${node.x}%`, top: `${node.y}%` }}
          >
            <span className="text-xs font-medium whitespace-nowrap text-foreground">
              {node.label}
            </span>
            {node.sublabel ? (
              <span
                key={node.sublabel}
                className="agentelse-text-caption animate-in fade-in slide-in-from-bottom-0.5 whitespace-nowrap text-muted-foreground duration-500"
              >
                {node.sublabel}
              </span>
            ) : null}
          </div>
        ))}
      </div>
      <figcaption className="sr-only">{ariaLabel}</figcaption>
    </figure>
  );
}

/** Positions `count` nodes evenly around a circle for hub-and-spoke layouts. */
export function radialPositions(
  centerX: number,
  centerY: number,
  radius: number,
  count: number,
): { x: number; y: number }[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2;
    return {
      x: centerX + radius * Math.cos(angle),
      y: centerY + radius * Math.sin(angle),
    };
  });
}
