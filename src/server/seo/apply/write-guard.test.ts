import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { seedMockWordPress } from "@/server/integrations/wordpress/mock-site";

import { applySeoChange } from "./apply";
import {
  ENV_KEYS,
  NOW,
  ORIGIN,
  addChange,
  change,
  fake,
  freshWordPress,
  liveParams,
  makeClient,
  resetFake,
  resetGate,
  titleMetaParams,
} from "./apply.testkit";

// SC-F8 "onaysız siteye yazı yok" kanıtı.
//  (a) statik: istemcinin yazan üyelerine (createPost, updateObject,
//      trashObject, rankMathUpdateMeta) yalnız apply.ts ve undo.ts dokunur
//      (istemci, sahte site ve testler hariç); öneri (propose.ts) hiçbir yazan
//      üyeye değmez; toplu onay yolları Task onaylarını dışlar (entityType
//      "Creative");
//  (b) davranış: applySeoChange, satır PROPOSED iken, approvalId yokken ya da
//      Approval PENDING / REJECTED / EXPIRED / CANCELLED iken yazıcıyı HİÇ
//      çağırmaz; yalnız APPROVED onay satırı yazdırır.
// MEMBER-onaylayamaz ve Telegram kanıtları kabuk (shared edit) testlerindedir.

vi.mock("@/lib/prisma", async () => ({
  prisma: (await import("./apply.testkit")).fakePrisma,
}));
vi.mock("./site", async () => ({
  gateApplySite: (await import("./apply.testkit")).fakeGate,
}));
vi.mock("./audit", () => ({
  recordSeoApplyAudit: vi.fn(async () => undefined),
}));
vi.mock("./action-link", () => ({
  onChangeVerified: vi.fn(async () => undefined),
  onChangeUndone: vi.fn(async () => undefined),
}));
vi.mock("./indexnow", () => ({
  isIndexNowReady: vi.fn(async () => false),
}));
vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: { transition: vi.fn(async () => ({})) },
}));

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
const APPLY_DIR = path.join(SRC, "server/seo/apply");
const WP_DIR = path.join(SRC, "server/integrations/wordpress");

const WRITE_MEMBERS = [
  "createPost",
  "updateObject",
  "trashObject",
  "rankMathUpdateMeta",
] as const;

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

function memberAccesses(source: string, members: readonly string[]): string[] {
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

// İstemcinin kendisi, sahte site ve testler yazan üyeleri tanımlar/çağırır.
function isExempt(file: string): boolean {
  const name = path.basename(file);
  if (/\.test\.tsx?$/.test(name) || /\.testkit\.ts$/.test(name)) return true;
  return (
    path.dirname(file) === WP_DIR &&
    (name === "client.ts" || name === "mock-site.ts")
  );
}

const SOURCES = walk(SRC);

describe("guard helpers", () => {
  it("detects member access but not strings or comments", () => {
    expect(memberAccesses("await client.createPost(b)", WRITE_MEMBERS)).toEqual([
      "createPost",
    ]);
    expect(
      memberAccesses("const f = deps.client?.trashObject", WRITE_MEMBERS),
    ).toEqual(["trashObject"]);
    expect(memberAccesses('{ op: "rankMathMeta" }', WRITE_MEMBERS)).toEqual([]);
    expect(memberAccesses("// client.updateObject(x)", WRITE_MEMBERS)).toEqual([]);
    expect(memberAccesses("/* client.createPost() */", WRITE_MEMBERS)).toEqual([]);
    expect(
      memberAccesses(
        'const u = "https://a.b"; client.rankMathUpdateMeta(1, {})',
        WRITE_MEMBERS,
      ),
    ).toEqual(["rankMathUpdateMeta"]);
  });

  it("scans a meaningful number of source files", () => {
    expect(SOURCES.length).toBeGreaterThan(500);
  });
});

describe("(a) yalnız apply.ts ve undo.ts siteye yazar", () => {
  it("references the writing client members only in apply.ts and undo.ts", () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      if (isExempt(file)) continue;
      const used = memberAccesses(readFileSync(file, "utf8"), WRITE_MEMBERS);
      if (used.length === 0) continue;
      if (file === path.join(APPLY_DIR, "apply.ts")) continue;
      if (file === path.join(APPLY_DIR, "undo.ts")) continue;
      offenders.push(`${rel(file)}: ${used.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("apply.ts and undo.ts do write (the guard is looking at the right files)", () => {
    const apply = readFileSync(path.join(APPLY_DIR, "apply.ts"), "utf8");
    const undo = readFileSync(path.join(APPLY_DIR, "undo.ts"), "utf8");
    expect(memberAccesses(apply, WRITE_MEMBERS).length).toBeGreaterThan(0);
    expect(memberAccesses(undo, WRITE_MEMBERS).length).toBeGreaterThan(0);
  });

  it("propose never touches a writing member", () => {
    const file = path.join(APPLY_DIR, "propose.ts");
    expect(memberAccesses(readFileSync(file, "utf8"), WRITE_MEMBERS)).toEqual([]);
  });

  it("the bulk approval paths only touch Creative approvals, never Task approvals", () => {
    for (const name of [
      "server/actions/plan-progress-actions.ts",
      "server/actions/work-approve-actions.ts",
    ]) {
      const source = stripComments(readFileSync(path.join(SRC, name), "utf8"));
      expect(source).toMatch(/entityType:\s*"Creative"/);
      expect(source).not.toMatch(/CRITICAL_CHANGE_APPROVAL/);
      expect(source).not.toMatch(/entityType:\s*"Task"/);
    }
  });
});

const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SEO_APPLY = "true";
  process.env.SEO_HEALTH = "true";
  process.env.AGENTELSE_PROVIDER_MODE = "mock";
  delete process.env.SEO_DEV_PROJECTS;
  delete process.env.SEO_ROLLOUT_PROJECTS;
  freshWordPress();
  resetGate();
  resetFake({ change: null });
});

describe("(b) applySeoChange never writes without an APPROVED approval", () => {
  async function run(): Promise<{ state: string; writes: string[] }> {
    const { client, writes } = makeClient();
    const result = await applySeoChange("chg-1", { client, now: NOW, mock: true });
    return { state: result.state, writes };
  }

  it("writes nothing while the change is PROPOSED", async () => {
    addChange({ status: "PROPOSED", params: titleMetaParams() });
    fake.approval = { id: "appr-1", status: "APPROVED", expiresAt: null };
    const { state, writes } = await run();
    expect(state).toBe("skipped");
    expect(writes).toEqual([]);
    expect(change().status).toBe("PROPOSED");
  });

  it("writes nothing without an approval id", async () => {
    addChange({ params: titleMetaParams(), approvalId: null });
    const { writes } = await run();
    expect(writes).toEqual([]);
    expect(change().status).toBe("FAILED");
  });

  it.each(["PENDING", "REJECTED", "EXPIRED", "CANCELLED", "REVISION_REQUESTED"])(
    "writes nothing while the Approval is %s",
    async (status) => {
      addChange({ params: titleMetaParams() });
      fake.approval = { id: "appr-1", status, expiresAt: null };
      const { writes } = await run();
      expect(writes).toEqual([]);
      expect(change().status).toBe("FAILED");
      expect((change().error as { code: string }).code).toBe("approval_missing");
    },
  );

  it("writes nothing for every kind when the approval is missing", async () => {
    seedMockWordPress(ORIGIN, {
      objects: [{ id: 250, type: "post", status: "draft", title: "Draft" }],
    });
    const params = [
      titleMetaParams(),
      liveParams({ wpId: 250 }),
      {
        kind: "INTERNAL_LINKS",
        url: `${ORIGIN}/pricing`,
        wpType: "page",
        wpId: 101,
        expectModified: "2026-09-20T10:00:00Z",
        links: [{ toUrl: `${ORIGIN}/about`, anchor: "pricing plans" }],
      },
    ];
    for (const [index, item] of params.entries()) {
      const id = `chg-${index}`;
      addChange({ id, params: item, approvalId: "appr-gone" });
      fake.approvals.set("appr-gone", {
        id: "appr-gone",
        status: "PENDING",
        expiresAt: null,
      });
      const { client, writes } = makeClient();
      await applySeoChange(id, { client, now: NOW, mock: true });
      expect(writes).toEqual([]);
    }
  });

  it("writes only for an APPROVED approval", async () => {
    addChange({ params: titleMetaParams() });
    const { state, writes } = await run();
    expect(state).toBe("verified");
    expect(writes).toEqual(["updateObject"]);
  });
});
