// A Prisma stand-in that only lets through an explicit (model, operation)
// allow-list, for the guided-setup apply guards (G34/G58): a new write to a
// model outside the map, another operation on an allowed model
// (`project.update`, `brand.update`) or any raw SQL throws instead of passing
// silently. Every attempt is recorded in `calls`, so the OBSERVED operation
// set of a full apply can be pinned with toEqual and a new write shows as a
// diff.
//
// Allowed operations answer with permissive generic fakes unless `overrides`
// supplies a model (the command fake / audit fake): the override wins for its
// model, the operation allow-list still applies to it.

export type AllowedOps = Readonly<Record<string, readonly string[]>>;

// What a DONE apply may touch. `ensureProjectActive`, channel connections and
// goal mode are injected by the tests, so their reads and writes are not here.
export const APPLY_ALLOWED_OPS: AllowedOps = {
  project: ["findUnique"],
  brand: ["findUnique", "findFirst"],
  brandDossier: ["findUnique", "create", "update", "upsert"],
  brandConstitution: ["findFirst", "create", "updateMany", "update"],
  brandDecision: ["create"],
  brandEvidence: ["createMany"],
  brandFact: ["deleteMany", "createMany"],
  brandAssumption: ["deleteMany", "findMany", "createMany"],
  approvedClaim: ["deleteMany", "findMany", "createMany"],
  negativeBriefRule: ["deleteMany", "findMany", "createMany", "create"],
  projectGoal: ["findMany", "findFirst", "createManyAndReturn", "update"],
  brandLearning: ["deleteMany", "findFirst", "create", "update"],
  command: ["create", "findUnique", "findFirst", "updateMany"],
  auditLog: ["create", "update", "count"],
};

const RAW_SQL_ENTRY_POINTS = [
  "$executeRaw",
  "$executeRawUnsafe",
  "$queryRaw",
  "$queryRawUnsafe",
] as const;

type Operation = (...args: unknown[]) => unknown;

export type AllowListPrisma = {
  $transaction: (input: unknown) => Promise<unknown>;
  [key: string]: unknown;
};

export type AllowListPrismaOptions = {
  allowed?: AllowedOps;
  overrides?: Record<string, object>;
};

function genericResult(operation: string): unknown {
  if (operation === "count") return 0;
  if (operation === "findMany" || operation === "createManyAndReturn") {
    return [];
  }
  if (operation.startsWith("find")) return null;
  if (
    operation === "createMany" ||
    operation === "updateMany" ||
    operation === "deleteMany"
  ) {
    return { count: 0 };
  }
  return { id: "x" };
}

export function makeAllowListPrisma(options: AllowListPrismaOptions = {}): {
  prisma: AllowListPrisma;
  calls: string[];
} {
  const allowed = options.allowed ?? APPLY_ALLOWED_OPS;
  const overrides = options.overrides ?? {};
  const calls: string[] = [];

  function modelProxy(model: string): object {
    return new Proxy(
      {},
      {
        get(_target, property) {
          if (typeof property !== "string") return undefined;
          // `then` must stay undefined or `await prisma.model` would hang.
          if (property === "then") return undefined;
          return (...args: unknown[]) => {
            const call = `${model}.${property}`;
            calls.push(call);
            if (!allowed[model]?.includes(property)) {
              throw new Error(`forbidden ${call}`);
            }
            const override = overrides[model];
            if (override) {
              const implementation: unknown = Reflect.get(override, property);
              if (typeof implementation !== "function") {
                throw new Error(`override for ${model} has no ${property}`);
              }
              return (implementation as Operation).apply(override, args);
            }
            return Promise.resolve(genericResult(property));
          };
        },
      },
    );
  }

  const proxies = new Map<string, object>();
  const root = {} as AllowListPrisma;
  const prisma: AllowListPrisma = new Proxy(root, {
    get(_target, property) {
      if (typeof property !== "string" || property === "then") return undefined;
      if ((RAW_SQL_ENTRY_POINTS as readonly string[]).includes(property)) {
        return () => {
          calls.push(property);
          throw new Error(`forbidden ${property}`);
        };
      }
      if (property === "$transaction") {
        return async (input: unknown) => {
          if (typeof input === "function") {
            return (input as (tx: unknown) => unknown)(prisma);
          }
          if (Array.isArray(input)) return Promise.all(input);
          throw new Error("allow-list prisma: unsupported $transaction input");
        };
      }
      let proxy = proxies.get(property);
      if (!proxy) {
        proxy = modelProxy(property);
        proxies.set(property, proxy);
      }
      return proxy;
    },
  });

  return { prisma, calls };
}

// The sorted unique "model.operation" set of what was called.
export function observedOps(calls: readonly string[]): string[] {
  return [...new Set(calls)].sort();
}
