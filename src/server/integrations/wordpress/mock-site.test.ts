import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { restUrl, type RestMode } from "./client";
import {
  createMockWpTransport,
  mockWpCalls,
  mockWpEdit,
  resetMockWordPress,
  seedMockWordPress,
  setMockWpFault,
  setMockWpReadBackLie,
} from "./mock-site";

const ORIGIN = "https://mock.example";
const AUTH = `Basic ${Buffer.from("agentelse:abcd efgh ijkl mnop qrst uvwx").toString("base64")}`;
const BAD_AUTH = `Basic ${Buffer.from("agentelse:badbadbadbadbadbadbadbad").toString("base64")}`;

const transport = createMockWpTransport();

async function call(
  method: "GET" | "POST" | "DELETE",
  route: string,
  options: {
    query?: Record<string, string | number>;
    body?: unknown;
    auth?: string | null;
    mode?: RestMode;
    origin?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  const auth = options.auth === undefined ? AUTH : options.auth;
  if (auth) headers.authorization = auth;
  const response = await transport({
    method,
    url: restUrl(options.origin ?? ORIGIN, options.mode ?? "pretty", route, options.query),
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    timeoutMs: 1_000,
    maxBytes: 1_000_000,
  });
  let json: unknown = null;
  try {
    json = JSON.parse(response.body);
  } catch {
    json = response.body;
  }
  return { status: response.status, json: json as Record<string, unknown>, response };
}

beforeEach(() => resetMockWordPress());
afterEach(() => resetMockWordPress());

describe("mock WordPress", () => {
  it("seed belirlenimcidir: aynı köken iki kez aynı içeriği verir", async () => {
    const first = await call("GET", "wp/v2/pages", { query: { context: "edit", status: "any" } });
    resetMockWordPress();
    const second = await call("GET", "wp/v2/pages", { query: { context: "edit", status: "any" } });
    expect(first.json).toEqual(second.json);
    const pages = first.json as unknown as { id: number; slug: string; link: string }[];
    expect(pages.map((p) => [p.id, p.slug, p.link])).toEqual([
      [101, "pricing", `${ORIGIN}/pricing`],
      [102, "about", `${ORIGIN}/about`],
    ]);
    const posts = await call("GET", "wp/v2/posts", { query: { context: "edit", status: "any", per_page: 20 } });
    expect((posts.json as unknown as { id: number }[]).map((p) => p.id)).toEqual([
      201, 202, 203, 204, 205, 206, 207, 208,
    ]);
  });

  it("dizin eklenti ad alanlarını ve Application Password desteğini bildirir", async () => {
    const index = await call("GET", "", { auth: null });
    expect(index.status).toBe(200);
    expect(index.json.namespaces).toEqual(expect.arrayContaining(["wp/v2", "yoast/v1"]));
    expect(index.json.authentication).toHaveProperty("application-passwords");
    seedMockWordPress(ORIGIN, { seoPlugin: "RANK_MATH_ENDPOINT", appPasswords: false });
    const rank = await call("GET", "", { auth: null });
    expect(rank.json.namespaces).toEqual(expect.arrayContaining(["rankmath/v1"]));
    expect(rank.json.authentication).toEqual([]);
  });

  it("kimlik: boş ve 'bad' içeren şifre 401, doğru şifre 200", async () => {
    expect((await call("GET", "wp/v2/users/me", { auth: null })).status).toBe(401);
    expect((await call("GET", "wp/v2/users/me", { auth: BAD_AUTH })).status).toBe(401);
    const ok = await call("GET", "wp/v2/users/me", { query: { context: "edit" } });
    expect(ok.status).toBe(200);
    expect(ok.json.roles).toEqual(["editor"]);
    expect((ok.json.capabilities as Record<string, boolean>).edit_posts).toBe(true);
  });

  it("kimliksiz edit bağlamı okuması reddedilir", async () => {
    const response = await call("GET", "wp/v2/posts/201", { auth: null, query: { context: "edit" } });
    expect(response.status).toBe(401);
  });

  it("güncelleme modified saatini ilerletir ve çağrı günlüğüne düşer", async () => {
    const before = await call("GET", "wp/v2/pages/101", { query: { context: "edit" } });
    const updated = await call("POST", "wp/v2/pages/101", { body: { title: "New title" } });
    expect(updated.status).toBe(200);
    expect(updated.json.modified_gmt).not.toBe(before.json.modified_gmt);
    expect((updated.json.title as { raw: string }).raw).toBe("New title");
    expect(mockWpCalls().map((c) => `${c.method} ${c.route}`)).toEqual([
      "GET wp/v2/pages/101",
      "POST wp/v2/pages/101",
    ]);
  });

  it("taslak oluşturulur ve yayınlama yetkisi yoksa publish reddedilir", async () => {
    const created = await call("POST", "wp/v2/posts", {
      body: { title: "Hello world", status: "draft", content: "<p>Hi</p>", excerpt: "Short" },
    });
    expect(created.status).toBe(201);
    expect(created.json.status).toBe("draft");
    expect(created.json.slug).toBe("hello-world");
    seedMockWordPress(ORIGIN, { roles: ["contributor"] });
    const refused = await call("POST", "wp/v2/posts", { body: { title: "X", status: "publish" } });
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe("rest_cannot_publish");
  });

  it("Yoast açıkken meta yazılır ve okunur; gizliyken sessizce yok sayılır", async () => {
    await call("POST", "wp/v2/posts/201", {
      body: { meta: { _yoast_wpseo_title: "SEO title", _yoast_wpseo_metadesc: "Desc" } },
    });
    const read = await call("GET", "wp/v2/posts/201", { query: { context: "edit" } });
    expect(read.json.meta).toEqual({
      _yoast_wpseo_title: "SEO title",
      _yoast_wpseo_metadesc: "Desc",
    });
    seedMockWordPress(ORIGIN, { seoPlugin: "YOAST_HIDDEN" });
    await call("POST", "wp/v2/posts/201", { body: { meta: { _yoast_wpseo_title: "X" } } });
    const hidden = await call("GET", "wp/v2/posts/201", { query: { context: "edit" } });
    expect(hidden.json.meta).toEqual([]);
  });

  it("Rank Math uç noktası gizli meta yazar ve modified saatini değiştirmez", async () => {
    seedMockWordPress(ORIGIN, { seoPlugin: "RANK_MATH_ENDPOINT" });
    const before = await call("GET", "wp/v2/posts/201", { query: { context: "edit" } });
    const response = await call("POST", "rankmath/v1/updateMeta", {
      body: { objectID: 201, objectType: "post", meta: { rank_math_title: "T" } },
    });
    expect(response.status).toBe(200);
    const after = await call("GET", "wp/v2/posts/201", { query: { context: "edit" } });
    expect(after.json.modified_gmt).toBe(before.json.modified_gmt);
    expect(after.json.meta).toEqual([]);
  });

  it("çöp kutusu force olmadan durumu trash yapar, force silinmesini sağlar", async () => {
    const trashed = await call("DELETE", "wp/v2/posts/202");
    expect(trashed.json.status).toBe("trash");
    expect(mockWpCalls()[0]!.query).toBe("");
    const gone = await call("DELETE", "wp/v2/posts/203", { query: { force: "true" } });
    expect(gone.json.deleted).toBe(true);
    expect((await call("GET", "wp/v2/posts/203", { query: { context: "edit" } })).status).toBe(404);
  });

  it("hata tatbikatı: yazma olmadan hata hiçbir şeyi değiştirmez", async () => {
    setMockWpFault("update", { status: 503 });
    const failed = await call("POST", "wp/v2/pages/101", { body: { title: "Changed" } });
    expect(failed.status).toBe(503);
    setMockWpFault("update", null);
    const read = await call("GET", "wp/v2/pages/101", { query: { context: "edit" } });
    expect((read.json.title as { raw: string }).raw).toBe("Pricing");
  });

  it("after:true yazma iner ama yanıt hatadır (zaman aşımına uğrayan yazı)", async () => {
    setMockWpFault("create", { status: 504, after: true });
    const failed = await call("POST", "wp/v2/posts", { body: { title: "Landed", status: "draft" } });
    expect(failed.status).toBe(504);
    setMockWpFault("create", null);
    const drafts = await call("GET", "wp/v2/posts", { query: { context: "edit", status: "draft", search: "Landed" } });
    expect((drafts.json as unknown as unknown[]).length).toBe(1);
  });

  it("status 0 hatası ağ kopması gibi fırlatır", async () => {
    setMockWpFault("me", { status: 0 });
    await expect(call("GET", "wp/v2/users/me")).rejects.toThrow("Mock network failure");
  });

  it("geri okuma yalanı: kaydedilen değer istenenden farklıdır", async () => {
    setMockWpReadBackLie("update", true);
    const response = await call("POST", "wp/v2/pages/102", { body: { title: "Exact" } });
    expect((response.json.title as { raw: string }).raw).not.toBe("Exact");
  });

  it("kullanıcı düzenlemesi (mockWpEdit) modified saatini ilerletir", async () => {
    const before = await call("GET", "wp/v2/pages/101", { query: { context: "edit" } });
    mockWpEdit(ORIGIN, 101, { content: "<p>Edited by a human</p>" });
    const after = await call("GET", "wp/v2/pages/101", { query: { context: "edit" } });
    expect(after.json.modified_gmt).not.toBe(before.json.modified_gmt);
    expect((after.json.content as { raw: string }).raw).toBe("<p>Edited by a human</p>");
  });

  it("sorgu kipi (?rest_route=) ve kapalı güzel bağlantılar", async () => {
    seedMockWordPress(ORIGIN, { prettyPermalinks: false });
    const pretty = await call("GET", "", { auth: null });
    expect(pretty.status).toBe(404);
    expect(typeof pretty.json).toBe("string");
    const query = await call("GET", "", { auth: null, mode: "query" });
    expect(query.status).toBe(200);
    expect(query.json.namespaces).toContain("wp/v2");
  });

  it("WordPress olmayan, engelli ve yönlenen siteler", async () => {
    seedMockWordPress("https://plain.example", { notWordPress: true });
    expect((await call("GET", "", { auth: null, origin: "https://plain.example" })).response.headers["content-type"]).toContain("text/html");
    seedMockWordPress("https://blocked.example", { restBlocked: true });
    expect((await call("GET", "", { auth: null, origin: "https://blocked.example" })).status).toBe(403);
    seedMockWordPress("https://old.example", { redirectTo: "https://www.old.example" });
    const redirect = await call("GET", "", { auth: null, origin: "https://old.example" });
    expect(redirect.status).toBe(301);
    expect(redirect.response.headers.location).toBe("https://www.old.example/wp-json/");
  });

  it("builder ve klasik editör seed'i", async () => {
    seedMockWordPress(ORIGIN, { builderPageIds: [101], classicContentIds: [102] });
    const builder = await call("GET", "wp/v2/pages/101", { query: { context: "edit" } });
    expect((builder.json.content as { raw: string }).raw).toContain("elementor");
    const classic = await call("GET", "wp/v2/pages/102", { query: { context: "edit" } });
    expect((classic.json.content as { raw: string }).raw).not.toContain("<!-- wp:");
  });

  it("Application Password iptali sonraki kimlikli istekleri düşürür", async () => {
    const info = await call("GET", "wp/v2/users/me/application-passwords/introspect");
    expect(typeof info.json.uuid).toBe("string");
    const revoked = await call("DELETE", `wp/v2/users/me/application-passwords/${String(info.json.uuid)}`);
    expect(revoked.json.deleted).toBe(true);
    expect((await call("GET", "wp/v2/users/me")).status).toBe(401);
  });

  it("ağa hiç çıkmaz: fetch ve node:https dokunulmaz", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const httpsSpy = vi.spyOn(https, "request");
    await call("GET", "");
    await call("POST", "wp/v2/posts", { body: { title: "x" } });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(httpsSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    httpsSpy.mockRestore();
  });
});
