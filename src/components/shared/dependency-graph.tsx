import type { DepartmentKey, TaskStatus } from "@prisma/client";

import { cn } from "@/lib/utils";
import {
  capabilityLabel,
  DEPARTMENT_COLOR,
  DEPARTMENT_KEY,
  TASK_STATUS,
} from "@/lib/labels";
import { StatusBadge } from "@/components/shared/status-badge";

export type GraphNode = {
  key: string;
  capability: string;
  department: string;
  dependsOnKeys: string[];
};

// Deterministic longest-path level layout: nodes flow left→right by
// dependency depth; SVG lines connect columns. RSC — no client JS.
const NODE_W = 190;
const NODE_H = 74;
const GAP_X = 56;
const GAP_Y = 16;

function levelOf(
  node: GraphNode,
  byKey: Map<string, GraphNode>,
  memo: Map<string, number>,
): number {
  const cached = memo.get(node.key);
  if (cached !== undefined) return cached;
  memo.set(node.key, 0); // cycle guard
  const level =
    node.dependsOnKeys.length === 0
      ? 0
      : 1 +
        Math.max(
          ...node.dependsOnKeys.map((dep) => {
            const parent = byKey.get(dep);
            return parent ? levelOf(parent, byKey, memo) : 0;
          }),
        );
  memo.set(node.key, level);
  return level;
}

export function DependencyGraph({
  nodes,
  taskStatusByKey,
  className,
}: {
  nodes: GraphNode[];
  taskStatusByKey?: Record<string, TaskStatus>;
  className?: string;
}) {
  if (nodes.length === 0) return null;

  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const memo = new Map<string, number>();
  const levels = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const level = levelOf(node, byKey, memo);
    const list = levels.get(level) ?? [];
    list.push(node);
    levels.set(level, list);
  }
  const levelKeys = [...levels.keys()].sort((a, b) => a - b);

  // Compute pixel positions.
  const positions = new Map<string, { x: number; y: number }>();
  let maxRows = 0;
  for (const level of levelKeys) {
    const column = levels.get(level) ?? [];
    maxRows = Math.max(maxRows, column.length);
    column.forEach((node, row) => {
      positions.set(node.key, {
        x: level * (NODE_W + GAP_X),
        y: row * (NODE_H + GAP_Y),
      });
    });
  }
  const width = levelKeys.length * (NODE_W + GAP_X) - GAP_X;
  const height = maxRows * (NODE_H + GAP_Y) - GAP_Y;

  return (
    <div className={cn("overflow-x-auto", className)}>
      <div className="relative" style={{ width, height }}>
        <svg
          className="pointer-events-none absolute inset-0"
          width={width}
          height={height}
        >
          {nodes.flatMap((node) =>
            node.dependsOnKeys.map((dep) => {
              const from = positions.get(dep);
              const to = positions.get(node.key);
              if (!from || !to) return null;
              const x1 = from.x + NODE_W;
              const y1 = from.y + NODE_H / 2;
              const x2 = to.x;
              const y2 = to.y + NODE_H / 2;
              const mid = (x1 + x2) / 2;
              return (
                <path
                  key={`${dep}->${node.key}`}
                  d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  className="stroke-foreground/20"
                  strokeWidth={1.5}
                />
              );
            }),
          )}
        </svg>
        {nodes.map((node) => {
          const pos = positions.get(node.key);
          if (!pos) return null;
          const deptKey = node.department as DepartmentKey;
          const deptMeta = DEPARTMENT_KEY[deptKey];
          const deptColor = DEPARTMENT_COLOR[deptKey];
          const taskStatus = taskStatusByKey?.[node.key];
          return (
            <div
              key={node.key}
              className="absolute rounded-lg border-l-2 bg-card p-2.5 ring-1 ring-foreground/10"
              style={{
                left: pos.x,
                top: pos.y,
                width: NODE_W,
                height: NODE_H,
                borderLeftColor: deptColor,
              }}
            >
              <p className="truncate text-xs font-medium capitalize">
                {capabilityLabel(node.capability)}
              </p>
              <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                {deptMeta?.label ?? node.department}
              </p>
              {taskStatus ? (
                <div className="mt-1">
                  <StatusBadge
                    meta={TASK_STATUS[taskStatus]}
                    className="h-4 px-1.5 text-[10px]"
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
