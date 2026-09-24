// Pure — no server/Prisma/next-auth imports, deliberately — so it can be
// unit tested without dragging in creative-grid-actions.ts's whole
// transitive import chain (that file imports tenant-context.ts, which
// pulls in next-auth internals that don't resolve under plain Vitest).
//
// Instagram's grid shows newest-first, left-to-right/top-to-bottom — so
// for a split-image group's N tiles to reassemble correctly, the HIGHEST
// gridPosition (bottom-right of the assembled image) must publish FIRST,
// counting down to gridPosition 1 (top-left) publishing LAST. The caller
// picks one start time + one gap; this computes every tile's actual
// scheduledFor from that.
export function computeGridSeriesSchedule(
  tiles: Array<{ id: string; gridPosition: number | null }>,
  startUtc: Date,
  intervalMinutes: number,
): Array<{ id: string; scheduledFor: Date }> {
  const sortedDesc = [...tiles].sort(
    (a, b) => (b.gridPosition ?? 0) - (a.gridPosition ?? 0),
  );
  return sortedDesc.map((tile, index) => ({
    id: tile.id,
    scheduledFor: new Date(
      startUtc.getTime() + index * intervalMinutes * 60_000,
    ),
  }));
}
