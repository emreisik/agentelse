import "server-only";

import { applyMockMode } from "@/lib/seo/apply/flags";
import type { WpType } from "@/lib/seo/apply/types";
import { slugOfUrl } from "@/lib/seo/apply/wp/match";
import { parseWpIndex, parseWpMe, parseWpObject } from "@/lib/seo/apply/wp/parse";
import type { WpIndex, WpMe, WpObject } from "@/lib/seo/apply/wp/wp-types";
import type { WpWrite } from "@/lib/seo/apply/wp/plan";
import { sharedHostPacer } from "@/server/seo/crawl/pacer";
import { UnsafeUrlError } from "@/server/security/safe-fetch";

import { classifyWpResponse, WordPressApiError } from "./errors";
import {
  WORDPRESS_USER_AGENT,
  wpTransportFor,
  type WpResponse,
  type WpTransport,
} from "./transport";

// WordPress REST istemcisi (docs/wordpress-plan.md). Bütün adresler restUrl()
// ile kurulur (güzel bağlantı ve ?rest_route= kipi aynı kodu paylaşır). Her
// hata WordPressApiError'a çevrilir; WordPress'in yanıt gövdesi mesaja ya da
// loga hiç girmez. Yazma çağrıları (createPost, updateObject, trashObject,
// rankMathUpdateMeta) ASLA yeniden denenmez: zaman aşımına uğrayan bir yazı
// belki inmiştir ve motor onu searchDrafts / geri okuma ile sahiplenir. Okumalar
// TRANSIENT/SERVER'da bir kez yeniden denenir.
//
// Rota eşlemesi ve Rank Math / Yoast biçimleri herkese açık belgelerden ve
// bellekten; her biri (doğrulanmalı: gerçek bir siteye karşı) ve
// client.contract.test.ts'te sabitlenmiştir.

export type WpCreateBody = Extract<WpWrite, { op: "create" }>["body"];
export type WpUpdateBody = Extract<WpWrite, { op: "update" }>["body"];

export type RestMode = "pretty" | "query";

export interface WordPressClient {
  // GET / (kimliksiz); kapsamdaki en çok 3 yönlendirmeyi izler; köken lastOrigin()'de sabitlenir.
  discover(): Promise<WpIndex>;
  lastOrigin(): string;
  // discover() sonrası çalışan REST kipi (kayıt için).
  lastRestMode?(): RestMode;
  me(): Promise<WpMe>;
  probeMetaKeys(): Promise<string[]>;
  findObjects(url: string): Promise<WpObject[]>;
  getObject(type: WpType, id: number): Promise<WpObject | null>;
  searchDrafts(title: string): Promise<WpObject[]>;
  createPost(body: WpCreateBody): Promise<WpObject>;
  updateObject(type: WpType, id: number, body: WpUpdateBody): Promise<WpObject>;
  trashObject(type: WpType, id: number): Promise<void>;
  rankMathUpdateMeta(id: number, meta: Record<string, string>): Promise<void>;
  introspectAppPassword(): Promise<{ uuid: string } | null>;
  revokeAppPassword(uuid: string): Promise<void>;
}

export type CreateWordPressClientInput = {
  origin: string;
  restMode: RestMode;
  credentials: { username: string; appPassword: string } | null;
  transport?: WpTransport;
  pace?: (host: string) => Promise<void>;
  inScope?: (url: string) => boolean;
};

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_000_000;
const PACE_MS = 1_000;
const MAX_REDIRECTS = 3;
const FIND_LIMIT = 10;

const noPace = async () => undefined;

function typeSegment(type: WpType): string {
  return type === "page" ? "pages" : "posts";
}

// Tek adres kurucu: güzel kipte {origin}/wp-json/{route}?k=v, sorgu kipinde
// {origin}/?rest_route=/{route}&k=v (doğrulanmalı: WordPress'in rest_route biçimi).
export function restUrl(
  origin: string,
  restMode: RestMode,
  route: string,
  query: Record<string, string | number> = {},
): URL {
  const base = origin.replace(/\/+$/, "");
  const pairs = Object.entries(query).map(
    ([key, value]) =>
      `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
  );
  const cleanRoute = route.replace(/^\/+/, "");
  if (restMode === "pretty") {
    const suffix = pairs.length ? `?${pairs.join("&")}` : "";
    return new URL(`${base}/wp-json/${cleanRoute}${suffix}`);
  }
  return new URL(`${base}/?rest_route=/${cleanRoute}${pairs.map((p) => `&${p}`).join("")}`);
}

function basicHeader(credentials: { username: string; appPassword: string }): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.appPassword}`).toString("base64")}`;
}

function parseBody(response: WpResponse): unknown {
  const text = response.body;
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isRetryableRead(error: unknown): boolean {
  return (
    error instanceof WordPressApiError &&
    (error.errorClass === "TRANSIENT" || error.errorClass === "SERVER") &&
    error.retryable
  );
}

function asObjectList(json: unknown, type: WpType): WpObject[] {
  if (!Array.isArray(json)) return [];
  const objects: WpObject[] = [];
  for (const item of json) {
    const parsed = parseWpObject(item, type);
    if (parsed) objects.push(parsed);
  }
  return objects;
}

function metaKeysOf(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  for (const item of json) {
    if (typeof item !== "object" || item === null) continue;
    const meta = (item as Record<string, unknown>).meta;
    // Kayıtlı alan yoksa WordPress [] (dizi) döndürebilir.
    if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
      return Object.keys(meta);
    }
    return [];
  }
  return [];
}

export function createWordPressClient(
  input: CreateWordPressClientInput,
): WordPressClient {
  const transport = input.transport ?? wpTransportFor(applyMockMode());
  const pace =
    input.pace ??
    (applyMockMode()
      ? noPace
      : (host: string) => sharedHostPacer.wait(host, PACE_MS));
  let origin = input.origin.replace(/\/+$/, "");
  let mode: RestMode = input.restMode;

  type CallOptions = {
    query?: Record<string, string | number>;
    body?: unknown;
    // Kimlik başlığı eklenir mi (discover kimliksizdir).
    auth?: boolean;
    // Okuma yeniden deneme sayısı (yazma 0).
    retries?: number;
  };

  async function send(
    method: "GET" | "POST" | "DELETE",
    route: string,
    options: CallOptions,
    at: { origin: string; mode: RestMode },
  ): Promise<{ response: WpResponse; json: unknown; url: URL }> {
    const url = restUrl(at.origin, at.mode, route, options.query);
    const headers: Record<string, string> = {
      "user-agent": WORDPRESS_USER_AGENT,
      accept: "application/json",
    };
    // Şifre yalnız https üzerinden gider.
    if (options.auth !== false && input.credentials && url.protocol === "https:") {
      headers.authorization = basicHeader(input.credentials);
    }
    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["content-type"] = "application/json";
    }
    await pace(url.host);
    let response: WpResponse;
    try {
      response = await transport({
        method,
        url,
        headers,
        ...(body !== undefined ? { body } : {}),
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
      });
    } catch (error) {
      if (error instanceof WordPressApiError) throw error;
      if (error instanceof UnsafeUrlError) throw new WordPressApiError("UNSAFE");
      // Ağ, DNS ve süre hataları geçicidir.
      throw new WordPressApiError("TRANSIENT");
    }
    return { response, json: parseBody(response), url };
  }

  // Kimlik doğrulamalı çağrı: yönlendirme izlenmez (3xx REDIRECT hatasıdır).
  async function call(
    method: "GET" | "POST" | "DELETE",
    route: string,
    options: CallOptions = {},
  ): Promise<unknown> {
    const attempts = 1 + (options.retries ?? 0);
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const { response, json } = await send(method, route, options, { origin, mode });
        const errorClass = classifyWpResponse(response.status, json);
        if (errorClass) {
          throw new WordPressApiError(errorClass, {
            httpStatus: response.status,
            wpCode: wpCodeOf(json),
          });
        }
        if (response.truncated) {
          throw new WordPressApiError("SERVER", {
            httpStatus: response.status,
            retryable: false,
          });
        }
        return json;
      } catch (error) {
        lastError = error;
        if (!isRetryableRead(error) || attempt === attempts - 1) throw error;
      }
    }
    throw lastError;
  }

  function wpCodeOf(json: unknown): string | null {
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      return null;
    }
    const code = (json as Record<string, unknown>).code;
    return typeof code === "string" ? code : null;
  }

  // Kimliksiz keşif: bir kipte GET /; yönlendirmeleri kapsam içinde elle izler.
  async function discoverIn(candidate: RestMode): Promise<{ index: WpIndex; origin: string }> {
    let currentOrigin = origin;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const { response, json, url } = await send(
        "GET",
        "",
        { auth: false },
        { origin: currentOrigin, mode: candidate },
      );
      const errorClass = classifyWpResponse(response.status, json);
      if (errorClass === "REDIRECT") {
        const location = response.headers.location;
        let next: URL | null = null;
        try {
          next = location ? new URL(location, url) : null;
        } catch {
          next = null;
        }
        if (!next || hop === MAX_REDIRECTS) {
          throw new WordPressApiError("REDIRECT", { httpStatus: response.status });
        }
        // Yalnız kapsamdaki adrese gidilir; koşulsuz izleme açık yönlendirmedir.
        if (input.inScope && !input.inScope(next.toString())) {
          throw new WordPressApiError("REDIRECT", { httpStatus: response.status });
        }
        // Kapsam sınaması yoksa kimlikli istemci başka bir kökene geçemez: köken
        // sabitlendikten sonra Basic yetkilendirme yeni konağa giderdi.
        if (!input.inScope && input.credentials && next.origin !== origin) {
          throw new WordPressApiError("REDIRECT", { httpStatus: response.status });
        }
        // Yönlendirme aynı REST yolunda kalmalı (alt klasör ya da başka uygulama değil).
        if (!sameRestPath(next, candidate)) {
          throw new WordPressApiError("REDIRECT", { httpStatus: response.status });
        }
        currentOrigin = next.origin;
        continue;
      }
      if (errorClass) {
        throw new WordPressApiError(errorClass, {
          httpStatus: response.status,
          wpCode: wpCodeOf(json),
        });
      }
      const index = parseWpIndex(json);
      if (!index) throw new WordPressApiError("NOT_WORDPRESS", { httpStatus: response.status });
      return { index, origin: currentOrigin };
    }
    throw new WordPressApiError("REDIRECT");
  }

  function sameRestPath(next: URL, candidate: RestMode): boolean {
    if (candidate === "pretty") return next.pathname === "/wp-json/" || next.pathname === "/wp-json";
    return next.pathname === "/" && next.searchParams.has("rest_route");
  }

  async function discover(): Promise<WpIndex> {
    const order: RestMode[] = mode === "pretty" ? ["pretty", "query"] : ["query", "pretty"];
    let lastError: unknown;
    for (const candidate of order) {
      // Okuma: geçici hatada bir kez daha dener (kipi değiştirmeden).
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const found = await discoverIn(candidate);
          origin = found.origin;
          mode = candidate;
          return found.index;
        } catch (error) {
          lastError = error;
          if (isRetryableRead(error) && attempt === 0) continue;
          break;
        }
      }
      // Yalnız "bu kipte REST yok" hatasında öbür kip denenir.
      const missing =
        lastError instanceof WordPressApiError &&
        (lastError.errorClass === "NOT_FOUND" || lastError.errorClass === "NOT_WORDPRESS");
      if (!missing) throw lastError;
    }
    throw lastError;
  }

  async function listObjects(
    type: WpType,
    query: Record<string, string | number>,
  ): Promise<WpObject[]> {
    const json = await call("GET", `wp/v2/${typeSegment(type)}`, {
      query: { context: "edit", ...query },
      retries: 1,
    });
    return asObjectList(json, type);
  }

  return {
    discover,
    lastOrigin: () => origin,
    lastRestMode: () => mode,

    async me() {
      const json = await call("GET", "wp/v2/users/me", {
        query: { context: "edit" },
        retries: 1,
      });
      const me = parseWpMe(json);
      if (!me) throw new WordPressApiError("NOT_WORDPRESS");
      return me;
    },

    async probeMetaKeys() {
      for (const type of ["post", "page"] as const) {
        const json = await call("GET", `wp/v2/${typeSegment(type)}`, {
          query: { context: "edit", per_page: 1, status: "any", _fields: "id,meta" },
          retries: 1,
        });
        if (Array.isArray(json) && json.length > 0) return metaKeysOf(json);
      }
      return [];
    },

    async findObjects(url) {
      const slug = slugOfUrl(url);
      if (!slug) return [];
      const [posts, pages] = await Promise.all([
        listObjects("post", { slug, status: "any", per_page: FIND_LIMIT }),
        listObjects("page", { slug, status: "any", per_page: FIND_LIMIT }),
      ]);
      return [...posts, ...pages].slice(0, FIND_LIMIT);
    },

    async getObject(type, id) {
      try {
        const json = await call("GET", `wp/v2/${typeSegment(type)}/${id}`, {
          query: { context: "edit" },
          retries: 1,
        });
        const object = parseWpObject(json, type);
        if (!object) throw new WordPressApiError("NOT_WORDPRESS");
        return object;
      } catch (error) {
        if (error instanceof WordPressApiError && error.errorClass === "NOT_FOUND") {
          return null;
        }
        throw error;
      }
    },

    async searchDrafts(title) {
      return listObjects("post", {
        status: "draft",
        search: title,
        orderby: "modified",
        order: "desc",
        per_page: FIND_LIMIT,
      });
    },

    async createPost(body) {
      const json = await call("POST", "wp/v2/posts", {
        query: { context: "edit" },
        body,
      });
      const object = parseWpObject(json, "post");
      if (!object) throw new WordPressApiError("NOT_WORDPRESS");
      return object;
    },

    async updateObject(type, id, body) {
      // POST ile güncelleme (PUT/PATCH engelleyen sunucularda da çalışır).
      const json = await call("POST", `wp/v2/${typeSegment(type)}/${id}`, {
        query: { context: "edit" },
        body,
      });
      const object = parseWpObject(json, type);
      if (!object) throw new WordPressApiError("NOT_WORDPRESS");
      return object;
    },

    async trashObject(type, id) {
      // force parametresi YOK: yazı kurtarılabilir WordPress Çöp Kutusu'na gider.
      await call("DELETE", `wp/v2/${typeSegment(type)}/${id}`, {});
    },

    async rankMathUpdateMeta(id, meta) {
      // (doğrulanmalı: Rank Math updateMeta uç noktası ve gövde alanları)
      await call("POST", "rankmath/v1/updateMeta", {
        body: { objectID: id, objectType: "post", meta },
      });
    },

    async introspectAppPassword() {
      try {
        const json = await call("GET", "wp/v2/users/me/application-passwords/introspect", {
          retries: 1,
        });
        if (typeof json === "object" && json !== null && !Array.isArray(json)) {
          const uuid = (json as Record<string, unknown>).uuid;
          if (typeof uuid === "string" && uuid) return { uuid };
        }
        return null;
      } catch (error) {
        if (error instanceof WordPressApiError && error.errorClass === "NOT_FOUND") {
          return null;
        }
        throw error;
      }
    },

    async revokeAppPassword(uuid) {
      await call(
        "DELETE",
        `wp/v2/users/me/application-passwords/${encodeURIComponent(uuid)}`,
        {},
      );
    },
  };
}
