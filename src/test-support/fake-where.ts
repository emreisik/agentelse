// Shared plumbing of the in-memory Prisma fakes (command-fake, audit-fake):
// a small `where` matcher and the JSON/row cloning helpers. It only knows the
// filter shapes the guided-setup code uses and THROWS on anything else, so a
// new query shape shows up as a loud test failure instead of a silent match.

export type Row = Record<string, unknown>;

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

// Postgres JSON columns round-trip through text: undefined keys vanish and
// Dates become strings. Model that so a fake row never aliases test objects.
export function cloneJson(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

// Deep copy of a whole row (Dates stay Dates); `undefined` values are dropped
// the way Prisma treats them ("field not given").
export function cloneRow(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) out[key] = structuredClone(value);
  }
  return out;
}

function readPath(json: unknown, path: readonly string[]): unknown {
  let cursor: unknown = json;
  for (const key of path) {
    if (!isPlainObject(cursor) || !(key in cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function comparable(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

function jsonEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function matchesFilter(
  actual: unknown,
  filter: Record<string, unknown>,
): boolean {
  // Prisma's JSON path filter: { path: [...], equals }. A missing key is
  // never equal to anything (Prisma yields no row, not a match on null).
  if ("path" in filter) {
    const path = filter.path;
    if (!Array.isArray(path) || !path.every((p) => typeof p === "string")) {
      throw new Error("fake where: JSON path must be a string array");
    }
    const found = readPath(actual, path as string[]);
    if (found === undefined) return false;
    if (!("equals" in filter)) {
      throw new Error("fake where: JSON path filter without equals");
    }
    return jsonEquals(found, filter.equals);
  }
  for (const [op, expected] of Object.entries(filter)) {
    if (expected === undefined) continue;
    const a = comparable(actual);
    const e = comparable(expected);
    switch (op) {
      case "equals":
        if (a !== e) return false;
        break;
      case "not":
        if (a === e) return false;
        break;
      case "in":
        if (!Array.isArray(expected) || !expected.map(comparable).includes(a)) {
          return false;
        }
        break;
      case "notIn":
        if (Array.isArray(expected) && expected.map(comparable).includes(a)) {
          return false;
        }
        break;
      case "gte":
        if (typeof a !== "number" || typeof e !== "number" || !(a >= e))
          return false;
        break;
      case "gt":
        if (typeof a !== "number" || typeof e !== "number" || !(a > e))
          return false;
        break;
      case "lte":
        if (typeof a !== "number" || typeof e !== "number" || !(a <= e))
          return false;
        break;
      case "lt":
        if (typeof a !== "number" || typeof e !== "number" || !(a < e))
          return false;
        break;
      default:
        throw new Error(`fake where: unsupported operator "${op}"`);
    }
  }
  return true;
}

export function matchesWhere(row: Row, where: unknown): boolean {
  if (where === undefined) return true;
  if (!isPlainObject(where)) throw new Error("fake where: expected an object");
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue; // Prisma ignores undefined filters
    if (key === "AND" || key === "OR") {
      const list = Array.isArray(condition) ? condition : [condition];
      const results = list.map((c) => matchesWhere(row, c));
      if (key === "AND" ? !results.every(Boolean) : !results.some(Boolean)) {
        return false;
      }
      continue;
    }
    if (key === "NOT") {
      const list = Array.isArray(condition) ? condition : [condition];
      if (list.some((c) => matchesWhere(row, c))) return false;
      continue;
    }
    const actual = row[key];
    if (condition === null) {
      if (actual !== null && actual !== undefined) return false;
    } else if (isPlainObject(condition)) {
      if (!matchesFilter(actual, condition)) return false;
    } else if (comparable(actual) !== comparable(condition)) {
      return false;
    }
  }
  return true;
}

type OrderBy = Record<string, "asc" | "desc">;

// Ties keep insertion order, except that under a leading "desc" the newer
// insert wins (two rows created at the same instant: the later one is
// "latest", like an autoincrementing createdAt would make it).
export function sortRows(rows: readonly Row[], orderBy: unknown): Row[] {
  const clauses: OrderBy[] = Array.isArray(orderBy)
    ? (orderBy as OrderBy[])
    : orderBy === undefined
      ? []
      : [orderBy as OrderBy];
  const newestFirst = Object.values(clauses[0] ?? {})[0] === "desc";
  const indexed = rows.map((row, index) => ({ row, index }));
  indexed.sort((x, y) => {
    for (const clause of clauses) {
      for (const [key, dir] of Object.entries(clause)) {
        const a = comparable(x.row[key]);
        const b = comparable(y.row[key]);
        if (a === b) continue;
        const cmp = (a as number | string) < (b as number | string) ? -1 : 1;
        return dir === "desc" ? -cmp : cmp;
      }
    }
    return newestFirst ? y.index - x.index : x.index - y.index;
  });
  return indexed.map((entry) => entry.row);
}

// Prisma `select`: keep only the chosen scalar columns.
export function project(row: Row, select: unknown): Row {
  if (select === undefined) return cloneRow(row);
  if (!isPlainObject(select))
    throw new Error("fake select: expected an object");
  const out: Row = {};
  for (const [key, on] of Object.entries(select)) {
    if (on === true) out[key] = structuredClone(row[key] ?? null);
  }
  return out;
}

export function uniqueViolation(): Error {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
  });
}

export function recordNotFound(): Error {
  return Object.assign(new Error("Record to update not found."), {
    code: "P2025",
  });
}
