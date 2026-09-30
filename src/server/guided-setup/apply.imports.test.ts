import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Guard G35: Approve is persistence plus audit plus receipt. Publishing,
// spending, autonomy, connecting accounts, deep research and saving ideas are
// separate explicit consents, so the apply module (and the writers it calls)
// must not even be able to reach them. This reads the source and checks every
// import specifier; a comment mentioning a module does not count, an added
// import does.

const ROOT = path.resolve(__dirname, "../../..");
const DIR = "src/server/guided-setup";

// The "act" worlds, as path fragments of the RESOLVED import.
const ACT_WORLDS = [
  "goal-engine",
  "autonomy-policy.repository",
  "strategic-request",
  "agency-setup-actions",
  "publish-schedule-actions",
  "agency-config-actions",
  "src/server/integrations/",
  "src/server/execution/",
  "command-service",
  "task-planner",
  "capability-input",
  "needs-input",
  "goal-mode",
] as const;

// The rest of the feature's server modules may read the goal mode and the
// channel connections (service.ts does), but none may reach the machinery that
// acts on a goal or a request.
const SERVICE_SIDE = [
  "goal-engine",
  "strategic-request",
  "agency-setup-actions",
  "publish-schedule-actions",
  "agency-config-actions",
  "command-service",
  "task-planner",
] as const;

// Every module specifier of import / export-from / dynamic import / require.
function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\b(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']/g,
    /^\s*import\s*["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) found.push(match[1]);
    }
  }
  return found;
}

// "@/x" -> "src/x"; "./x" -> relative to the importing file's directory.
function resolved(specifier: string, fromDir: string): string {
  if (specifier.startsWith("@/")) return `src/${specifier.slice(2)}`;
  if (specifier.startsWith(".")) {
    return path.posix.normalize(path.posix.join(fromDir, specifier));
  }
  return specifier;
}

function violations(
  source: string,
  fromDir: string,
  fragments: readonly string[],
): string[] {
  return importSpecifiers(source)
    .map((specifier) => ({ specifier, target: resolved(specifier, fromDir) }))
    .filter(({ target }) =>
      fragments.some((fragment) => target.includes(fragment)),
    )
    .map(({ specifier }) => specifier);
}

const read = (relative: string) =>
  readFileSync(path.join(ROOT, relative), "utf8");

describe("the import scanner itself", () => {
  it("finds every import form", () => {
    const source = [
      'import "server-only";',
      'import { a } from "@/lib/a";',
      'import type { B } from "./b";',
      "import {",
      "  c,",
      "  d,",
      '} from "../c";',
      'export { e } from "@/lib/e";',
      'const f = await import("@/lib/f");',
      'const g = require("g");',
    ].join("\n");
    expect(importSpecifiers(source).sort()).toEqual(
      [
        "./b",
        "../c",
        "@/lib/a",
        "@/lib/e",
        "@/lib/f",
        "g",
        "server-only",
      ].sort(),
    );
  });

  it("ignores prose that only mentions a module", () => {
    expect(importSpecifiers("// the goal engine is not imported here")).toEqual(
      [],
    );
    expect(importSpecifiers('const note = "goal-engine";')).toEqual([]);
  });

  it("flags each act world, absolute or relative", () => {
    const cases: [string, string][] = [
      ['import { G } from "@/server/agency/goals/goal-engine";', "goal-engine"],
      [
        'import { A } from "@/server/repositories/autonomy-policy.repository";',
        "autonomy-policy.repository",
      ],
      [
        'import { s } from "@/server/commands/strategic-request";',
        "strategic-request",
      ],
      [
        'import { s } from "@/server/actions/agency-setup-actions";',
        "agency-setup-actions",
      ],
      [
        'import { s } from "@/server/actions/publish-schedule-actions";',
        "publish-schedule-actions",
      ],
      [
        'import { s } from "@/server/actions/agency-config-actions";',
        "agency-config-actions",
      ],
      [
        'import { c } from "@/server/integrations/channel-connections";',
        "integrations",
      ],
      ['import { e } from "@/server/execution/run";', "execution"],
      [
        'import { c } from "@/server/commands/command-service";',
        "command-service",
      ],
      ['import { t } from "@/server/tasks/task-planner";', "task-planner"],
      ['import { c } from "@/server/x/capability-input";', "capability-input"],
      ['import { n } from "@/server/x/needs-input";', "needs-input"],
      ['import { g } from "./goal-mode";', "goal-mode"],
      [
        'import { c } from "../integrations/channel-connections";',
        "integrations",
      ],
    ];
    for (const [source, label] of cases) {
      expect(violations(source, DIR, ACT_WORLDS), label).toHaveLength(1);
    }
  });

  it("does not flag the imports apply.ts is allowed to have", () => {
    const source = [
      'import { prisma } from "@/lib/prisma";',
      'import { AuditLogRepository } from "@/server/repositories/audit-log.repository";',
      'import { readSession } from "./store";',
      'import { ensureUserGoal } from "./writers";',
      'import { ConstitutionService } from "@/server/agency/constitution/constitution-service";',
    ].join("\n");
    expect(violations(source, DIR, ACT_WORLDS)).toEqual([]);
  });
});

describe("guard G35: what the apply module can reach", () => {
  for (const file of ["apply.ts", "writers.ts"]) {
    it(`${file} imports none of the act worlds`, () => {
      expect(violations(read(`${DIR}/${file}`), DIR, ACT_WORLDS)).toEqual([]);
    });
  }

  for (const file of ["service.ts", "store.ts", "limits.ts"]) {
    it(`${file} imports no goal engine, request planner or action module`, () => {
      expect(violations(read(`${DIR}/${file}`), DIR, SERVICE_SIDE)).toEqual([]);
    });
  }

  it("the scanned files exist and actually import things", () => {
    for (const file of [
      "apply.ts",
      "writers.ts",
      "service.ts",
      "store.ts",
      "limits.ts",
    ]) {
      expect(importSpecifiers(read(`${DIR}/${file}`)).length).toBeGreaterThan(
        2,
      );
    }
  });
});
