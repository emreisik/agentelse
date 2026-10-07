import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Onay kapısı taraması (docs/search-content-plan.md "Slotlar ve takvim"):
// aylık SEO planının kodu (src/server/seo/content-plan, src/lib/seo/content-plan,
// src/components/search-content-plan, sohbet araçları) hiçbir parçayı
// APPROVED yapamaz, Post.approvedAt dolduramaz, CreativeVersion üretemez ve
// Telegram'a dokunamaz. Makale ancak mevcut SEO Manager Review → Deliver
// yolundan (src/server/modules/seo/calendar.ts placeSeoArticle) onaylanır; orası
// bu klasörlerin dışındadır ve onaylayan tek yerdir. Tarama YORUMLARI atar ve
// yalnız YAZMA kalıplarına bakar: "APPROVED" sözcüğünün salt okunur anılması
// (tip birlikleri, karşılaştırmalar) serbesttir.

const ROOT = path.resolve(__dirname, "../../../..");

const SCAN_DIRS = [
  "src/server/seo/content-plan",
  "src/lib/seo/content-plan",
  "src/components/search-content-plan",
];
const SCAN_FILES = ["src/server/chat/search-content-tools.ts"];

const WRITE_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "status APPROVED write", pattern: /status:\s*["']APPROVED["']/ },
  { name: "approvedAt write", pattern: /approvedAt\s*:/ },
  {
    name: "creativeVersion write",
    pattern: /creativeVersion\.(create|createMany|upsert)/,
  },
  { name: "tx.creativeVersion", pattern: /tx\.creativeVersion/ },
  { name: "currentVersionId", pattern: /currentVersionId/ },
  { name: "ApprovalRepository", pattern: /ApprovalRepository/ },
  {
    name: "telegram import",
    pattern: /(?:\bfrom\s*|\bimport\s*\(?\s*)["'][^"']*telegram[^"']*["']/i,
  },
];

// Dizgeleri koruyup // ve /* */ yorumlarını atar ("https://" gibi dizgelerin
// içindeki // yorum sayılmaz).
export function stripComments(source: string): string {
  return source.replace(
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (_match, literal: string | undefined) => literal ?? "",
  );
}

function sourceFilesIn(dir: string): string[] {
  const absolute = path.join(ROOT, dir);
  if (!existsSync(absolute)) return [];
  const out: string[] = [];
  for (const name of readdirSync(absolute)) {
    const full = path.join(absolute, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFilesIn(path.join(dir, name)));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(path.join(dir, name));
    }
  }
  return out;
}

function scannedFiles(): string[] {
  return [
    ...SCAN_DIRS.flatMap((dir) => sourceFilesIn(dir)),
    ...SCAN_FILES.filter((file) => existsSync(path.join(ROOT, file))),
  ];
}

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8");
}

describe("the scan itself", () => {
  it("drops comments but keeps string literals", () => {
    const stripped = stripComments(
      [
        '// status: "APPROVED"',
        "/* approvedAt: new Date() */",
        'const url = "https://example.com/a"; const ok = 1;',
        "const x = { approvedAt: now };",
      ].join("\n"),
    );
    expect(stripped).not.toMatch(/status:\s*["']APPROVED["']/);
    expect(stripped).toContain("https://example.com/a");
    expect(stripped).toContain("approvedAt: now");
  });

  it("flags every write pattern in a synthetic source", () => {
    const bad: Record<string, string> = {
      "status APPROVED write": 'update({ data: { status: "APPROVED" } })',
      "approvedAt write": "update({ data: { approvedAt: new Date() } })",
      "creativeVersion write": "await prisma.creativeVersion.create({})",
      "tx.creativeVersion": "tx.creativeVersion.findFirst()",
      currentVersionId: "data: { currentVersionId: id }",
      ApprovalRepository: "ApprovalRepository.approve(id)",
      "telegram import": 'import { send } from "@/server/Telegram/bot";',
    };
    for (const { name, pattern } of WRITE_PATTERNS) {
      expect(pattern.test(bad[name] ?? ""), name).toBe(true);
    }
  });

  it("lets read-only mentions of APPROVED through", () => {
    const readOnly = [
      'type S = "DRAFT" | "APPROVED" | "PUBLISHED";',
      'const done = creative.status === "APPROVED";',
      'if (status === "APPROVED") return "Scheduled";',
    ].join("\n");
    for (const { name, pattern } of WRITE_PATTERNS) {
      expect(pattern.test(readOnly), name).toBe(false);
    }
  });

  it("scans at least this package's own files", () => {
    const files = scannedFiles();
    expect(files).toContain("src/server/seo/content-plan/forget.ts");
    expect(files).toContain("src/server/seo/content-plan/pieces.ts");
    expect(files.some((file) => /\.test\./.test(file))).toBe(false);
  });
});

describe("the review gate", () => {
  it("no non-test source of the content plan writes approval, versions or Telegram", () => {
    const violations: string[] = [];
    for (const file of scannedFiles()) {
      const code = stripComments(read(file));
      for (const { name, pattern } of WRITE_PATTERNS) {
        if (pattern.test(code)) violations.push(`${file}: ${name}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("pieces.ts writes only the statuses DRAFT and ARCHIVED", () => {
    const code = stripComments(read("src/server/seo/content-plan/pieces.ts"));
    const written = [...code.matchAll(/\bstatus:\s*["']([A-Z_]+)["']/g)].map(
      (match) => match[1],
    );
    expect(written.length).toBeGreaterThan(0);
    for (const status of written) {
      expect(["DRAFT", "ARCHIVED"]).toContain(status);
    }
  });

  it("calendar.ts is the single approving place and only after a version", () => {
    const code = stripComments(read("src/server/modules/seo/calendar.ts"));
    expect(code.match(/status:\s*["']APPROVED["']/g)).toHaveLength(1);
    expect(code.match(/tx\.creativeVersion\.create/g)).toHaveLength(1);
    expect(code.indexOf("tx.creativeVersion.create")).toBeLessThan(
      code.indexOf('status: "APPROVED"'),
    );
  });
});
