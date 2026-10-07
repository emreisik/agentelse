import "server-only";

import type { WpType } from "@/lib/seo/apply/types";
import type { WpObject } from "@/lib/seo/apply/wp/wp-types";

import type { WpRequest, WpResponse, WpTransport } from "./transport";

// Bellek içi sahte WordPress (docs/wordpress-plan.md). AGENTELSE_PROVIDER_MODE=mock
// iken hiçbir istek süreçten çıkmaz: her köken için belirlenimci bir site
// (SC-F3'ün mock sitesiyle hizalı: /pricing, /about ve /blog/post-N). Yazılar
// "modified" saatini ilerletir, çağrı günlüğü tutulur, hatalar ve "yazma
// indi ama yanıt hata" (zaman aşımı) tatbikatı vardır. Prisma yok; testler
// seedMockWordPress / setMockWpFault ile oynar.

export type MockSeoPlugin =
  | "YOAST_EXPOSED"
  | "YOAST_HIDDEN"
  | "RANK_MATH_ENDPOINT"
  | "NONE";

export type MockSeed = Partial<{
  seoPlugin: MockSeoPlugin;
  capabilities: Partial<Record<string, boolean>>;
  roles: string[];
  appPasswords: boolean;
  restBlocked: boolean;
  notWordPress: boolean;
  builderPageIds: number[];
  classicContentIds: number[];
  objects: Partial<WpObject>[];
  // Güzel bağlantılar kapalı: yalnız ?rest_route= çalışır.
  prettyPermalinks: boolean;
  // Bu kökene gelen her istek 301 ile başka köke yönlenir.
  redirectTo: string;
}>;

export type MockFaultRoute =
  | "create"
  | "update"
  | "trash"
  | "rankmath"
  | "get"
  | "me";

export type MockFault = { status: number; code?: string; after?: boolean };

type MockObject = {
  id: number;
  type: WpType;
  status: string;
  link: string;
  slug: string;
  // modified_gmt: "YYYY-MM-DDTHH:mm:ss" (saat dilimsiz, WordPress gibi)
  modified: string;
  title: string;
  excerpt: string;
  content: string;
  // Görünen (kayıtlı) meta anahtarları; yalnız YOAST_EXPOSED'da yanıta girer.
  meta: Record<string, string>;
  // Rank Math uç noktasının yazdığı, REST'ten okunamayan meta.
  hiddenMeta: Record<string, string>;
  // Agentelse'in oluşturduğu yazı (edit_others gerekmez).
  mine: boolean;
};

type MockState = {
  origin: string;
  seed: Required<
    Pick<MockSeed, "seoPlugin" | "appPasswords" | "restBlocked" | "notWordPress" | "prettyPermalinks">
  > & { roles: string[]; capabilities: Partial<Record<string, boolean>>; redirectTo: string | null };
  objects: Map<number, MockObject>;
  nextId: number;
  clock: number;
  appPasswordRevoked: boolean;
};

const BASE_TIME = Date.UTC(2026, 8, 20, 10, 0, 0);
const APP_PASSWORD_UUID = "mock-app-password-uuid";
const YOAST_TITLE = "_yoast_wpseo_title";
const YOAST_DESC = "_yoast_wpseo_metadesc";

const states = new Map<string, MockState>();
let calls: { method: string; route: string; query: string }[] = [];
const faults = new Map<MockFaultRoute, MockFault>();
const lies = new Set<"update" | "create">();

function stamp(offsetMinutes: number): string {
  return new Date(BASE_TIME + offsetMinutes * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "");
}

function paragraphs(items: string[], classic: boolean): string {
  if (classic) return items.join("\n\n");
  return items
    .map((text) => `<!-- wp:paragraph -->\n<p>${text}</p>\n<!-- /wp:paragraph -->`)
    .join("\n\n");
}

const PAGE_TEXT: Record<number, { slug: string; title: string; text: string[] }> = {
  101: {
    slug: "pricing",
    title: "Pricing",
    text: [
      "Our pricing plans are simple and transparent.",
      "Every plan includes unlimited projects and email support.",
      "Compare the plans below and pick the one that fits your team.",
    ],
  },
  102: {
    slug: "about",
    title: "About us",
    text: [
      "We are a small team building tools for local businesses.",
      "Our goal is to make marketing easy to understand and easy to run.",
      "Talk to us any time if you want a hand getting started.",
    ],
  },
};

function defaultObjects(origin: string, seed: MockSeed): Map<number, MockObject> {
  const objects = new Map<number, MockObject>();
  const builder = new Set(seed.builderPageIds ?? []);
  const classic = new Set(seed.classicContentIds ?? []);
  const add = (object: Omit<MockObject, "meta" | "hiddenMeta" | "mine">) => {
    const odd = object.id % 2 === 1;
    objects.set(object.id, {
      ...object,
      meta: {
        [YOAST_TITLE]: odd ? "%%title%% %%sep%% %%sitename%%" : "",
        [YOAST_DESC]: "",
      },
      hiddenMeta: {},
      mine: false,
    });
  };
  const contentFor = (id: number, text: string[]): string =>
    builder.has(id)
      ? `<div data-elementor-type="wp-page" data-elementor-id="${id}"><p>${text[0] ?? ""}</p></div>`
      : paragraphs(text, classic.has(id));
  for (const [rawId, page] of Object.entries(PAGE_TEXT)) {
    const id = Number(rawId);
    add({
      id,
      type: "page",
      status: "publish",
      link: `${origin}/${page.slug}`,
      slug: page.slug,
      modified: stamp(0),
      title: page.title,
      excerpt: "",
      content: contentFor(id, page.text),
    });
  }
  for (let n = 1; n <= 8; n += 1) {
    const id = 200 + n;
    add({
      id,
      type: "post",
      status: "publish",
      link: `${origin}/blog/post-${n}`,
      slug: `post-${n}`,
      modified: stamp(0),
      title: `Blog post ${n}`,
      excerpt: "",
      content: contentFor(id, [
        `Post ${n} shares practical tips for small teams.`,
        "Read on for simple steps you can try this week.",
      ]),
    });
  }
  return objects;
}

function newState(origin: string, seed: MockSeed): MockState {
  const key = origin.replace(/\/+$/, "").toLowerCase();
  const state: MockState = {
    origin: key,
    seed: {
      seoPlugin: seed.seoPlugin ?? "YOAST_EXPOSED",
      appPasswords: seed.appPasswords ?? true,
      restBlocked: seed.restBlocked ?? false,
      notWordPress: seed.notWordPress ?? false,
      prettyPermalinks: seed.prettyPermalinks ?? true,
      roles: seed.roles ?? ["editor"],
      capabilities: seed.capabilities ?? {},
      redirectTo: seed.redirectTo ? seed.redirectTo.replace(/\/+$/, "") : null,
    },
    objects: defaultObjects(key, seed),
    nextId: 301,
    clock: 0,
    appPasswordRevoked: false,
  };
  for (const patch of seed.objects ?? []) {
    const id = patch.id ?? state.nextId++;
    const existing = state.objects.get(id);
    const base: MockObject = existing ?? {
      id,
      type: patch.type ?? "post",
      status: "publish",
      link: `${key}/?p=${id}`,
      slug: `item-${id}`,
      modified: stamp(0),
      title: `Item ${id}`,
      excerpt: "",
      content: "",
      meta: { [YOAST_TITLE]: "", [YOAST_DESC]: "" },
      hiddenMeta: {},
      mine: false,
    };
    state.objects.set(id, {
      ...base,
      ...(patch.type ? { type: patch.type } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.link !== undefined ? { link: patch.link } : {}),
      ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
      ...(patch.modified !== undefined
        ? { modified: patch.modified.replace(/\.\d{3}Z$|Z$/, "") }
        : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.excerpt !== undefined ? { excerpt: patch.excerpt } : {}),
      ...(patch.content !== undefined && patch.content !== null
        ? { content: patch.content }
        : {}),
    });
  }
  states.set(key, state);
  return state;
}

function stateFor(origin: string): MockState {
  const key = origin.replace(/\/+$/, "").toLowerCase();
  return states.get(key) ?? newState(key, {});
}

function bump(state: MockState, object: MockObject): void {
  state.clock += 1;
  object.modified = stamp(state.clock);
}

// --- tatbikat arayüzü ---------------------------------------------------------

export function resetMockWordPress(): void {
  states.clear();
  calls = [];
  faults.clear();
  lies.clear();
}

export function seedMockWordPress(origin: string, seed: MockSeed): void {
  newState(origin, seed);
}

export function mockWpCalls(): { method: string; route: string; query: string }[] {
  return calls.map((call) => ({ ...call }));
}

export function setMockWpFault(route: MockFaultRoute, fault: MockFault | null): void {
  if (fault) faults.set(route, fault);
  else faults.delete(route);
}

export function setMockWpReadBackLie(route: "update" | "create", on: boolean): void {
  if (on) lies.add(route);
  else lies.delete(route);
}

// Kullanıcı WordPress'te sayfayı kendisi düzenledi: içerik değişir, modified ilerler.
export function mockWpEdit(
  origin: string,
  id: number,
  patch: Partial<Pick<WpObject, "title" | "content" | "excerpt" | "status">>,
): void {
  const state = stateFor(origin);
  const object = state.objects.get(id);
  if (!object) throw new Error(`Mock WordPress has no object ${id}`);
  if (patch.title !== undefined) object.title = patch.title;
  if (patch.content !== undefined && patch.content !== null) object.content = patch.content;
  if (patch.excerpt !== undefined) object.excerpt = patch.excerpt;
  if (patch.status !== undefined) object.status = patch.status;
  bump(state, object);
}

// --- yanıt yardımcıları ---------------------------------------------------------

const JSON_HEADERS = { "content-type": "application/json; charset=UTF-8" };

function json(status: number, body: unknown): WpResponse {
  return {
    status,
    headers: { ...JSON_HEADERS },
    body: JSON.stringify(body),
    truncated: false,
  };
}

function html(status: number, body: string): WpResponse {
  return {
    status,
    headers: { "content-type": "text/html; charset=UTF-8" },
    body,
    truncated: false,
  };
}

function wpError(status: number, code: string, message = "Mock WordPress error."): WpResponse {
  return json(status, { code, message, data: { status } });
}

const ROLE_CAPS: Record<string, string[]> = {
  administrator: [
    "read",
    "edit_posts",
    "publish_posts",
    "edit_published_posts",
    "edit_pages",
    "edit_published_pages",
    "edit_others_posts",
    "delete_posts",
    "manage_options",
  ],
  editor: [
    "read",
    "edit_posts",
    "publish_posts",
    "edit_published_posts",
    "edit_pages",
    "edit_published_pages",
    "edit_others_posts",
    "delete_posts",
  ],
  author: ["read", "edit_posts", "publish_posts", "edit_published_posts", "delete_posts"],
  contributor: ["read", "edit_posts", "delete_posts"],
  subscriber: ["read"],
};

const ALL_CAPS = [
  "read",
  "edit_posts",
  "publish_posts",
  "edit_published_posts",
  "edit_pages",
  "edit_published_pages",
  "edit_others_posts",
  "delete_posts",
  "manage_options",
];

function capabilitiesOf(state: MockState): Record<string, boolean> {
  const granted = new Set<string>();
  for (const role of state.seed.roles) {
    for (const cap of ROLE_CAPS[role] ?? []) granted.add(cap);
  }
  const caps: Record<string, boolean> = {};
  for (const cap of ALL_CAPS) caps[cap] = granted.has(cap);
  for (const [cap, value] of Object.entries(state.seed.capabilities)) {
    if (typeof value === "boolean") caps[cap] = value;
  }
  return caps;
}

function authorized(state: MockState, request: WpRequest): boolean {
  if (!state.seed.appPasswords || state.appPasswordRevoked) return false;
  const header = request.headers.authorization ?? request.headers.Authorization;
  if (!header || !header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 1) return false;
  const password = decoded.slice(colon + 1).replace(/\s+/g, "");
  if (!password) return false;
  return !password.toLowerCase().includes("bad");
}

function exposedMeta(state: MockState, object: MockObject): Record<string, string> | never[] {
  if (state.seed.seoPlugin !== "YOAST_EXPOSED") return [];
  return {
    [YOAST_TITLE]: object.meta[YOAST_TITLE] ?? "",
    [YOAST_DESC]: object.meta[YOAST_DESC] ?? "",
  };
}

function stripBlocks(raw: string): string {
  return raw.replace(/<!--[\s\S]*?-->/g, "");
}

function serialize(state: MockState, object: MockObject, edit: boolean) {
  const base = {
    id: object.id,
    date_gmt: stamp(0),
    modified_gmt: object.modified,
    slug: object.slug,
    status: object.status,
    type: object.type,
    link: object.link,
    meta: exposedMeta(state, object),
  };
  if (!edit) {
    return {
      ...base,
      title: { rendered: object.title },
      content: { rendered: stripBlocks(object.content), protected: false },
      excerpt: { rendered: object.excerpt },
    };
  }
  return {
    ...base,
    title: { raw: object.title, rendered: object.title },
    content: { raw: object.content, rendered: stripBlocks(object.content), protected: false },
    excerpt: { raw: object.excerpt, rendered: object.excerpt },
  };
}

function slugify(text: string, taken: (slug: string) => boolean): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "post";
  if (!taken(base)) return base;
  let n = 2;
  while (taken(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function textOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const raw = (value as Record<string, unknown>).raw;
    if (typeof raw === "string") return raw;
  }
  return null;
}

// "Yazma indi ama içerik değişti" tatbikatı: kaydedilen değer istenenden farklı.
function applyLie(object: MockObject, body: Record<string, unknown>): void {
  if (body.title !== undefined) object.title = `${object.title} [changed]`;
  else if (body.content !== undefined) object.content = `${object.content}\n<!-- altered -->`;
  else if (body.excerpt !== undefined) object.excerpt = `${object.excerpt} [changed]`;
  else if (body.status !== undefined) object.status = "pending";
  else if (body.meta !== undefined) {
    for (const key of Object.keys(object.meta)) object.meta[key] = `${object.meta[key]} [changed]`;
  }
}

function applyFields(state: MockState, object: MockObject, body: Record<string, unknown>): void {
  const title = textOf(body.title);
  if (title !== null) object.title = title;
  const content = textOf(body.content);
  if (content !== null) object.content = content;
  const excerpt = textOf(body.excerpt);
  if (excerpt !== null) object.excerpt = excerpt;
  if (typeof body.status === "string") {
    object.status = body.status;
    if (body.status === "publish") object.link = `${state.origin}/${object.slug}`;
  }
  if (typeof body.meta === "object" && body.meta !== null && state.seed.seoPlugin === "YOAST_EXPOSED") {
    for (const [key, value] of Object.entries(body.meta as Record<string, unknown>)) {
      // Kayıtlı olmayan anahtarlar WordPress'te sessizce yok sayılır.
      if ((key === YOAST_TITLE || key === YOAST_DESC) && typeof value === "string") {
        object.meta[key] = value;
      }
    }
  }
}

type Parsed = { route: string; query: URLSearchParams; pretty: boolean };

function parseRoute(url: URL): Parsed | null {
  const restRoute = url.searchParams.get("rest_route");
  if (restRoute !== null) {
    const query = new URLSearchParams(url.searchParams);
    query.delete("rest_route");
    return { route: restRoute.replace(/^\/+/, "").replace(/\/+$/, ""), query, pretty: false };
  }
  if (url.pathname === "/wp-json" || url.pathname.startsWith("/wp-json/")) {
    return {
      route: url.pathname.slice("/wp-json".length).replace(/^\/+/, "").replace(/\/+$/, ""),
      query: url.searchParams,
      pretty: true,
    };
  }
  return null;
}

function faultKey(method: string, route: string): MockFaultRoute | null {
  if (method === "GET" && route === "wp/v2/users/me") return "me";
  if (method === "GET" && /^wp\/v2\/(posts|pages)(\/\d+)?$/.test(route)) return "get";
  if (method === "POST" && route === "wp/v2/posts") return "create";
  if (method === "POST" && /^wp\/v2\/(posts|pages)\/\d+$/.test(route)) return "update";
  if (method === "DELETE" && /^wp\/v2\/(posts|pages)\/\d+$/.test(route)) return "trash";
  if (method === "POST" && route === "rankmath/v1/updateMeta") return "rankmath";
  return null;
}

function indexResponse(state: MockState): WpResponse {
  const namespaces = ["oembed/1.0", "wp/v2", "wp-site-health/v1"];
  if (state.seed.seoPlugin === "RANK_MATH_ENDPOINT") namespaces.push("rankmath/v1");
  if (state.seed.seoPlugin === "YOAST_EXPOSED" || state.seed.seoPlugin === "YOAST_HIDDEN") {
    namespaces.push("yoast/v1");
  }
  return json(200, {
    name: "Mock WordPress Site",
    description: "",
    url: state.origin,
    home: state.origin,
    namespaces,
    authentication: state.seed.appPasswords
      ? {
          "application-passwords": {
            endpoints: { authorization: `${state.origin}/wp-admin/authorize-application.php` },
          },
        }
      : [],
    routes: {},
  });
}

function listResponse(state: MockState, type: WpType, parsed: Parsed, request: WpRequest): WpResponse {
  const edit = parsed.query.get("context") === "edit";
  const caps = capabilitiesOf(state);
  const signedIn = authorized(state, request);
  if (edit) {
    if (!signedIn) return wpError(401, "rest_forbidden_context");
    if (!caps.edit_posts) return wpError(403, "rest_forbidden_context");
  }
  const slug = parsed.query.get("slug");
  const statusParam = parsed.query.get("status");
  const search = parsed.query.get("search")?.toLowerCase() ?? null;
  const perPage = Math.min(100, Math.max(1, Number(parsed.query.get("per_page") ?? 10) || 10));
  let items = [...state.objects.values()].filter((object) => object.type === type);
  if (!signedIn) items = items.filter((object) => object.status === "publish");
  if (statusParam && statusParam !== "any") {
    const wanted = statusParam.split(",");
    items = items.filter((object) => wanted.includes(object.status));
  } else if (!statusParam) {
    items = items.filter((object) => object.status === "publish");
  } else {
    items = items.filter((object) => object.status !== "trash");
  }
  if (slug) items = items.filter((object) => object.slug === slug);
  if (search) {
    items = items.filter((object) =>
      `${object.title} ${object.excerpt} ${object.content}`.toLowerCase().includes(search),
    );
  }
  if (parsed.query.get("orderby") === "modified") {
    items.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
  }
  return json(
    200,
    items.slice(0, perPage).map((object) => serialize(state, object, edit)),
  );
}

function canEdit(state: MockState, object: MockObject): boolean {
  const caps = capabilitiesOf(state);
  if (object.type === "page") {
    if (!caps.edit_pages) return false;
    if (object.status === "publish" && !caps.edit_published_pages) return false;
  } else {
    if (!caps.edit_posts) return false;
    if (object.status === "publish" && !caps.edit_published_posts) return false;
  }
  return object.mine || caps.edit_others_posts === true;
}

function parseBody(request: WpRequest): Record<string, unknown> | null {
  if (!request.body) return {};
  try {
    const parsed: unknown = JSON.parse(request.body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function handle(state: MockState, request: WpRequest, parsed: Parsed): WpResponse {
  const { method } = request;
  const route = parsed.route;
  const signedIn = authorized(state, request);

  if (route === "" && method === "GET") return indexResponse(state);

  if (route === "wp/v2/users/me" && method === "GET") {
    if (!signedIn) return wpError(401, "rest_not_logged_in");
    return json(200, {
      id: 7,
      name: "Agentelse",
      slug: "agentelse",
      roles: state.seed.roles,
      capabilities: capabilitiesOf(state),
    });
  }

  if (route === "wp/v2/users/me/application-passwords/introspect" && method === "GET") {
    if (!state.seed.appPasswords) return wpError(501, "application_passwords_disabled");
    if (!signedIn) return wpError(401, "rest_not_logged_in");
    return json(200, { uuid: APP_PASSWORD_UUID, name: "Agentelse" });
  }

  const revoke = /^wp\/v2\/users\/me\/application-passwords\/([^/]+)$/.exec(route);
  if (revoke && method === "DELETE") {
    if (!signedIn) return wpError(401, "rest_not_logged_in");
    if (revoke[1] !== APP_PASSWORD_UUID) return wpError(404, "application_password_not_found");
    state.appPasswordRevoked = true;
    return json(200, { deleted: true, previous: { uuid: APP_PASSWORD_UUID } });
  }

  if (route === "rankmath/v1/updateMeta" && method === "POST") {
    if (state.seed.seoPlugin !== "RANK_MATH_ENDPOINT") return wpError(404, "rest_no_route");
    if (!signedIn) return wpError(401, "rest_not_logged_in");
    const body = parseBody(request);
    const id = typeof body?.objectID === "number" ? body.objectID : null;
    const object = id !== null ? state.objects.get(id) : undefined;
    if (!body || !object) return wpError(404, "rest_post_invalid_id");
    if (!canEdit(state, object)) return wpError(403, "rest_cannot_edit");
    const meta = typeof body.meta === "object" && body.meta !== null ? body.meta : {};
    for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
      if (typeof value === "string") object.hiddenMeta[key] = value;
    }
    // updateMeta yazının modified saatini değiştirmez.
    return json(200, { slug: true });
  }

  const collection = /^wp\/v2\/(posts|pages)$/.exec(route);
  if (collection) {
    const type: WpType = collection[1] === "pages" ? "page" : "post";
    if (method === "GET") return listResponse(state, type, parsed, request);
    if (method === "POST" && type === "post") {
      if (!signedIn) return wpError(401, "rest_cannot_create");
      const caps = capabilitiesOf(state);
      if (!caps.edit_posts) return wpError(403, "rest_cannot_create");
      const body = parseBody(request);
      if (!body) return wpError(400, "rest_invalid_json");
      const status = typeof body.status === "string" ? body.status : "draft";
      if (status === "publish" && !caps.publish_posts) {
        return wpError(403, "rest_cannot_publish");
      }
      const title = textOf(body.title) ?? "";
      const id = state.nextId++;
      const slug = slugify(title, (candidate) =>
        [...state.objects.values()].some((object) => object.slug === candidate),
      );
      const object: MockObject = {
        id,
        type: "post",
        status,
        link: status === "publish" ? `${state.origin}/${slug}` : `${state.origin}/?p=${id}`,
        slug,
        modified: stamp(0),
        title: "",
        excerpt: "",
        content: "",
        meta: { [YOAST_TITLE]: "", [YOAST_DESC]: "" },
        hiddenMeta: {},
        mine: true,
      };
      applyFields(state, object, body);
      if (lies.has("create")) applyLie(object, body);
      bump(state, object);
      state.objects.set(id, object);
      return json(201, serialize(state, object, true));
    }
  }

  const single = /^wp\/v2\/(posts|pages)\/(\d+)$/.exec(route);
  if (single) {
    const type: WpType = single[1] === "pages" ? "page" : "post";
    const id = Number(single[2]);
    const object = state.objects.get(id);
    const found = object && object.type === type ? object : undefined;
    const edit = parsed.query.get("context") === "edit";

    if (method === "GET") {
      if (!found) return wpError(404, "rest_post_invalid_id");
      if (edit && !signedIn) return wpError(401, "rest_forbidden_context");
      if (edit && !capabilitiesOf(state).edit_posts) return wpError(403, "rest_forbidden_context");
      if (!signedIn && found.status !== "publish") return wpError(401, "rest_forbidden");
      return json(200, serialize(state, found, edit));
    }
    if (method === "POST") {
      if (!signedIn) return wpError(401, "rest_cannot_edit");
      if (!found) return wpError(404, "rest_post_invalid_id");
      const body = parseBody(request);
      if (!body) return wpError(400, "rest_invalid_json");
      if (!canEdit(state, found)) return wpError(403, "rest_cannot_edit");
      if (body.status === "publish" && found.status !== "publish") {
        if (!capabilitiesOf(state).publish_posts) return wpError(403, "rest_cannot_publish");
      }
      applyFields(state, found, body);
      if (lies.has("update")) applyLie(found, body);
      bump(state, found);
      return json(200, serialize(state, found, true));
    }
    if (method === "DELETE") {
      if (!signedIn) return wpError(401, "rest_cannot_delete");
      if (!found) return wpError(404, "rest_post_invalid_id");
      if (!capabilitiesOf(state).delete_posts) return wpError(403, "rest_cannot_delete");
      if (parsed.query.get("force") === "true") {
        state.objects.delete(id);
        return json(200, { deleted: true, previous: serialize(state, found, true) });
      }
      found.status = "trash";
      bump(state, found);
      return json(200, serialize(state, found, true));
    }
  }

  return wpError(404, "rest_no_route", "No route was found matching the URL and request method.");
}

// Bellek içi WordPress taşıyıcısı: aynı süreçte köken başına bir durum tutar.
export function createMockWpTransport(): WpTransport {
  return async (request) => {
    const url = request.url;
    const state = stateFor(url.origin);
    const parsed = parseRoute(url);
    calls.push({
      method: request.method,
      route: parsed ? parsed.route || "/" : url.pathname,
      query: parsed ? parsed.query.toString() : url.search.replace(/^\?/, ""),
    });

    if (state.seed.redirectTo) {
      return {
        status: 301,
        headers: { location: `${state.seed.redirectTo}${url.pathname}${url.search}` },
        body: "",
        truncated: false,
      };
    }
    if (state.seed.notWordPress) {
      return html(200, "<!doctype html><html><body><h1>Welcome</h1></body></html>");
    }
    if (state.seed.restBlocked) {
      return html(403, "<html><body>Request blocked by the firewall.</body></html>");
    }
    if (!parsed || (parsed.pretty && !state.seed.prettyPermalinks)) {
      return html(404, "<html><body>Not found</body></html>");
    }

    const key = faultKey(request.method, parsed.route);
    const fault = key ? faults.get(key) : undefined;
    const failure = (): WpResponse => {
      if (fault!.status === 0) throw new Error("Mock network failure");
      return wpError(fault!.status, fault!.code ?? "mock_fault");
    };
    // Yazma olmadan hata: hiçbir şey değişmez.
    if (fault && !fault.after) return failure();
    const response = handle(state, request, parsed);
    // Yazma indi, yanıt hata: zaman aşımına uğrayan yazı tatbikatı.
    if (fault && fault.after) return failure();
    return response;
  };
}
