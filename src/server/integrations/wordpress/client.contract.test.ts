import { describe, expect, it } from "vitest";

import { createWordPressClient } from "./client";
import type { WpRequest, WpResponse, WpTransport } from "./transport";

// WordPress REST sözleşmesi: her çağrının yöntemi, adresi, başlık biçimi
// (şifre değeri olmadan) ve gövdesi burada SABİTLENİR. Rota eşlemesi ve Rank
// Math / Yoast biçimleri herkese açık belgelerden ve bellekten alınmıştır
// (doğrulanmalı: gerçek bir WordPress, Yoast ve Rank Math sitesine karşı).
// Bu testler yalnız "kod belgelenen sözleşmeyi gönderiyor" der; WordPress'in
// gerçekten böyle yanıt verdiğini kanıtlamaz.

const ORIGIN = "https://example.com";
const CREDENTIALS = { username: "editor", appPassword: "abcdefghijklmnopqrstuvwx" };

const OBJECT_JSON = {
  id: 7,
  status: "draft",
  link: `${ORIGIN}/?p=7`,
  slug: "s",
  modified_gmt: "2026-09-20T10:00:00",
  title: { raw: "T" },
  content: { raw: "C" },
  excerpt: { raw: "E" },
  meta: [],
};

function recorder(body: unknown = OBJECT_JSON) {
  const seen: WpRequest[] = [];
  const transport: WpTransport = async (request) => {
    seen.push(request);
    const response: WpResponse = {
      status: 200,
      headers: {},
      body: typeof body === "string" ? body : JSON.stringify(body),
      truncated: false,
    };
    return response;
  };
  return { transport, seen };
}

function client(transport: WpTransport, restMode: "pretty" | "query" = "pretty") {
  return createWordPressClient({
    origin: ORIGIN,
    restMode,
    credentials: CREDENTIALS,
    transport,
    pace: async () => undefined,
  });
}

function shape(request: WpRequest) {
  return {
    method: request.method,
    url: request.url.toString(),
    headerNames: Object.keys(request.headers).sort(),
    body: request.body === undefined ? undefined : (JSON.parse(request.body) as unknown),
  };
}

const AUTHED = ["accept", "authorization", "user-agent"];
const AUTHED_JSON = ["accept", "authorization", "content-type", "user-agent"];

describe("WordPress REST sözleşmesi (güzel bağlantı kipi)", () => {
  it("discover: kimliksiz GET /wp-json/", async () => {
    const { transport, seen } = recorder({ namespaces: ["wp/v2"], authentication: {} });
    await client(transport).discover();
    expect(shape(seen[0]!)).toEqual({
      method: "GET",
      url: "https://example.com/wp-json/",
      headerNames: ["accept", "user-agent"],
      body: undefined,
    });
  });

  it("me: GET wp/v2/users/me?context=edit, Basic kimlik", async () => {
    const { transport, seen } = recorder({ id: 1, name: "n", roles: [], capabilities: {} });
    await client(transport).me();
    expect(shape(seen[0]!)).toEqual({
      method: "GET",
      url: "https://example.com/wp-json/wp/v2/users/me?context=edit",
      headerNames: AUTHED,
      body: undefined,
    });
    const header = seen[0]!.headers.authorization!;
    expect(header).toMatch(/^Basic [A-Za-z0-9+/=]+$/);
    expect(Buffer.from(header.slice(6), "base64").toString("utf8")).toBe(
      `${CREDENTIALS.username}:${CREDENTIALS.appPassword}`,
    );
    expect(seen[0]!.headers["user-agent"]).toBe("AgentelseSEO/1.0 (+https://agentelse.com)");
  });

  it("probeMetaKeys: GET wp/v2/posts?context=edit&per_page=1&status=any&_fields=id,meta", async () => {
    const { transport, seen } = recorder([{ id: 1, meta: { _yoast_wpseo_title: "" } }]);
    expect(await client(transport).probeMetaKeys()).toEqual(["_yoast_wpseo_title"]);
    expect(shape(seen[0]!).url).toBe(
      "https://example.com/wp-json/wp/v2/posts?context=edit&per_page=1&status=any&_fields=id%2Cmeta",
    );
  });

  it("findObjects: posts ve pages, slug + status=any + context=edit + per_page=10", async () => {
    const { transport, seen } = recorder([]);
    await client(transport).findObjects("https://example.com/blog/my-post/");
    expect(seen.map((request) => request.url.toString()).sort()).toEqual([
      "https://example.com/wp-json/wp/v2/pages?context=edit&slug=my-post&status=any&per_page=10",
      "https://example.com/wp-json/wp/v2/posts?context=edit&slug=my-post&status=any&per_page=10",
    ]);
    expect(seen.every((request) => request.method === "GET")).toBe(true);
  });

  it("getObject: GET wp/v2/{posts|pages}/{id}?context=edit", async () => {
    const { transport, seen } = recorder();
    await client(transport).getObject("page", 101);
    await client(transport).getObject("post", 201);
    expect(seen.map((request) => request.url.toString())).toEqual([
      "https://example.com/wp-json/wp/v2/pages/101?context=edit",
      "https://example.com/wp-json/wp/v2/posts/201?context=edit",
    ]);
  });

  it("searchDrafts: status=draft, search, orderby=modified&order=desc", async () => {
    const { transport, seen } = recorder([]);
    await client(transport).searchDrafts("Hello World");
    expect(shape(seen[0]!).url).toBe(
      "https://example.com/wp-json/wp/v2/posts?context=edit&status=draft&search=Hello%20World&orderby=modified&order=desc&per_page=10",
    );
  });

  it("createPost: POST wp/v2/posts?context=edit, JSON gövde aynen gider", async () => {
    const { transport, seen } = recorder();
    const body = {
      title: "Hello",
      status: "draft" as const,
      content: "<!-- wp:paragraph -->\n<p>Hi</p>\n<!-- /wp:paragraph -->",
      excerpt: "Short",
      meta: { _yoast_wpseo_metadesc: "Desc" },
    };
    await client(transport).createPost(body);
    expect(shape(seen[0]!)).toEqual({
      method: "POST",
      url: "https://example.com/wp-json/wp/v2/posts?context=edit",
      headerNames: AUTHED_JSON,
      body,
    });
    expect(seen[0]!.headers["content-type"]).toBe("application/json");
  });

  it("updateObject: POST wp/v2/{type}/{id}?context=edit (PUT/PATCH değil)", async () => {
    const { transport, seen } = recorder();
    await client(transport).updateObject("page", 101, { title: "New", status: "publish" });
    expect(shape(seen[0]!)).toEqual({
      method: "POST",
      url: "https://example.com/wp-json/wp/v2/pages/101?context=edit",
      headerNames: AUTHED_JSON,
      body: { title: "New", status: "publish" },
    });
  });

  it("trashObject: DELETE wp/v2/{type}/{id}, force parametresi YOK, gövde YOK", async () => {
    const { transport, seen } = recorder();
    await client(transport).trashObject("post", 201);
    expect(shape(seen[0]!)).toEqual({
      method: "DELETE",
      url: "https://example.com/wp-json/wp/v2/posts/201",
      headerNames: AUTHED,
      body: undefined,
    });
    expect(seen[0]!.url.search).toBe("");
  });

  it("rankMathUpdateMeta: POST rankmath/v1/updateMeta {objectID, objectType, meta}", async () => {
    const { transport, seen } = recorder({ slug: true });
    await client(transport).rankMathUpdateMeta(201, {
      rank_math_title: "Title",
      rank_math_description: "Desc",
    });
    expect(shape(seen[0]!)).toEqual({
      method: "POST",
      url: "https://example.com/wp-json/rankmath/v1/updateMeta",
      headerNames: AUTHED_JSON,
      body: {
        objectID: 201,
        objectType: "post",
        meta: { rank_math_title: "Title", rank_math_description: "Desc" },
      },
    });
  });

  it("Application Password: introspect GET, revoke DELETE", async () => {
    const { transport, seen } = recorder({ uuid: "abc-123" });
    await client(transport).introspectAppPassword();
    await client(transport).revokeAppPassword("abc-123");
    expect(seen.map((request) => [request.method, request.url.toString()])).toEqual([
      ["GET", "https://example.com/wp-json/wp/v2/users/me/application-passwords/introspect"],
      ["DELETE", "https://example.com/wp-json/wp/v2/users/me/application-passwords/abc-123"],
    ]);
  });
});

describe("WordPress REST sözleşmesi (sorgu kipi)", () => {
  it("aynı rotalar ?rest_route= ile kurulur", async () => {
    const { transport, seen } = recorder();
    const wp = client(transport, "query");
    await wp.getObject("page", 101);
    await wp.createPost({ title: "T", status: "draft", content: "c", excerpt: "e" });
    await wp.trashObject("post", 201);
    expect(seen.map((request) => [request.method, request.url.toString()])).toEqual([
      ["GET", "https://example.com/?rest_route=/wp/v2/pages/101&context=edit"],
      ["POST", "https://example.com/?rest_route=/wp/v2/posts&context=edit"],
      ["DELETE", "https://example.com/?rest_route=/wp/v2/posts/201"],
    ]);
  });

  it("discover sorgu kipinde GET /?rest_route=/", async () => {
    const { transport, seen } = recorder({ namespaces: ["wp/v2"], authentication: {} });
    await client(transport, "query").discover();
    expect(seen[0]!.url.toString()).toBe("https://example.com/?rest_route=/");
  });
});

describe("şifre değeri", () => {
  it("başlık adları sabittir ve Authorization dışında şifre geçmez", async () => {
    const { transport, seen } = recorder();
    await client(transport).createPost({ title: "T", status: "draft", content: "c", excerpt: "e" });
    const request = seen[0]!;
    const withoutAuth = JSON.stringify({ ...request.headers, authorization: undefined, url: request.url.toString(), body: request.body });
    expect(withoutAuth).not.toContain(CREDENTIALS.appPassword);
  });
});
