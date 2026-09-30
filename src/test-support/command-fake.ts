// In-memory stand-in for `prisma.command`, for DB-less tests of code that keeps
// state in Command rows (the guided-setup store, the work-session service).
//
// It reproduces the two behaviours that code depends on:
//  - insert by primary key: a duplicate id throws P2002 (the same shape
//    Prisma's PrismaClientKnownRequestError has: an Error with `code`);
//  - the JSON-path compare-and-set:
//      updateMany({ where: { id, parsedIntent: { path: [key, "rev"], equals } }, data })
//    which writes only if the stored rev still matches, and reports { count }.
// `snapshot()` returns a deep copy of every row so a test can prove that a GET,
// a start-on-existing or a poll changed NOTHING.

import {
  type Row,
  cloneJson,
  cloneRow,
  matchesWhere,
  project,
  recordNotFound,
  sortRows,
  uniqueViolation,
} from "./fake-where";

export type CommandFakeOptions = {
  // Injected clock for createdAt (default: one fixed second per insert, so the
  // insertion order is also the createdAt order).
  now?: () => Date;
  // Rows that exist before the test starts (deep-copied).
  seed?: readonly Row[];
};

type Args = Record<string, unknown>;

// Columns holding JSON: stored the way Postgres would (text round trip).
const JSON_COLUMNS = ["parsedIntent", "attachments"] as const;

const NULLABLE_COLUMNS = [
  "projectId",
  "brandId",
  "ideaId",
  "topic",
  "parsedIntent",
  "createdByUserId",
  "attachments",
  "replyText",
  "replyStatus",
] as const;

function dataOf(args: Args): Row {
  const data = args.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("command fake: missing data");
  }
  return data as Row;
}

function whereIdOf(args: Args): string {
  const where = args.where as Row | undefined;
  if (!where || typeof where.id !== "string") {
    throw new Error("command fake: where.id is required");
  }
  return where.id;
}

export function makeCommandFake(options: CommandFakeOptions = {}) {
  const rows = new Map<string, Row>();
  let sequence = 0;
  const base = Date.UTC(2026, 0, 1);
  const now = options.now ?? (() => new Date(base + sequence * 1000));

  function applyData(row: Row, data: Row): void {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue; // Prisma: "leave the column alone"
      row[key] = (JSON_COLUMNS as readonly string[]).includes(key)
        ? cloneJson(value)
        : structuredClone(value);
    }
  }

  function insert(data: Row): Row {
    sequence += 1;
    const id = typeof data.id === "string" ? data.id : `cmd_fake_${sequence}`;
    if (rows.has(id)) throw uniqueViolation();
    const row: Row = { id };
    for (const column of NULLABLE_COLUMNS) row[column] = null;
    row.createdAt = now();
    applyData(row, data);
    row.id = id;
    rows.set(id, row);
    return row;
  }

  function matching(where: unknown): Row[] {
    return [...rows.values()].filter((row) => matchesWhere(row, where));
  }

  for (const seeded of options.seed ?? []) insert(seeded);

  return {
    async create(args: Args): Promise<Row> {
      return project(insert(dataOf(args)), args.select);
    },

    async findUnique(args: Args): Promise<Row | null> {
      const row = rows.get(whereIdOf(args));
      return row ? project(row, args.select) : null;
    },

    async findFirst(args: Args = {}): Promise<Row | null> {
      const [first] = sortRows(matching(args.where), args.orderBy);
      return first ? project(first, args.select) : null;
    },

    async update(args: Args): Promise<Row> {
      const row = rows.get(whereIdOf(args));
      if (!row) throw recordNotFound();
      applyData(row, dataOf(args));
      return project(row, args.select);
    },

    // The CAS: a JSON-path filter on a missing key or a different rev matches
    // nothing, so concurrent writers holding the same rev see exactly one
    // { count: 1 }.
    async updateMany(args: Args): Promise<{ count: number }> {
      const hits = matching(args.where);
      for (const row of hits) applyData(row, dataOf(args));
      return { count: hits.length };
    },

    // Deep copy of every row in insertion order.
    snapshot(): Row[] {
      return [...rows.values()].map(cloneRow);
    },
  };
}

export type CommandFake = ReturnType<typeof makeCommandFake>;
