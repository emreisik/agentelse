import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UnsafeUrlError } from "@/server/security/safe-fetch";

import { createWordPressClient, restUrl } from "./client";
import { WordPressApiError } from "./errors";
import {
  createMockWpTransport,
  mockWpCalls,
  mockWpEdit,
  resetMockWordPress,
  seedMockWordPress,
  setMockWpFault,
} from "./mock-site";
import type { WpRequest, WpResponse, WpTransport } from "./transport";

const ORIGIN = "https://mock.example";
const CREDENTIALS = { username: "agentelse", appPassword: "abcdefghijklmnopqrstuvwx" };
const noPace = async () => undefined;

function mockClient(options: { origin?: string; restMode?: "pretty" | "query"; auth?: boolean; inScope?: (url: string) => boolean } = {}) {
  return createWordPressClient({
    origin: options.origin ?? ORIGIN,
    restMode: options.restMode ?? "pretty",
    credentials: options.auth === false ? null : CREDENTIALS,
    transport: createMockWpTransport(),
    pace: noPace,
    ...(options.inScope ? { inScope: options.inScope } : {}),
  });
}

// Sabit yanıt veren ve istekleri sayan taşıyıcı.
function scripted(responses: (WpResponse | Error)[]) {
  const seen: WpRequest[] = [];
  let index = 0;
  const transport: WpTransport = async (request) => {
    seen.push(request);
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    if (next instanceof Error) throw next;
    return next;
  };
  return { transport, seen };
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}): WpResponse {
  return {
    status,
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
    truncated: false,
  };
}

function clientWith(transport: WpTransport, origin = ORIGIN) {
  return createWordPressClient({
    origin,
    restMode: "pretty",
    credentials: CREDENTIALS,
    transport,
    pace: noPace,
  });
}

beforeEach(() => resetMockWordPress());
afterEach(() => resetMockWordPress());

describe("restUrl", () => {
  it("güzel ve sorgu kipinde aynı rotadan adres kurar", () => {
    expect(restUrl("https://a.example", "pretty", "wp/v2/posts", { context: "edit" }).toString()).toBe(
      "https://a.example/wp-json/wp/v2/posts?context=edit",
    );
    expect(restUrl("https://a.example/", "query", "wp/v2/posts", { context: "edit", per_page: 1 }).toString()).toBe(
      "https://a.example/?rest_route=/wp/v2/posts&context=edit&per_page=1",
    );
    expect(restUrl("https://a.example", "pretty", "").toString()).toBe("https://a.example/wp-json/");
    expect(restUrl("https://a.example", "query", "").toString()).toBe("https://a.example/?rest_route=/");
  });

  it("sorgu değerlerini kodlar", () => {
    expect(restUrl("https://a.example", "pretty", "wp/v2/posts", { search: "a b&c" }).search).toBe(
      "?search=a%20b%26c",
    );
  });
});

describe("keşif", () => {
  it("güzel bağlantı kipinde dizini okur ve kipi bildirir", async () => {
    const client = mockClient();
    const index = await client.discover();
    expect(index.namespaces).toContain("wp/v2");
    expect(index.appPasswords).toBe(true);
    expect(client.lastRestMode?.()).toBe("pretty");
    expect(client.lastOrigin()).toBe(ORIGIN);
  });

  it("güzel bağlantılar kapalıysa ?rest_route= kipine düşer", async () => {
    seedMockWordPress(ORIGIN, { prettyPermalinks: false });
    const client = mockClient();
    await client.discover();
    expect(client.lastRestMode?.()).toBe("query");
    const object = await client.getObject("page", 101);
    expect(object?.slug).toBe("pricing");
  });

  it("kapsamdaki yönlendirmeyi izler ve yeni kökeni sabitler", async () => {
    seedMockWordPress("https://old.example", { redirectTo: "https://www.old.example" });
    seedMockWordPress("https://www.old.example", {});
    const client = mockClient({ origin: "https://old.example", inScope: (url) => url.includes("old.example") });
    await client.discover();
    expect(client.lastOrigin()).toBe("https://www.old.example");
  });

  it("kapsam dışına yönlenirse izlemez", async () => {
    seedMockWordPress("https://old.example", { redirectTo: "https://evil.example" });
    const client = mockClient({ origin: "https://old.example", inScope: (url) => url.includes("old.example") });
    await expect(client.discover()).rejects.toMatchObject({ errorClass: "REDIRECT" });
    expect(client.lastOrigin()).toBe("https://old.example");
  });

  it("kimlikli ve kapsamsız istemci başka köke yönlenmez", async () => {
    const { transport, seen } = scripted([
      reply(301, "", { location: "https://evil.example/wp-json/" }),
    ]);
    const client = clientWith(transport, "https://a.example");
    await expect(client.discover()).rejects.toMatchObject({ errorClass: "REDIRECT" });
    expect(client.lastOrigin()).toBe("https://a.example");
    expect(seen.every((request) => request.url.hostname !== "evil.example")).toBe(true);
  });

  it("en çok 3 yönlendirme izler", async () => {
    const { transport, seen } = scripted([
      reply(301, "", { location: "https://a.example/wp-json/" }),
    ]);
    const client = clientWith(transport, "https://a.example");
    await expect(client.discover()).rejects.toMatchObject({ errorClass: "REDIRECT" });
    // 1 ilk istek + 3 izleme, sonra durur (her iki kip aynı yolu denemez: REDIRECT hemen atılır).
    expect(seen).toHaveLength(4);
  });

  it("WordPress olmayan site NOT_WORDPRESS, engelli site REST_DISABLED", async () => {
    seedMockWordPress("https://plain.example", { notWordPress: true });
    await expect(mockClient({ origin: "https://plain.example" }).discover()).rejects.toMatchObject({
      errorClass: "NOT_WORDPRESS",
    });
    seedMockWordPress("https://blocked.example", { restBlocked: true });
    await expect(mockClient({ origin: "https://blocked.example" }).discover()).rejects.toMatchObject({
      errorClass: "REST_DISABLED",
    });
  });
});

describe("okumalar", () => {
  it("me kullanıcıyı ve yetkileri döner", async () => {
    const me = await mockClient().me();
    expect(me.roles).toEqual(["editor"]);
    expect(me.capabilities.edit_posts).toBe(true);
  });

  it("kötü şifre bad_credentials için AUTH hatasıdır", async () => {
    const client = createWordPressClient({
      origin: ORIGIN,
      restMode: "pretty",
      credentials: { username: "agentelse", appPassword: "badbadbadbadbadbadbadbad" },
      transport: createMockWpTransport(),
      pace: noPace,
    });
    await expect(client.me()).rejects.toMatchObject({ errorClass: "AUTH", httpStatus: 401 });
  });

  it("probeMetaKeys: Yoast açıkken anahtarları, gizliyken boş liste döner", async () => {
    expect(await mockClient().probeMetaKeys()).toEqual(["_yoast_wpseo_title", "_yoast_wpseo_metadesc"]);
    seedMockWordPress(ORIGIN, { seoPlugin: "YOAST_HIDDEN" });
    expect(await mockClient().probeMetaKeys()).toEqual([]);
  });

  it("findObjects slug ile yazı ve sayfaları bulur, ana sayfa için boş döner", async () => {
    const client = mockClient();
    const pricing = await client.findObjects(`${ORIGIN}/pricing`);
    expect(pricing.map((o) => [o.type, o.id])).toEqual([["page", 101]]);
    const post = await client.findObjects(`${ORIGIN}/blog/post-3`);
    expect(post.map((o) => [o.type, o.id])).toEqual([["post", 203]]);
    expect(await client.findObjects(`${ORIGIN}/`)).toEqual([]);
    expect(await client.findObjects(`${ORIGIN}/missing`)).toEqual([]);
  });

  it("getObject: bulunamayan nesne null, içerik ham gelir", async () => {
    const client = mockClient();
    expect(await client.getObject("post", 99999)).toBeNull();
    const page = await client.getObject("page", 101);
    expect(page?.content).toContain("<!-- wp:paragraph -->");
    expect(page?.modified).toMatch(/Z$/);
  });

  it("searchDrafts yalnız taslaklarda arar", async () => {
    const client = mockClient();
    await client.createPost({ title: "Adopt me", status: "draft", content: "<p>text</p>", excerpt: "e" });
    const found = await client.searchDrafts("Adopt me");
    expect(found.map((o) => o.title)).toEqual(["Adopt me"]);
    expect(await client.searchDrafts("Blog post 1")).toEqual([]);
  });
});

describe("yazmalar", () => {
  it("createPost taslak oluşturur, updateObject modified'ı ilerletir, trashObject çöp kutusuna taşır", async () => {
    const client = mockClient();
    const created = await client.createPost({
      title: "Hello",
      status: "draft",
      content: "<p>Body</p>",
      excerpt: "Short",
    });
    expect(created.status).toBe("draft");
    const updated = await client.updateObject("post", created.id, { title: "Hello 2" });
    expect(updated.title).toBe("Hello 2");
    expect(updated.modified).not.toBe(created.modified);
    await client.trashObject("post", created.id);
    const trashed = await client.getObject("post", created.id);
    expect(trashed?.status).toBe("trash");
  });

  it("trashObject force parametresi göndermez", async () => {
    const client = mockClient();
    await client.trashObject("post", 201);
    const last = mockWpCalls().at(-1)!;
    expect(last).toMatchObject({ method: "DELETE", route: "wp/v2/posts/201", query: "" });
  });

  it("rankMathUpdateMeta uç noktayı çağırır", async () => {
    seedMockWordPress(ORIGIN, { seoPlugin: "RANK_MATH_ENDPOINT" });
    await mockClient().rankMathUpdateMeta(201, { rank_math_title: "T" });
    expect(mockWpCalls().at(-1)).toMatchObject({ method: "POST", route: "rankmath/v1/updateMeta" });
  });

  it("introspect ve revoke Application Password'ü iptal eder", async () => {
    const client = mockClient();
    const info = await client.introspectAppPassword();
    expect(info?.uuid).toBeTruthy();
    await client.revokeAppPassword(info!.uuid);
    await expect(client.me()).rejects.toMatchObject({ errorClass: "AUTH" });
  });

  it("Application Passwords kapalıysa introspect APP_PASSWORDS_DISABLED fırlatır", async () => {
    seedMockWordPress(ORIGIN, { appPasswords: false });
    await expect(mockClient().introspectAppPassword()).rejects.toMatchObject({
      errorClass: "APP_PASSWORDS_DISABLED",
    });
  });

  it("yazma çağrıları hiçbir zaman yeniden denenmez", async () => {
    for (const run of [
      (client: ReturnType<typeof clientWith>) =>
        client.createPost({ title: "T", status: "draft", content: "c", excerpt: "e" }),
      (client: ReturnType<typeof clientWith>) => client.updateObject("post", 1, { title: "T" }),
      (client: ReturnType<typeof clientWith>) => client.trashObject("post", 1),
      (client: ReturnType<typeof clientWith>) => client.rankMathUpdateMeta(1, { a: "b" }),
    ]) {
      const { transport, seen } = scripted([reply(503, { code: "x" })]);
      await expect(run(clientWith(transport))).rejects.toMatchObject({ errorClass: "TRANSIENT" });
      expect(seen).toHaveLength(1);
    }
  });

  it("zaman aşımı sonrası yazı inmişse arama onu bulur (after:true tatbikatı)", async () => {
    const client = mockClient();
    setMockWpFault("create", { status: 504, after: true });
    await expect(
      client.createPost({ title: "Landed anyway", status: "draft", content: "<p>x</p>", excerpt: "" }),
    ).rejects.toMatchObject({ errorClass: "TRANSIENT" });
    setMockWpFault("create", null);
    expect((await client.searchDrafts("Landed anyway")).map((o) => o.title)).toEqual(["Landed anyway"]);
  });
});

describe("hata eşleme ve yeniden deneme", () => {
  it.each([
    [401, { code: "rest_not_logged_in" }, "AUTH"],
    [403, { code: "rest_forbidden" }, "FORBIDDEN"],
    [403, "<html>waf</html>", "REST_DISABLED"],
    [404, { code: "rest_no_route" }, "NOT_FOUND"],
    [429, { code: "too_many" }, "RATE_LIMIT"],
    [500, { code: "internal" }, "SERVER"],
    [503, { code: "unavailable" }, "TRANSIENT"],
    [400, { code: "rest_invalid_param" }, "VALIDATION"],
  ])("me(): %s -> %s", async (status, body, expected) => {
    const { transport } = scripted([reply(status, body)]);
    await expect(clientWith(transport).me()).rejects.toMatchObject({ errorClass: expected });
  });

  it("okumalar TRANSIENT/SERVER'da bir kez yeniden denenir", async () => {
    const { transport, seen } = scripted([reply(503, {}), reply(200, { id: 1, name: "n", roles: [], capabilities: {} })]);
    await expect(clientWith(transport).me()).resolves.toMatchObject({ id: 1 });
    expect(seen).toHaveLength(2);
    const failing = scripted([reply(500, {})]);
    await expect(clientWith(failing.transport).me()).rejects.toMatchObject({ errorClass: "SERVER" });
    expect(failing.seen).toHaveLength(2);
  });

  it("4xx okumalar yeniden denenmez", async () => {
    for (const status of [401, 403, 404, 429]) {
      const { transport, seen } = scripted([reply(status, { code: "x" })]);
      await expect(clientWith(transport).me()).rejects.toBeInstanceOf(WordPressApiError);
      expect(seen).toHaveLength(1);
    }
  });

  it("ağ ve güvenlik hataları sınıflanır; mesaj yanıt gövdesini taşımaz", async () => {
    const network = scripted([new Error("connect ECONNRESET secret-token")]);
    const error = await clientWith(network.transport).me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WordPressApiError);
    expect((error as WordPressApiError).errorClass).toBe("TRANSIENT");
    expect((error as WordPressApiError).message).not.toContain("secret-token");

    const unsafe = scripted([new UnsafeUrlError("private")]);
    await expect(clientWith(unsafe.transport).me()).rejects.toMatchObject({ errorClass: "UNSAFE" });

    const leaking = scripted([reply(500, { code: "x", message: "SECRET-BODY-TEXT" })]);
    const leaked = await clientWith(leaking.transport).me().catch((e: unknown) => e);
    expect(JSON.stringify(leaked)).not.toContain("SECRET-BODY-TEXT");
    expect((leaked as Error).message).not.toContain("SECRET-BODY-TEXT");
  });

  it("kesilmiş yanıt yeniden denenmeyen SERVER hatasıdır", async () => {
    const { transport, seen } = scripted([{ ...reply(200, "[{\"id\":"), truncated: true }]);
    await expect(clientWith(transport).me()).rejects.toMatchObject({ errorClass: "SERVER", retryable: false });
    expect(seen).toHaveLength(1);
  });

  it("3xx kimlikli çağrıda REDIRECT'tir ve izlenmez", async () => {
    const { transport, seen } = scripted([reply(301, "", { location: "https://other.example/" })]);
    await expect(clientWith(transport).me()).rejects.toMatchObject({ errorClass: "REDIRECT" });
    expect(seen).toHaveLength(1);
  });

  it("getObject 404'ü null yapar ama diğer hataları fırlatır", async () => {
    const missing = scripted([reply(404, { code: "rest_post_invalid_id" })]);
    expect(await clientWith(missing.transport).getObject("post", 1)).toBeNull();
    const forbidden = scripted([reply(403, { code: "rest_forbidden" })]);
    await expect(clientWith(forbidden.transport).getObject("post", 1)).rejects.toMatchObject({
      errorClass: "FORBIDDEN",
    });
  });

  it("mockWpEdit sonrası güncel okuma yeni modified'ı görür", async () => {
    const client = mockClient();
    const before = await client.getObject("page", 101);
    mockWpEdit(ORIGIN, 101, { title: "Edited" });
    const after = await client.getObject("page", 101);
    expect(after?.title).toBe("Edited");
    expect(after?.modified).not.toBe(before?.modified);
  });
});

describe("Authorization başlığı", () => {
  it("yalnız https üzerinden gider", async () => {
    const secure = scripted([reply(200, { id: 1, name: "n", roles: [], capabilities: {} })]);
    await clientWith(secure.transport, "https://a.example").me();
    expect(secure.seen[0]!.headers.authorization).toMatch(/^Basic /);

    const plain = scripted([reply(401, { code: "rest_not_logged_in" })]);
    await clientWith(plain.transport, "http://a.example").me().catch(() => undefined);
    expect(plain.seen[0]!.headers.authorization).toBeUndefined();
  });

  it("kimlik bilgisi yoksa başlık yoktur; keşif hiçbir zaman kimlik göndermez", async () => {
    const none = scripted([reply(401, {})]);
    await createWordPressClient({
      origin: ORIGIN,
      restMode: "pretty",
      credentials: null,
      transport: none.transport,
      pace: noPace,
    })
      .me()
      .catch(() => undefined);
    expect(none.seen[0]!.headers.authorization).toBeUndefined();

    const discovery = scripted([reply(200, { namespaces: ["wp/v2"], authentication: {} })]);
    await clientWith(discovery.transport).discover();
    expect(discovery.seen[0]!.headers.authorization).toBeUndefined();
  });

  it("her istek sabit User-Agent ve 15 sn / 2 MB sınırlarıyla gider ve pace'ten geçer", async () => {
    const pace = vi.fn(async () => undefined);
    const { transport, seen } = scripted([reply(200, { id: 1, name: "n", roles: [], capabilities: {} })]);
    await createWordPressClient({
      origin: ORIGIN,
      restMode: "pretty",
      credentials: CREDENTIALS,
      transport,
      pace,
    }).me();
    expect(seen[0]!.headers["user-agent"]).toBe("AgentelseSEO/1.0 (+https://agentelse.com)");
    expect(seen[0]!.timeoutMs).toBe(15_000);
    expect(seen[0]!.maxBytes).toBe(2_000_000);
    expect(pace).toHaveBeenCalledWith("mock.example");
  });
});
