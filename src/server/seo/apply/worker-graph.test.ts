import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// SC-F8 işçi grafiği koruması: tick'te koşan uygulama motoru (seo-apply.ts,
// reconcile.ts) ve GEO koşucusu (geo/runner.ts) çözümleme bağlamında
// tenant-context, next-auth, next/navigation ya da react `cache` içe aktaran
// hiçbir dosyaya ulaşmamalı: bunlar işçi sürecine istek bağlamı (cookie,
// oturum) çeker ve tick'te patlar. Rol denetimi roles.ts'teki satır içi prisma
// sorgusudur; requireUser/isWorkspaceManager yalnız sunucu eylemlerinde ve
// sayfalarda kullanılır. Tür içe aktarmaları çalışma zamanında silinir ve
// sayılmaz.

const SRC = fileURLToPath(new URL("../../../", import.meta.url));

const ENTRIES = [
  "server/seo/apply/seo-apply.ts",
  "server/seo/apply/reconcile.ts",
  "server/seo/geo/runner.ts",
];

type Edge = { specifier: string; names: string | null };

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

// Çalışma zamanında var olan içe aktarmalar: `import type`, `export type` ve
// yalnız `type` belirteçli süslü listeler ayıklanır.
export function runtimeImports(source: string): Edge[] {
  const text = stripComments(source);
  const edges: Edge[] = [];

  const staticPattern =
    /(^|[\n;])\s*(import|export)\s+(type\s+)?([^"';]*?)\s*from\s*["']([^"']+)["']/g;
  for (const match of text.matchAll(staticPattern)) {
    const [, , , typeOnly, clause, specifier] = match;
    if (typeOnly || !specifier) continue;
    const braces = /\{([^}]*)\}/.exec(clause ?? "");
    const hasDefaultOrNamespace = /^\s*(\*|[A-Za-z_$][\w$]*\s*(,|$))/.test(
      (clause ?? "").replace(/\{[^}]*\}/, "").trim() || "",
    );
    if (braces && !hasDefaultOrNamespace) {
      const names = braces[1]!
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      if (names.length > 0 && names.every((name) => name.startsWith("type "))) {
        continue;
      }
    }
    edges.push({ specifier, names: braces ? braces[1]!.trim() : null });
  }

  for (const match of text.matchAll(/(^|[\n;])\s*import\s*["']([^"']+)["']/g)) {
    if (match[2]) edges.push({ specifier: match[2], names: null });
  }
  for (const match of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
    if (match[1]) edges.push({ specifier: match[1], names: null });
  }
  return edges;
}

function resolveInternal(specifier: string, from: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
  else return null;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (/\.(ts|tsx)$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

function bannedReason(edge: Edge): string | null {
  const { specifier, names } = edge;
  if (specifier === "next-auth" || specifier.startsWith("next-auth/")) {
    return "next-auth";
  }
  if (specifier === "next/navigation") return "next/navigation";
  if (specifier === "@/server/security/tenant-context") return "tenant-context";
  if (specifier === "react" && names && /\bcache\b/.test(names)) {
    return "react cache";
  }
  return null;
}

function rel(file: string): string {
  return path.relative(SRC, file).split(path.sep).join("/");
}

// Giriş dosyasından başlayan statik içe aktarma kapanışını gezer; ihlal bulursa
// zinciri döndürür.
export function findViolation(entry: string): string | null {
  const parents = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    const source = readFileSync(file, "utf8");
    for (const edge of runtimeImports(source)) {
      const reason = bannedReason(edge);
      if (reason) {
        const chain: string[] = [];
        for (let node: string | null = file; node; node = parents.get(node) ?? null) {
          chain.unshift(rel(node));
        }
        return `${chain.join(" -> ")} -> ${reason}`;
      }
      const next = resolveInternal(edge.specifier, file);
      if (next && !parents.has(next)) {
        parents.set(next, file);
        queue.push(next);
      }
    }
  }
  return null;
}

describe("guard helpers", () => {
  it("collects runtime imports and skips type-only ones", () => {
    const source = `
      import "server-only";
      import { a } from "@/lib/a";
      import type { B } from "@/lib/b";
      import { type C, type D } from "@/lib/c";
      import { type E, f } from "@/lib/e";
      import def, { type G } from "@/lib/g";
      export { h } from "./h";
      export type { I } from "./i";
      // import { z } from "@/lib/commented";
      const lazy = () => import("@/lib/lazy");
    `;
    expect(runtimeImports(source).map((edge) => edge.specifier).sort()).toEqual(
      ["./h", "@/lib/a", "@/lib/e", "@/lib/g", "@/lib/lazy", "server-only"].sort(),
    );
  });

  it("flags tenant-context, next-auth, next/navigation and react cache", () => {
    const reasons = [
      { specifier: "@/server/security/tenant-context", names: null },
      { specifier: "next-auth", names: null },
      { specifier: "next-auth/react", names: null },
      { specifier: "next/navigation", names: "redirect" },
      { specifier: "react", names: "cache, useState" },
    ].map(bannedReason);
    expect(reasons).toEqual([
      "tenant-context",
      "next-auth",
      "next-auth",
      "next/navigation",
      "react cache",
    ]);
    expect(bannedReason({ specifier: "react", names: "useState" })).toBeNull();
    expect(bannedReason({ specifier: "@/lib/prisma", names: null })).toBeNull();
  });
});

describe("worker graph", () => {
  it.each(ENTRIES)("%s exists", (entry) => {
    expect(existsSync(path.join(SRC, entry))).toBe(true);
  });

  it.each(ENTRIES)(
    "%s never reaches tenant-context, next-auth, next/navigation or react cache",
    (entry) => {
      const file = path.join(SRC, entry);
      if (!existsSync(file)) return;
      expect(findViolation(file)).toBeNull();
    },
  );

  it("the walk really goes deep (guards against a resolver that finds nothing)", () => {
    const entry = path.join(SRC, "server/seo/apply/reconcile.ts");
    const seen = new Set<string>([entry]);
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.shift()!;
      for (const edge of runtimeImports(readFileSync(file, "utf8"))) {
        const next = resolveInternal(edge.specifier, file);
        if (next && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    const names = [...seen].map(rel);
    expect(names).toContain("server/seo/apply/apply.ts");
    expect(names).toContain("server/seo/apply/rate.ts");
    expect(names.length).toBeGreaterThan(20);
  });
});
