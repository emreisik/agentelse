// In-memory stand-in for `prisma.auditLog`, with an injected clock, for DB-less
// tests of the guided-setup caps and receipts.
//
// `deleteMany({ where: { projectId } })` models what project deletion does to
// every table that has a projectId column. The caps live in audit rows written
// WITHOUT a projectId precisely so they survive it (guard G53): a row that has
// no projectId is never matched by a projectId filter.

import {
  type Row,
  cloneRow,
  matchesWhere,
  project,
  recordNotFound,
  sortRows,
} from "./fake-where";

export type AuditFakeOptions = {
  // Injected clock: every create stamps createdAt with now() unless the data
  // carries its own createdAt.
  now?: () => Date;
  seed?: readonly Row[];
};

type Args = Record<string, unknown>;

function dataOf(args: Args): Row {
  const data = args.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("audit fake: missing data");
  }
  return data as Row;
}

export function makeAuditFake(options: AuditFakeOptions = {}) {
  const rows: Row[] = [];
  let sequence = 0;
  const now = options.now ?? (() => new Date(Date.UTC(2026, 0, 1)));

  function write(row: Row, data: Row): void {
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) row[key] = structuredClone(value);
    }
  }

  function insert(data: Row): Row {
    sequence += 1;
    // Only the keys the caller gave exist on the row: a create without a
    // projectId leaves NO projectId key (the G53 assertion relies on it).
    const row: Row = { id: `audit_fake_${sequence}`, createdAt: now() };
    write(row, data);
    rows.push(row);
    return row;
  }

  for (const seeded of options.seed ?? []) insert(seeded);

  function byId(args: Args): Row | undefined {
    const where = args.where as Row | undefined;
    return rows.find((row) => row.id === where?.id);
  }

  return {
    async create(args: Args): Promise<Row> {
      return project(insert(dataOf(args)), args.select);
    },

    async update(args: Args): Promise<Row> {
      const row = byId(args);
      if (!row) throw recordNotFound();
      write(row, dataOf(args));
      return project(row, args.select);
    },

    async findFirst(args: Args = {}): Promise<Row | null> {
      const hits = rows.filter((row) => matchesWhere(row, args.where));
      const [first] = sortRows(hits, args.orderBy);
      return first ? project(first, args.select) : null;
    },

    async count(args: Args = {}): Promise<number> {
      return rows.filter((row) => matchesWhere(row, args.where)).length;
    },

    async deleteMany(args: Args = {}): Promise<{ count: number }> {
      let count = 0;
      const kept = rows.filter((row) => {
        const hit = matchesWhere(row, args.where);
        if (hit) count += 1;
        return !hit;
      });
      rows.splice(0, rows.length, ...kept);
      return { count };
    },

    snapshot(): Row[] {
      return rows.map(cloneRow);
    },
  };
}

export type AuditFake = ReturnType<typeof makeAuditFake>;
