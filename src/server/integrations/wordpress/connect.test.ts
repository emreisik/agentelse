import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { scopeFromVerifiedDomain, type CrawlScope } from "@/lib/seo/crawl-url";

// Bellek içi sahte Prisma: yalnız connect.ts'in dokunduğu temsilciler.
const store = vi.hoisted(() => {
  type Row = Record<string, unknown> & { id: string };
  const state = {
    credentials: new Map<string, Row>(),
    sites: new Map<string, Row>(),
    changes: [] as Row[],
    members: [] as { userId: string; role: string }[],
    settingsUpdates: [] as unknown[],
    deletedSiteIds: [] as string[],
    queries: 0,
    seq: 0,
  };
  const credentialKey = (where: { projectId_provider: { projectId: string; provider: string } }) =>
    `${where.projectId_provider.projectId}:${where.projectId_provider.provider}`;
  const siteKey = (w: { projectId_kind_isMock: { projectId: string; kind: string; isMock: boolean } }) =>
    `${w.projectId_kind_isMock.projectId}:${w.projectId_kind_isMock.kind}:${w.projectId_kind_isMock.isMock}`;
  const byId = (map: Map<string, Row>, id: string) =>
    [...map.entries()].find(([, row]) => row.id === id);

  const prisma = {
    integrationCredential: {
      findUnique: async ({ where }: { where: Parameters<typeof credentialKey>[0] }) => {
        state.queries += 1;
        return state.credentials.get(credentialKey(where)) ?? null;
      },
      upsert: async ({ where, create, update }: { where: Parameters<typeof credentialKey>[0]; create: Row; update: Row }) => {
        state.queries += 1;
        const key = credentialKey(where);
        const existing = state.credentials.get(key);
        const row = existing
          ? { ...existing, ...update }
          : { ...create, id: `cred-${(state.seq += 1)}` };
        state.credentials.set(key, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        state.queries += 1;
        const found = byId(state.credentials, where.id);
        if (!found) throw new Error("no credential");
        const row = { ...found[1], ...data };
        state.credentials.set(found[0], row);
        return row;
      },
      deleteMany: async ({ where }: { where: { projectId: string; provider: string } }) => {
        state.queries += 1;
        return { count: state.credentials.delete(`${where.projectId}:${where.provider}`) ? 1 : 0 };
      },
    },
    cmsSite: {
      findUnique: async ({ where }: { where: Parameters<typeof siteKey>[0] }) => {
        state.queries += 1;
        return state.sites.get(siteKey(where)) ?? null;
      },
      upsert: async ({ where, create, update }: { where: Parameters<typeof siteKey>[0]; create: Row; update: Row }) => {
        state.queries += 1;
        const key = siteKey(where);
        const existing = state.sites.get(key);
        const row = existing
          ? { ...existing, ...update }
          : { ...create, id: `site-${(state.seq += 1)}` };
        state.sites.set(key, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        state.queries += 1;
        const found = byId(state.sites, where.id);
        if (!found) throw new Error("no site");
        const row = { ...found[1], ...data };
        state.sites.set(found[0], row);
        return row;
      },
      deleteMany: async ({ where }: { where: { id: string } }) => {
        state.queries += 1;
        const found = byId(state.sites, where.id);
        if (found) {
          state.sites.delete(found[0]);
          state.deletedSiteIds.push(where.id);
        }
        return { count: found ? 1 : 0 };
      },
    },
    seoChange: {
      count: async ({ where }: { where: { siteId: string; status: { in: string[] }; leaseUntil: { gt: Date } } }) => {
        state.queries += 1;
        return state.changes.filter(
          (change) =>
            change.siteId === where.siteId &&
            where.status.in.includes(change.status as string) &&
            (change.leaseUntil as Date) > where.leaseUntil.gt,
        ).length;
      },
    },
    seoApplySetting: {
      updateMany: async (args: unknown) => {
        state.queries += 1;
        state.settingsUpdates.push(args);
        return { count: 1 };
      },
    },
    workspaceMember: {
      findFirst: async ({ where }: { where: { userId: string } }) => {
        state.queries += 1;
        return state.members.find((member) => member.userId === where.userId) ?? null;
      },
    },
  };
  return { state, prisma };
});

const scopeRef = vi.hoisted(() => ({ current: null as CrawlScope | null }));
const cleanup = vi.hoisted(() => ({ fn: vi.fn<(siteId: string) => Promise<number>>(async () => 0) }));
const audit = vi.hoisted(() => ({ record: vi.fn<(input: unknown) => Promise<object>>(async () => ({})) }));

vi.mock("@/lib/prisma", () => ({ prisma: store.prisma }));
vi.mock("@/server/seo/site/sites", () => ({
  SeoSites: {
    readState: async () => {
      store.state.queries += 1;
      return scopeRef.current ? { scope: scopeRef.current } : null;
    },
  },
}));
vi.mock("@/server/seo/apply/cleanup", () => ({
  cleanupSeoApplyForSite: (siteId: string) => cleanup.fn(siteId),
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: audit,
}));

import { createMockWpTransport, mockWpCalls, resetMockWordPress, seedMockWordPress } from "./mock-site";
import {
  connectWordPress,
  disconnectWordPress,
  loadWordPressConnectionView,
  normalizeSiteUrl,
  testWordPress,
  type ConnectInput,
} from "./connect";

const PASSWORD = "abcdefghijklmnopqrstuvwx";
const PROJECT = "proj-1";
const ENV_KEYS = [
  "SEO_APPLY",
  "SEO_HEALTH",
  "AGENTELSE_PROVIDER_MODE",
  "TEMPORARY_SECRET_ENCRYPTION_KEY",
  "SEO_DEV_PROJECTS",
  "SEO_ROLLOUT_PROJECTS",
  "META_TOKEN_KEYS",
] as const;
const savedEnv: Record<string, string | undefined> = {};
const noPace = async () => undefined;

function input(overrides: Partial<ConnectInput> = {}): ConnectInput {
  return {
    projectId: PROJECT,
    workspaceId: "ws-1",
    brandId: "brand-1",
    userId: "user-1",
    siteUrl: "https://mock.example",
    username: "agentelse",
    appPassword: PASSWORD,
    ...overrides,
  };
}

function setMode(mock: boolean) {
  process.env.AGENTELSE_PROVIDER_MODE = mock ? "mock" : "live";
}

// Gerçek kipte de bellek içi WordPress kullanılır: ağa hiç çıkılmaz.
const deps = () => ({ transport: createMockWpTransport(), pace: noPace });

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.SEO_APPLY = "true";
  process.env.SEO_HEALTH = "true";
  process.env.TEMPORARY_SECRET_ENCRYPTION_KEY = "ab".repeat(32);
  delete process.env.SEO_DEV_PROJECTS;
  delete process.env.SEO_ROLLOUT_PROJECTS;
  delete process.env.META_TOKEN_KEYS;
  setMode(true);
  resetMockWordPress();
  store.state.credentials.clear();
  store.state.sites.clear();
  store.state.changes = [];
  store.state.members = [];
  store.state.settingsUpdates = [];
  store.state.deletedSiteIds = [];
  store.state.queries = 0;
  scopeRef.current = scopeFromVerifiedDomain("mock.example");
  cleanup.fn.mockReset();
  cleanup.fn.mockResolvedValue(0);
  audit.record.mockReset();
  audit.record.mockResolvedValue({});
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetMockWordPress();
});

describe("normalizeSiteUrl", () => {
  it("https kökünü döner, şemasız adrese https ekler", () => {
    expect(normalizeSiteUrl("https://Example.com/")).toEqual({ ok: true, origin: "https://example.com", host: "example.com" });
    expect(normalizeSiteUrl("example.com")).toMatchObject({ ok: true, origin: "https://example.com" });
    expect(normalizeSiteUrl("https://example.com:443")).toMatchObject({ ok: true });
  });

  it("hata kodları", () => {
    expect(normalizeSiteUrl("")).toEqual({ ok: false, code: "invalid_url" });
    expect(normalizeSiteUrl("http://example.com")).toEqual({ ok: false, code: "not_https" });
    expect(normalizeSiteUrl("ftp://example.com")).toEqual({ ok: false, code: "invalid_url" });
    expect(normalizeSiteUrl("https://example.com/blog")).toEqual({ ok: false, code: "subfolder" });
    expect(normalizeSiteUrl("https://mysite.wordpress.com")).toEqual({ ok: false, code: "wordpress_com" });
    expect(normalizeSiteUrl("https://user:pw@example.com")).toEqual({ ok: false, code: "invalid_url" });
    expect(normalizeSiteUrl("https://example.com:8443")).toEqual({ ok: false, code: "invalid_url" });
    expect(normalizeSiteUrl("localhost")).toEqual({ ok: false, code: "invalid_url" });
  });
});

describe("connectWordPress hata yolları", () => {
  it("bayrak kapalıyken not_allowed ve hiçbir sorgu yok", async () => {
    process.env.SEO_APPLY = "false";
    const result = await connectWordPress(input(), deps());
    expect(result).toMatchObject({ ok: false, code: "not_allowed" });
    expect(store.state.queries).toBe(0);
  });

  it("eksik ya da bozuk girdi invalid_input", async () => {
    for (const override of [
      { username: "" },
      { appPassword: "short" },
      { appPassword: "" },
      { username: "a:b" },
    ]) {
      expect(await connectWordPress(input(override), deps())).toMatchObject({ ok: false, code: "invalid_input" });
    }
  });

  it("adres hataları", async () => {
    expect(await connectWordPress(input({ siteUrl: "http://mock.example" }), deps())).toMatchObject({ code: "not_https" });
    expect(await connectWordPress(input({ siteUrl: "https://mock.example/blog" }), deps())).toMatchObject({ code: "subfolder" });
    expect(await connectWordPress(input({ siteUrl: "https://shop.wordpress.com" }), deps())).toMatchObject({ code: "wordpress_com" });
    expect(await connectWordPress(input({ siteUrl: "" }), deps())).toMatchObject({ code: "invalid_url" });
  });

  it("doğrulanmış site (kapsam) yoksa no_verified_site", async () => {
    scopeRef.current = null;
    expect(await connectWordPress(input(), deps())).toMatchObject({ ok: false, code: "no_verified_site" });
  });

  it("adres kapsam dışıysa domain_mismatch ve siteye hiç istek atılmaz", async () => {
    const result = await connectWordPress(input({ siteUrl: "https://other.example" }), deps());
    expect(result).toMatchObject({ ok: false, code: "domain_mismatch" });
    expect(mockWpCalls()).toEqual([]);
  });

  it("kapsam dışına yönlenen site domain_mismatch", async () => {
    seedMockWordPress("https://mock.example", { redirectTo: "https://evil.example" });
    expect(await connectWordPress(input(), deps())).toMatchObject({ ok: false, code: "domain_mismatch" });
  });

  it("WordPress olmayan, engelli ve ulaşılamayan site", async () => {
    seedMockWordPress("https://mock.example", { notWordPress: true });
    expect(await connectWordPress(input(), deps())).toMatchObject({ code: "not_wordpress" });
    seedMockWordPress("https://mock.example", { restBlocked: true });
    const blocked = await connectWordPress(input(), deps());
    expect(blocked).toMatchObject({ code: "rest_blocked" });
    expect((blocked as { message: string }).message).toContain("AgentelseSEO/1.0");
    const down = await connectWordPress(input(), {
      transport: async () => {
        throw new Error("ECONNREFUSED");
      },
      pace: noPace,
    });
    expect(down).toMatchObject({ code: "unreachable" });
  });

  it("Application Passwords kapalıysa app_passwords_disabled", async () => {
    seedMockWordPress("https://mock.example", { appPasswords: false });
    expect(await connectWordPress(input(), deps())).toMatchObject({ code: "app_passwords_disabled" });
  });

  it("WordPress şifreyi kabul etmezse bad_credentials", async () => {
    const result = await connectWordPress(input({ appPassword: "badbadbadbadbadbadbadbad" }), deps());
    expect(result).toMatchObject({ ok: false, code: "bad_credentials" });
    expect(store.state.credentials.size).toBe(0);
    expect(store.state.sites.size).toBe(0);
  });

  it("taslak bile açamayan kullanıcı no_edit_rights, contributor ise sınırlı bağlanır", async () => {
    seedMockWordPress("https://mock.example", { roles: ["subscriber"] });
    expect(await connectWordPress(input(), deps())).toMatchObject({ ok: false, code: "no_edit_rights" });
    seedMockWordPress("https://mock.example", { roles: ["contributor"] });
    const limited = await connectWordPress(input(), deps());
    expect(limited).toMatchObject({ ok: true });
    if (limited.ok) {
      expect(limited.view.health).toBe("LIMITED");
      expect(limited.view.capabilities?.publishPosts).toBe(false);
    }
  });
});

describe("connectWordPress başarı", () => {
  it("mock süreç wordpress_mock kimliği ve isMock site yazar; şifre hiçbir yerde düz durmaz", async () => {
    const result = await connectWordPress(input(), deps());
    expect(result.ok).toBe(true);
    const credential = store.state.credentials.get(`${PROJECT}:wordpress_mock`)!;
    expect(credential).toBeDefined();
    expect(credential.status).toBe("ACTIVE");
    expect(credential.accountLabel).toBe("agentelse @ mock.example");
    expect(credential.metadata).toEqual({ keyId: "legacy", origin: "https://mock.example", administrator: false });
    expect(store.state.credentials.has(`${PROJECT}:wordpress`)).toBe(false);

    const site = store.state.sites.get(`${PROJECT}:WORDPRESS:true`)!;
    expect(site).toMatchObject({
      isMock: true,
      kind: "WORDPRESS",
      origin: "https://mock.example",
      restMode: "pretty",
      scopeKey: scopeRef.current!.key,
      seoPlugin: "YOAST",
      health: "OK",
      credentialId: credential.id,
    });

    // Şifre yalnız mühürlü alanda (şifreli) vardır.
    const { encryptedSecret, ...rest } = credential;
    expect(typeof encryptedSecret).toBe("string");
    expect(encryptedSecret).not.toContain(PASSWORD);
    expect(JSON.stringify(rest)).not.toContain(PASSWORD);
    expect(JSON.stringify(site)).not.toContain(PASSWORD);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(PASSWORD);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "integration_credential.connected",
        metadata: { provider: "wordpress_mock" },
      }),
    );
  });

  it("gerçek süreç wordpress kimliği ve isMock=false site yazar", async () => {
    setMode(false);
    const result = await connectWordPress(input(), deps());
    expect(result.ok).toBe(true);
    expect(store.state.credentials.has(`${PROJECT}:wordpress`)).toBe(true);
    expect(store.state.credentials.has(`${PROJECT}:wordpress_mock`)).toBe(false);
    expect(store.state.sites.get(`${PROJECT}:WORDPRESS:false`)).toMatchObject({ isMock: false });
  });

  it("yönetici hesabı için uyarı bayrağı kalıcı olur", async () => {
    seedMockWordPress("https://mock.example", { roles: ["administrator"] });
    const result = await connectWordPress(input(), deps());
    expect(result.ok && result.view.adminWarning).toBe(true);
    expect(store.state.credentials.get(`${PROJECT}:wordpress_mock`)!.metadata).toMatchObject({ administrator: true });
    const editor = await connectWordPress(input({ userId: "user-2" }), deps());
    expect(editor.ok).toBe(true);
  });

  it("SEO eklentisi yoklaması saklanır", async () => {
    seedMockWordPress("https://mock.example", { seoPlugin: "RANK_MATH_ENDPOINT" });
    const rank = await connectWordPress(input(), deps());
    const site = store.state.sites.get(`${PROJECT}:WORDPRESS:true`)!;
    expect(site.seoPlugin).toBe("RANK_MATH");
    expect(site.seoFields).toMatchObject({ plugin: "RANK_MATH", titleVia: "RANKMATH_ENDPOINT", descriptionVia: "RANKMATH_ENDPOINT" });
    expect(rank.ok && rank.view.seoPlugin).toBe("RANK_MATH");

    seedMockWordPress("https://mock.example", { seoPlugin: "YOAST_HIDDEN" });
    const hidden = await connectWordPress(input(), deps());
    expect(hidden.ok && hidden.view.descriptionWritable).toBe(false);
    expect(store.state.sites.get(`${PROJECT}:WORDPRESS:true`)!.seoFields).toMatchObject({
      plugin: "YOAST",
      titleVia: "POST_TITLE",
      descriptionVia: "NONE",
    });

    seedMockWordPress("https://mock.example", { seoPlugin: "YOAST_EXPOSED" });
    const exposed = await connectWordPress(input(), deps());
    expect(exposed.ok && exposed.view.descriptionWritable).toBe(true);
  });

  it("aynı siteye yeniden bağlanmak CmsSite satırını (ve SeoChange'leri) korur", async () => {
    await connectWordPress(input(), deps());
    const first = store.state.sites.get(`${PROJECT}:WORDPRESS:true`)!;
    const again = await connectWordPress(input({ appPassword: "zyxwvutsrqponmlkjihgfedc" }), deps());
    expect(again.ok).toBe(true);
    const second = store.state.sites.get(`${PROJECT}:WORDPRESS:true`)!;
    expect(second.id).toBe(first.id);
    expect(store.state.deletedSiteIds).toEqual([]);
    expect(cleanup.fn).not.toHaveBeenCalled();
  });

  it("başka bir siteye bağlanınca eski site temizlenip silinir (kimlikler karışmasın)", async () => {
    await connectWordPress(input(), deps());
    const first = store.state.sites.get(`${PROJECT}:WORDPRESS:true`)!;
    const moved = await connectWordPress(input({ siteUrl: "https://www.mock.example" }), deps());
    expect(moved.ok).toBe(true);
    expect(cleanup.fn).toHaveBeenCalledWith(first.id);
    expect(store.state.deletedSiteIds).toEqual([first.id]);
    expect(store.state.sites.get(`${PROJECT}:WORDPRESS:true`)).toMatchObject({ origin: "https://www.mock.example" });
  });

  it("www'ye yönlenen site için sabitlenen köken saklanır", async () => {
    seedMockWordPress("https://mock.example", { redirectTo: "https://www.mock.example" });
    const result = await connectWordPress(input(), deps());
    expect(result.ok).toBe(true);
    expect(store.state.sites.get(`${PROJECT}:WORDPRESS:true`)).toMatchObject({ origin: "https://www.mock.example" });
  });
});

describe("mock ve gerçek kimlik karışmaz", () => {
  it("gerçek süreç mock kimliğe/siteye Test ve Disconnect ile dokunamaz", async () => {
    await connectWordPress(input(), deps());
    setMode(false);
    const tested = await testWordPress(PROJECT, { isManager: true }, deps());
    expect(tested).toMatchObject({ ok: false });
    const disconnected = await disconnectWordPress({ projectId: PROJECT, workspaceId: "ws-1", userId: "user-1" }, deps());
    expect(disconnected).toEqual({ ok: true });
    expect(store.state.credentials.has(`${PROJECT}:wordpress_mock`)).toBe(true);
    expect(store.state.sites.has(`${PROJECT}:WORDPRESS:true`)).toBe(true);
    expect(cleanup.fn).not.toHaveBeenCalled();
  });

  it("mock süreç gerçek kimliğe/siteye dokunamaz", async () => {
    setMode(false);
    await connectWordPress(input(), deps());
    setMode(true);
    expect(await testWordPress(PROJECT, { isManager: true }, deps())).toMatchObject({ ok: false });
    await disconnectWordPress({ projectId: PROJECT, workspaceId: "ws-1", userId: "user-1" }, deps());
    expect(store.state.credentials.has(`${PROJECT}:wordpress`)).toBe(true);
    expect(store.state.sites.has(`${PROJECT}:WORDPRESS:false`)).toBe(true);
    // Mock süreçten bağlayınca gerçek kimlik ezilmez.
    await connectWordPress(input(), deps());
    expect(store.state.credentials.has(`${PROJECT}:wordpress`)).toBe(true);
    expect(store.state.credentials.has(`${PROJECT}:wordpress_mock`)).toBe(true);
  });
});

describe("testWordPress", () => {
  it("sağlığı ve lastCheckedAt'i günceller", async () => {
    await connectWordPress(input({}), { ...deps(), now: new Date("2026-10-01T00:00:00Z") });
    const result = await testWordPress(PROJECT, { isManager: false }, { ...deps(), now: new Date("2026-10-02T00:00:00Z") });
    expect(result.ok).toBe(true);
    const site = store.state.sites.get(`${PROJECT}:WORDPRESS:true`)!;
    expect(site.health).toBe("OK");
    expect((site.lastCheckedAt as Date).toISOString()).toBe("2026-10-02T00:00:00.000Z");
    if (result.ok) expect(result.view.canManage).toBe(false);
  });

  it("kayıtlı kimlik yoksa AUTH olur ve yeniden bağlanma ister", async () => {
    await connectWordPress(input(), deps());
    store.state.credentials.clear();
    const result = await testWordPress(PROJECT, { isManager: true }, deps());
    expect(result).toMatchObject({ ok: false, code: "bad_credentials" });
    expect(store.state.sites.get(`${PROJECT}:WORDPRESS:true`)).toMatchObject({ health: "AUTH", healthReason: "reconnect" });
  });

  it("WordPress şifreyi reddedince 401 AUTH olur", async () => {
    await connectWordPress(input(), deps());
    const rejecting = {
      transport: async (request: Parameters<ReturnType<typeof createMockWpTransport>>[0]) =>
        request.url.pathname.endsWith("/users/me")
          ? { status: 401, headers: {}, body: JSON.stringify({ code: "incorrect_password" }), truncated: false }
          : createMockWpTransport()(request),
      pace: noPace,
    };
    const result = await testWordPress(PROJECT, { isManager: true }, rejecting);
    expect(result).toMatchObject({ ok: false, code: "bad_credentials" });
    expect(store.state.sites.get(`${PROJECT}:WORDPRESS:true`)).toMatchObject({ health: "AUTH", lastError: "AUTH" });
  });

  it("kapsam anahtarı değişince DOMAIN_MISMATCH; rebind yalnız yöneticide anahtarı yeniler", async () => {
    await connectWordPress(input(), deps());
    const oldKey = scopeRef.current!.key;
    // Aynı alan adı, yeni kapsam anahtarı (ör. GSC mülkü seçildi).
    scopeRef.current = { kind: "GSC_DOMAIN", root: "mock.example", prefix: null, key: "GSC_DOMAIN:mock.example:" };

    const without = await testWordPress(PROJECT, { isManager: true }, deps());
    expect(without).toMatchObject({ ok: false, code: "domain_mismatch" });
    expect((without as { message: string }).message).toContain("Re-check the connection");
    expect(store.state.sites.get(`${PROJECT}:WORDPRESS:true`)).toMatchObject({
      health: "DOMAIN_MISMATCH",
      healthReason: "scope_changed",
      scopeKey: oldKey,
    });

    const refused = await testWordPress(PROJECT, { isManager: false, rebind: true }, deps());
    expect(refused).toMatchObject({ ok: false, code: "not_allowed" });
    expect(store.state.sites.get(`${PROJECT}:WORDPRESS:true`)!.scopeKey).toBe(oldKey);

    const rebound = await testWordPress(PROJECT, { isManager: true, rebind: true }, deps());
    expect(rebound.ok).toBe(true);
    expect(store.state.sites.get(`${PROJECT}:WORDPRESS:true`)).toMatchObject({
      health: "OK",
      scopeKey: "GSC_DOMAIN:mock.example:",
    });
  });

  it("rebind site artık kapsam dışındaysa anahtarı yenilemez", async () => {
    await connectWordPress(input(), deps());
    const oldKey = scopeRef.current!.key;
    scopeRef.current = scopeFromVerifiedDomain("another.example");
    const result = await testWordPress(PROJECT, { isManager: true, rebind: true }, deps());
    expect(result).toMatchObject({ ok: false, code: "domain_mismatch" });
    expect(store.state.sites.get(`${PROJECT}:WORDPRESS:true`)!.scopeKey).toBe(oldKey);
    // Kapsam dışı siteye istek atılmaz: bağlandıktan sonra yeni çağrı olmadı.
    const callsAfterConnect = mockWpCalls().length;
    await testWordPress(PROJECT, { isManager: true }, deps());
    expect(mockWpCalls().length).toBe(callsAfterConnect);
  });

  it("bayrak kapalıyken Test siteye hiç istek atmaz", async () => {
    await connectWordPress(input(), deps());
    const calls = mockWpCalls().length;
    process.env.SEO_APPLY = "false";
    expect(await testWordPress(PROJECT, { isManager: true }, deps())).toMatchObject({
      ok: false,
      message: "Website changes are not switched on for this project.",
    });
    expect(mockWpCalls().length).toBe(calls);
  });

  it("bağlı site yoksa hata döner", async () => {
    expect(await testWordPress(PROJECT, {}, deps())).toMatchObject({ ok: false, code: "unknown" });
  });
});

describe("disconnectWordPress", () => {
  const who = { projectId: PROJECT, workspaceId: "ws-1", userId: "user-1" };

  it("yazma sürerken (kira canlı) busy döner ve hiçbir şey silinmez", async () => {
    await connectWordPress(input(), deps());
    const site = store.state.sites.get(`${PROJECT}:WORDPRESS:true`)!;
    const now = new Date("2026-10-07T12:00:00Z");
    store.state.changes.push({
      id: "c1",
      siteId: site.id,
      status: "APPLYING",
      leaseUntil: new Date(now.getTime() + 60_000),
    });
    const result = await disconnectWordPress(who, { ...deps(), now });
    expect(result).toMatchObject({ ok: false, code: "busy" });
    expect(store.state.sites.size).toBe(1);
    expect(store.state.credentials.size).toBe(1);
    expect(cleanup.fn).not.toHaveBeenCalled();
  });

  it("ilk yazma bitmiş ama kira süren APPLIED satır da Disconnect'i engeller", async () => {
    await connectWordPress(input(), deps());
    const site = store.state.sites.get(`${PROJECT}:WORDPRESS:true`)!;
    const now = new Date("2026-10-07T12:00:00Z");
    store.state.changes.push({
      id: "c1",
      siteId: site.id,
      status: "APPLIED",
      leaseUntil: new Date(now.getTime() + 60_000),
    });
    const result = await disconnectWordPress(who, { ...deps(), now });
    expect(result).toMatchObject({ ok: false, code: "busy" });
    expect(store.state.sites.size).toBe(1);
    expect(cleanup.fn).not.toHaveBeenCalled();
  });

  it("yazma sürerken başka siteye yeniden bağlanma busy döner ve eski site silinmez", async () => {
    await connectWordPress(input(), deps());
    const key = `${PROJECT}:WORDPRESS:true`;
    const site = store.state.sites.get(key)!;
    store.state.sites.set(key, { ...site, origin: "https://old.mock.example" });
    const now = new Date("2026-10-07T12:00:00Z");
    store.state.changes.push({
      id: "c1",
      siteId: site.id,
      status: "APPLIED",
      leaseUntil: new Date(now.getTime() + 60_000),
    });
    const result = await connectWordPress(input(), { ...deps(), now });
    expect(result).toMatchObject({ ok: false, code: "busy" });
    expect(store.state.sites.get(key)).toMatchObject({ origin: "https://old.mock.example" });
    expect(cleanup.fn).not.toHaveBeenCalled();
  });

  it("kirası dolmuş bir yazma Disconnect'i engellemez", async () => {
    await connectWordPress(input(), deps());
    const site = store.state.sites.get(`${PROJECT}:WORDPRESS:true`)!;
    const now = new Date("2026-10-07T12:00:00Z");
    store.state.changes.push({ id: "c1", siteId: site.id, status: "UNDOING", leaseUntil: new Date(now.getTime() - 1) });
    expect(await disconnectWordPress(who, { ...deps(), now })).toEqual({ ok: true });
  });

  it("temizliği siteyi silmeden önce çalıştırır, şifreyi iptal eder, kimliği ve ayarları siler", async () => {
    await connectWordPress(input(), deps());
    const site = store.state.sites.get(`${PROJECT}:WORDPRESS:true`)!;
    const order: string[] = [];
    cleanup.fn.mockImplementation(async () => {
      order.push(`cleanup:${store.state.sites.has(`${PROJECT}:WORDPRESS:true`) ? "site-present" : "site-gone"}`);
      return 3;
    });
    const result = await disconnectWordPress(who, deps());
    expect(result).toEqual({ ok: true });
    expect(order).toEqual(["cleanup:site-present"]);
    expect(cleanup.fn).toHaveBeenCalledWith(site.id);
    expect(store.state.sites.size).toBe(0);
    expect(store.state.credentials.size).toBe(0);
    expect(mockWpCalls().some((call) => call.method === "DELETE" && call.route.startsWith("wp/v2/users/me/application-passwords/"))).toBe(true);
    expect(store.state.settingsUpdates).toEqual([
      {
        where: { projectId: PROJECT },
        data: {
          indexNowEnabled: false,
          indexNowKey: null,
          indexNowHost: null,
          indexNowVerifiedAt: null,
          indexNowLastPingAt: null,
        },
      },
    ]);
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "integration_credential.disconnected",
        metadata: { provider: "wordpress_mock" },
      }),
    );
  });

  it("temizlik ya da iptal başarısız olsa da Disconnect tamamlanır", async () => {
    await connectWordPress(input(), deps());
    cleanup.fn.mockRejectedValue(new Error("boom"));
    const failingTransport = {
      transport: async () => {
        throw new Error("network down");
      },
      pace: noPace,
    };
    const result = await disconnectWordPress(who, failingTransport);
    expect(result).toEqual({ ok: true });
    expect(store.state.sites.size).toBe(0);
    expect(store.state.credentials.size).toBe(0);
  });

  it("bayrak kapalıyken de çalışır (bayrağa bağlı değil)", async () => {
    await connectWordPress(input(), deps());
    process.env.SEO_APPLY = "false";
    expect(await disconnectWordPress(who, deps())).toEqual({ ok: true });
    expect(store.state.sites.size).toBe(0);
  });

  it("site yokken yetim kimliği (yarım kalmış bağlanma) siler", async () => {
    store.state.credentials.set(`${PROJECT}:wordpress_mock`, { id: "orphan", encryptedSecret: "x", status: "ACTIVE" });
    expect(await disconnectWordPress(who, deps())).toEqual({ ok: true });
    expect(store.state.credentials.size).toBe(0);
  });
});

describe("loadWordPressConnectionView", () => {
  it("bayrak kapalıyken null ve HİÇBİR sorgu yok", async () => {
    process.env.SEO_APPLY = "false";
    expect(await loadWordPressConnectionView(PROJECT, "user-1")).toBeNull();
    process.env.SEO_APPLY = "true";
    process.env.SEO_HEALTH = "false";
    expect(await loadWordPressConnectionView(PROJECT, "user-1")).toBeNull();
    expect(store.state.queries).toBe(0);
  });

  it("izin listesi dışındaki proje için null", async () => {
    process.env.SEO_ROLLOUT_PROJECTS = "someone-else";
    expect(await loadWordPressConnectionView(PROJECT, "user-1")).toBeNull();
    expect(store.state.queries).toBe(0);
  });

  it("bağlı değilse boş görünüm ve yönetici bilgisi", async () => {
    store.state.members = [{ userId: "owner", role: "OWNER" }, { userId: "member", role: "MEMBER" }];
    const owner = await loadWordPressConnectionView(PROJECT, "owner");
    expect(owner).toMatchObject({ connected: false, canManage: true, health: "UNKNOWN", origin: null });
    const member = await loadWordPressConnectionView(PROJECT, "member");
    expect(member?.canManage).toBe(false);
    const telegram = await loadWordPressConnectionView(PROJECT, "telegram:123");
    expect(telegram?.canManage).toBe(false);
  });

  it("bağlıyken sağlık, eklenti, yetkiler ve canRebind; şifre yok", async () => {
    store.state.members = [{ userId: "owner", role: "ADMIN" }];
    await connectWordPress(input(), deps());
    const view = await loadWordPressConnectionView(PROJECT, "owner");
    expect(view).toMatchObject({
      connected: true,
      host: "mock.example",
      accountLabel: "agentelse @ mock.example",
      health: "OK",
      healthLabel: "Connected",
      healthReason: null,
      seoPlugin: "YOAST",
      descriptionWritable: true,
      canManage: true,
      adminWarning: false,
      canRebind: false,
    });
    expect(JSON.stringify(view)).not.toContain(PASSWORD);
    expect(view?.capabilities?.draftPosts).toBe(true);

    scopeRef.current = { kind: "GSC_DOMAIN", root: "mock.example", prefix: null, key: "GSC_DOMAIN:mock.example:" };
    const changed = await loadWordPressConnectionView(PROJECT, "owner");
    expect(changed?.canRebind).toBe(true);
  });
});
