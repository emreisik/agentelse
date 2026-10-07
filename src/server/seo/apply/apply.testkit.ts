import { Prisma } from "@prisma/client";
import { vi } from "vitest";

import { capabilityAllows } from "@/lib/seo/apply/wp/capabilities";
import type {
  SeoChangeErrorCode,
  SeoChangeKind,
  SeoFieldsCapability,
  WpCapabilities,
} from "@/lib/seo/apply/types";
import { changeFixture, siteFixture } from "@/lib/seo/apply/test-support";
import {
  createWordPressClient,
  type WordPressClient,
} from "@/server/integrations/wordpress/client";
import {
  createMockWpTransport,
  resetMockWordPress,
} from "@/server/integrations/wordpress/mock-site";

// apply.test.ts, undo.test.ts, write-guard.test.ts ortak test düzeneği (P4b1):
// SeoChange/CmsSite için bellek içi sahte Prisma, onay/Task/üye satırları, site
// kapısının (gateApplySite) ayarlanabilir sahtesi ve sahte WordPress'e konuşan
// gerçek istemci (yazan çağrıları sayan sarmalayıcıyla). Prisma'ya vi.spyOn
// yapılmaz; test dosyası "@/lib/prisma" modülünü bu sahteyle değiştirir.

type Row = Record<string, unknown>;

export const NOW = new Date("2026-09-20T10:05:00.000Z");
export const ORIGIN = "https://example.com";
// Sahte WordPress'in tohum nesnelerinin modified değeri (stamp(0) + 'Z').
export const BASE_MODIFIED = "2026-09-20T10:00:00Z";
const APP_PASSWORD = "abcd efgh ijkl mnop qrst uvwx";

export const YOAST_FIELDS: SeoFieldsCapability = {
  plugin: "YOAST",
  titleVia: "META",
  descriptionVia: "META",
  verifiable: true,
};
// Başlık yazı başlığından, açıklama Rank Math uç noktasından: iki yazmalı plan.
export const RANKMATH_SPLIT_FIELDS: SeoFieldsCapability = {
  plugin: "RANK_MATH",
  titleVia: "POST_TITLE",
  descriptionVia: "RANKMATH_ENDPOINT",
  verifiable: false,
};
export const ALL_CAPABILITIES: WpCapabilities = {
  draftPosts: true,
  publishPosts: true,
  editPublishedPosts: true,
  editPages: true,
  editPublishedPages: true,
  editOthers: true,
  deletePosts: true,
};

function isDate(value: unknown): value is Date {
  return value instanceof Date;
}

function same(a: unknown, b: unknown): boolean {
  if (isDate(a) && isDate(b)) return a.getTime() === b.getTime();
  return a === b;
}

function compare(a: unknown, b: unknown): number {
  const left = isDate(a) ? a.getTime() : Number(a);
  const right = isDate(b) ? b.getTime() : Number(b);
  return left - right;
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "AND") return (cond as Row[]).every((w) => matches(row, w));
    if (key === "OR") return (cond as Row[]).some((w) => matches(row, w));
    const value = row[key] ?? null;
    if (cond !== null && typeof cond === "object" && !isDate(cond)) {
      const ops = cond as Row;
      if ("in" in ops) return (ops.in as unknown[]).some((v) => same(v, value));
      if ("lt" in ops) return value !== null && compare(value, ops.lt) < 0;
      if ("lte" in ops) return value !== null && compare(value, ops.lte) <= 0;
      if ("gt" in ops) return value !== null && compare(value, ops.gt) > 0;
      if ("gte" in ops) return value !== null && compare(value, ops.gte) >= 0;
      if ("not" in ops) return !same(value, ops.not);
      if ("equals" in ops) return same(value, ops.equals);
      return false;
    }
    return same(value, cond);
  });
}

function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === "object" && "increment" in value) {
      row[key] = Number(row[key] ?? 0) + Number((value as Row).increment);
    } else if (
      value !== null &&
      typeof value === "object" &&
      "decrement" in value
    ) {
      row[key] = Number(row[key] ?? 0) - Number((value as Row).decrement);
    } else if (value === Prisma.DbNull) {
      row[key] = null;
    } else {
      row[key] = value;
    }
  }
}

export type FakeState = {
  changes: Map<string, Row>;
  site: Row;
  approval: Row | null;
  approvals: Map<string, Row>;
  task: Row | null;
  members: Map<string, string>;
  setting: Row | null;
  siteUpdates: Row[];
};

export const fake: FakeState = {
  changes: new Map(),
  site: {},
  approval: null,
  approvals: new Map(),
  task: null,
  members: new Map(),
  setting: null,
  siteUpdates: [],
};

export function makeSite(overrides: Row = {}): Row {
  return {
    ...siteFixture({
      id: "site-1",
      workspaceId: "ws-1",
      projectId: "proj-1",
      isMock: true,
      origin: ORIGIN,
      health: "OK",
    }),
    ...overrides,
  };
}

export function makeChange(overrides: Row = {}): Row {
  return {
    ...changeFixture({
      id: "chg-1",
      workspaceId: "ws-1",
      projectId: "proj-1",
      siteId: "site-1",
      isMock: true,
      status: "APPROVED",
      taskId: "task-1",
      approvalId: "appr-1",
      approvedByUserId: "owner-1",
      approvedAt: new Date("2026-09-20T09:00:00.000Z"),
      expiresAt: new Date("2026-09-27T09:00:00.000Z"),
    }),
    ...overrides,
  };
}

export function resetFake(
  options: { change?: Row | null; site?: Row } = {},
): void {
  fake.changes.clear();
  fake.site = makeSite(options.site);
  fake.approval = { id: "appr-1", status: "APPROVED", expiresAt: null };
  fake.approvals = new Map();
  fake.task = { id: "task-1", status: "RUNNING" };
  fake.members = new Map([
    ["ws-1:owner-1", "OWNER"],
    ["ws-1:member-1", "MEMBER"],
  ]);
  fake.setting = null;
  fake.siteUpdates = [];
  if (options.change !== null) {
    const change = makeChange(options.change);
    fake.changes.set(String(change.id), change);
  }
}

export function addChange(overrides: Row): Row {
  const change = makeChange(overrides);
  fake.changes.set(String(change.id), change);
  return change;
}

export function change(id = "chg-1"): Row {
  const row = fake.changes.get(id);
  if (!row) throw new Error(`no change ${id}`);
  return row;
}

function withSite(row: Row | undefined, args: Row): Row | null {
  if (!row) return null;
  const copy: Row = { ...row };
  if ((args.include as Row | undefined)?.site) copy.site = { ...fake.site };
  return copy;
}

export const fakePrisma = {
  seoChange: {
    findUnique: vi.fn(async (args: Row) => {
      const where = args.where as Row;
      return withSite(fake.changes.get(String(where.id)), args);
    }),
    findFirst: vi.fn(async (args: Row) => {
      const where = args.where as Row;
      const row = [...fake.changes.values()].find((item) =>
        matches(item, where),
      );
      return withSite(row, args);
    }),
    findMany: vi.fn(async (args: Row) => {
      const where = (args.where ?? {}) as Row;
      const rows = [...fake.changes.values()]
        .filter((item) => matches(item, where))
        .map((item) => ({ ...item }));
      const take = typeof args.take === "number" ? args.take : rows.length;
      return rows.slice(0, take);
    }),
    updateMany: vi.fn(async (args: Row) => {
      const where = args.where as Row;
      let count = 0;
      for (const row of fake.changes.values()) {
        if (!matches(row, where)) continue;
        applyData(row, args.data as Row);
        count += 1;
      }
      return { count };
    }),
  },
  approval: {
    findFirst: vi.fn(async (args: Row) => {
      const where = (args.where ?? {}) as Row;
      const byId = fake.approvals.get(String(where.id));
      if (byId) return { ...byId };
      return fake.approval ? { ...fake.approval } : null;
    }),
    findMany: vi.fn(async (args: Row) => {
      const where = (args.where ?? {}) as Row;
      const ids = ((where.id as Row | undefined)?.in ?? []) as string[];
      return ids.flatMap((id) => {
        const row = fake.approvals.get(id);
        return row ? [{ ...row }] : [];
      });
    }),
  },
  seoApplySetting: {
    findUnique: vi.fn(async () => (fake.setting ? { ...fake.setting } : null)),
  },
  cmsSite: {
    updateMany: vi.fn(async (args: Row) => {
      fake.siteUpdates.push(args.data as Row);
      applyData(fake.site, args.data as Row);
      return { count: 1 };
    }),
  },
  task: {
    findFirst: vi.fn(async () => (fake.task ? { ...fake.task } : null)),
  },
  workspaceMember: {
    findUnique: vi.fn(async (args: Row) => {
      const key = args.where as { workspaceId_userId: Row };
      const { workspaceId, userId } = key.workspaceId_userId;
      const role = fake.members.get(`${String(workspaceId)}:${String(userId)}`);
      return role ? { role } : null;
    }),
  },
};

// Site kapısının (P4a gateApplySite) ayarlanabilir sahtesi: hata kodu verilirse
// kapı düşer, yoksa fake.site ve verilen alanlarla açılır.
export const gateConfig: {
  fail: SeoChangeErrorCode | null;
  fields: SeoFieldsCapability;
  capabilities: WpCapabilities;
} = {
  fail: null,
  fields: YOAST_FIELDS,
  capabilities: ALL_CAPABILITIES,
};

export function resetGate(): void {
  gateConfig.fail = null;
  gateConfig.fields = YOAST_FIELDS;
  gateConfig.capabilities = ALL_CAPABILITIES;
}

export const fakeGate = vi.fn(
  async (
    _projectId: string,
    kind: SeoChangeKind,
    options: { wpType?: "post" | "page" | null } = {},
  ) => {
    if (gateConfig.fail) {
      return {
        ok: false as const,
        code: gateConfig.fail,
        refusal: "not_enabled" as const,
      };
    }
    if (
      !capabilityAllows(gateConfig.capabilities, kind, options.wpType ?? null)
    ) {
      return {
        ok: false as const,
        code: "no_permission" as const,
        refusal: "no_permission" as const,
      };
    }
    return {
      ok: true as const,
      site: { ...fake.site },
      scope: { kind: "DOMAIN", root: "example.com", prefix: "", key: "k" },
      fields: gateConfig.fields,
      capabilities: gateConfig.capabilities,
    };
  },
);

export const WRITE_METHODS = [
  "createPost",
  "updateObject",
  "trashObject",
  "rankMathUpdateMeta",
] as const;

// Sahte WordPress'e konuşan gerçek istemci; yazan çağrılar `writes`'a düşer.
export function makeClient(): {
  client: WordPressClient;
  writes: string[];
} {
  const real = createWordPressClient({
    origin: ORIGIN,
    restMode: "pretty",
    credentials: { username: "agentelse", appPassword: APP_PASSWORD },
    transport: createMockWpTransport(),
    pace: async () => undefined,
  });
  const writes: string[] = [];
  const client: WordPressClient = {
    ...real,
    createPost: async (body) => {
      writes.push("createPost");
      return real.createPost(body);
    },
    updateObject: async (type, id, body) => {
      writes.push("updateObject");
      return real.updateObject(type, id, body);
    },
    trashObject: async (type, id) => {
      writes.push("trashObject");
      return real.trashObject(type, id);
    },
    rankMathUpdateMeta: async (id, meta) => {
      writes.push("rankMathUpdateMeta");
      return real.rankMathUpdateMeta(id, meta);
    },
  };
  return { client, writes };
}

export function freshWordPress(): void {
  resetMockWordPress();
}

export const ENV_KEYS = [
  "SEO_APPLY",
  "SEO_HEALTH",
  "SEO_DEV_PROJECTS",
  "SEO_ROLLOUT_PROJECTS",
  "AGENTELSE_PROVIDER_MODE",
] as const;

export function titleMetaParams(overrides: Row = {}): Row {
  return {
    kind: "TITLE_META",
    url: `${ORIGIN}/about`,
    wpType: "page",
    wpId: 102,
    expectModified: BASE_MODIFIED,
    title: "About our small team",
    metaDescription: "Meet the small team behind tools for local businesses.",
    ...overrides,
  };
}

export function linksParams(overrides: Row = {}): Row {
  return {
    kind: "INTERNAL_LINKS",
    url: `${ORIGIN}/pricing`,
    wpType: "page",
    wpId: 101,
    expectModified: BASE_MODIFIED,
    links: [{ toUrl: `${ORIGIN}/about`, anchor: "pricing plans" }],
    ...overrides,
  };
}

export const ARTICLE_MARKDOWN =
  "## Why local tips matter\n\nSmall teams win with simple, repeatable steps that they can run every week without extra tools.\n\nStart with one idea and measure it.";

export function articleParams(overrides: Row = {}): Row {
  return {
    kind: "PUBLISH_ARTICLE",
    creativeId: "cr-1",
    versionId: "ver-1",
    title: "Local marketing tips for small teams",
    metaDescription: "Simple weekly steps for small local teams.",
    markdown: ARTICLE_MARKDOWN,
    language: "en",
    ...overrides,
  };
}

export function liveParams(overrides: Row = {}): Row {
  return {
    kind: "PUBLISH_LIVE",
    draftChangeId: "chg-article",
    wpType: "post",
    wpId: 301,
    link: null,
    expectModified: BASE_MODIFIED,
    creativeId: "cr-1",
    ...overrides,
  };
}

export function dedupeOf(kind: SeoChangeKind, suffix: string): string {
  const prefix: Record<SeoChangeKind, string> = {
    PUBLISH_ARTICLE: "publish",
    PUBLISH_LIVE: "live",
    TITLE_META: "meta",
    INTERNAL_LINKS: "links",
  };
  return `${prefix[kind]}:${suffix}`;
}
