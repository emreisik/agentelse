// SC-F8: WordPress REST yanıtlarını (context=edit) toleranslı biçimde ayrıştırır.
// Alan adları WordPress çekirdek REST şemasından gelir (doğrulanmalı: gerçek bir
// siteye karşı). Saf modül; ağ yok.

import type { WpType } from "../types";
import type { WpIndex, WpMe, WpObject } from "./wp-types";

type JsonObject = { [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// {raw, rendered} biçimli alan: raw varsa o, yoksa rendered, düz metin de olur.
function rawOrRendered(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isObject(value)) return "";
  return asString(value.raw) ?? asString(value.rendered) ?? "";
}

// WordPress modified_gmt'yi saat dilimsiz verir ("2024-05-01T10:00:00").
function toIsoUtc(value: unknown): string | null {
  const text = asString(value)?.trim();
  if (!text) return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return text;
  return `${text}Z`;
}

export function parseWpObject(json: unknown, type: WpType): WpObject | null {
  if (!isObject(json)) return null;
  const id = json.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;
  const status = asString(json.status);
  const link = asString(json.link);
  if (!status || !link) return null;

  // content.raw yalnız edit bağlamında ve yetkiliyken gelir; korumalı yazıda yok.
  let content: string | null = null;
  if (isObject(json.content) && typeof json.content.raw === "string") {
    content = json.content.raw;
  }

  // meta boş olduğunda WordPress [] (dizi) döndürebilir.
  const meta = isObject(json.meta) ? { ...json.meta } : {};

  return {
    id,
    type,
    status,
    link,
    slug: asString(json.slug) ?? "",
    modified: toIsoUtc(json.modified_gmt) ?? toIsoUtc(json.modified) ?? "",
    title: rawOrRendered(json.title),
    excerpt: rawOrRendered(json.excerpt),
    content,
    meta,
  };
}

export function parseWpIndex(json: unknown): WpIndex | null {
  if (!isObject(json)) return null;
  const namespaces = json.namespaces;
  if (!Array.isArray(namespaces)) return null;
  const names = namespaces.filter(
    (item): item is string => typeof item === "string",
  );
  if (!names.includes("wp/v2")) return null;
  const authentication = isObject(json.authentication)
    ? json.authentication
    : null;
  return {
    name: asString(json.name),
    url: asString(json.url),
    namespaces: names,
    appPasswords: Boolean(
      authentication && isObject(authentication["application-passwords"]),
    ),
  };
}

export function parseWpMe(json: unknown): WpMe | null {
  if (!isObject(json)) return null;
  const id = json.id;
  if (typeof id !== "number" || !Number.isInteger(id)) return null;
  const roles = Array.isArray(json.roles)
    ? json.roles.filter((role): role is string => typeof role === "string")
    : [];
  const capabilities: Record<string, boolean> = {};
  if (isObject(json.capabilities)) {
    for (const [key, value] of Object.entries(json.capabilities)) {
      if (value === true) capabilities[key] = true;
      else if (value === false) capabilities[key] = false;
    }
  }
  return { id, name: asString(json.name), roles, capabilities };
}
