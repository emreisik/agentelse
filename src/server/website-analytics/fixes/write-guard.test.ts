import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// GA-F7 yazma korkuluğu (statik): Google Analytics'e yazan her yol tek bir
// yerden geçer.
//  (a) GaAdminWriter'ın değiştiren üyelerine (create*/update*/delete*) yalnız
//      apply.ts ve undo.ts dokunur (test ve mock dosyaları hariç);
//  (b) admin-write modülünü fixes klasörü ve P2 dosyaları dışında kimse
//      içe aktarmaz;
//  (c) değişim geçmişi izleyicisi (change-watch.ts) yalnız okuma üyelerini
//      kullanır: searchChangeHistory, listKeyEvents, getDataRetention.

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
const FIXES_DIR = path.join(SRC, "server/website-analytics/fixes");
const ADMIN_DIR = path.join(SRC, "server/integrations/google-analytics");

const MUTATING_MEMBERS = [
  "createKeyEvent",
  "deleteKeyEvent",
  "updateDataRetention",
  "updateEnhancedMeasurement",
  "createChannelGroup",
  "deleteChannelGroup",
  "createAnnotation",
  "deleteAnnotation",
] as const;
const READ_MEMBERS = [
  "listKeyEvents",
  "getDataRetention",
  "getEnhancedMeasurement",
  "listChannelGroups",
  "listAnnotations",
  "searchChangeHistory",
] as const;
const WATCH_ALLOWED = [
  "searchChangeHistory",
  "listKeyEvents",
  "getDataRetention",
];

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
  }
  return files;
}

// Satır ve blok yorumları ayıklanır: yorumda geçen ad ihlal sayılmaz.
// "https://" gibi dizgeler (önünde boşluk yok) korunur.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

// `x.createKeyEvent` biçimindeki üye erişimi; "createKeyEvent" dizgesi (plan
// işlem adı) üye erişimi değildir.
function memberAccesses(
  source: string,
  members: readonly string[],
): string[] {
  const pattern = new RegExp(`\\.\\s*(${members.join("|")})\\b`, "g");
  const found = new Set<string>();
  for (const match of stripComments(source).matchAll(pattern)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

function rel(file: string): string {
  return path.relative(SRC, file).split(path.sep).join("/");
}

function isTestOrMock(file: string): boolean {
  const name = path.basename(file);
  return (
    /\.test\.tsx?$/.test(name) ||
    /\.fixtures\.ts$/.test(name) ||
    (path.dirname(file) === ADMIN_DIR && name.startsWith("admin-write"))
  );
}

const SOURCES = walk(SRC);

describe("guard helpers", () => {
  it("detects member access but not strings or comments", () => {
    expect(
      memberAccesses("await writer.createKeyEvent(id, n)", MUTATING_MEMBERS),
    ).toEqual(["createKeyEvent"]);
    expect(
      memberAccesses(
        "const f = deps.writer?.deleteAnnotation",
        MUTATING_MEMBERS,
      ),
    ).toEqual(["deleteAnnotation"]);
    expect(
      memberAccesses('{ op: "createKeyEvent" }', MUTATING_MEMBERS),
    ).toEqual([]);
    expect(
      memberAccesses("// writer.createKeyEvent(x)", MUTATING_MEMBERS),
    ).toEqual([]);
    expect(
      memberAccesses("/* writer.updateDataRetention() */", MUTATING_MEMBERS),
    ).toEqual([]);
    expect(
      memberAccesses(
        'const url = "https://a.b"; writer.createAnnotation()',
        MUTATING_MEMBERS,
      ),
    ).toEqual(["createAnnotation"]);
  });

  it("scans a meaningful number of source files", () => {
    expect(SOURCES.length).toBeGreaterThan(500);
  });
});

describe("(a) yalnız apply.ts ve undo.ts yazar", () => {
  it("references the mutating writer members only in apply.ts and undo.ts", () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      if (isTestOrMock(file)) continue;
      const used = memberAccesses(readFileSync(file, "utf8"), MUTATING_MEMBERS);
      if (used.length === 0) continue;
      if (file === path.join(FIXES_DIR, "apply.ts")) continue;
      if (file === path.join(FIXES_DIR, "undo.ts")) continue;
      offenders.push(`${rel(file)}: ${used.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("apply.ts and undo.ts do write (the guard is looking at the right files)", () => {
    const apply = readFileSync(path.join(FIXES_DIR, "apply.ts"), "utf8");
    const undo = readFileSync(path.join(FIXES_DIR, "undo.ts"), "utf8");
    expect(memberAccesses(apply, MUTATING_MEMBERS).length).toBeGreaterThan(0);
    expect(memberAccesses(undo, MUTATING_MEMBERS).length).toBeGreaterThan(0);
  });
});

describe("(b) admin-write'ı kim içe aktarır", () => {
  it("is imported only by the fixes folder and the P2 files", () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      const inFixes = file.startsWith(`${FIXES_DIR}${path.sep}`);
      const isP2 =
        path.dirname(file) === ADMIN_DIR &&
        path.basename(file).startsWith("admin-write");
      if (inFixes || isP2) continue;
      const source = stripComments(readFileSync(file, "utf8"));
      if (/google-analytics\/admin-write|["']\.\/admin-write/.test(source)) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("(c) değişim geçmişi izleyicisi salt okunur", () => {
  it("uses only searchChangeHistory, listKeyEvents and getDataRetention", () => {
    const file = path.join(FIXES_DIR, "change-watch.ts");
    const source = readFileSync(file, "utf8");
    expect(memberAccesses(source, MUTATING_MEMBERS)).toEqual([]);
    const used = memberAccesses(source, [...READ_MEMBERS, ...MUTATING_MEMBERS]);
    expect(used.length).toBeGreaterThan(0);
    for (const member of used) expect(WATCH_ALLOWED).toContain(member);
  });
});
