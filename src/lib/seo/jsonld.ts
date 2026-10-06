// JSON-LD yapılandırılmış veri denetimi (docs/google-search-console-plan.md
// SC-F3, TA21). Her <script type="application/ld+json"> bloğu ayrıştırılır;
// türler kökten, dizilerden ve @graph'tan (derinlik ≤ 4) toplanır, Google'ın
// zengin sonuçlar için istediği temel alanlar aranır. Saf modül.

export type JsonLdResult = {
  types: string[];
  errors: string[];
  items: { type: string; missing: string[] }[];
};

export const REQUIRED_PROPS: Readonly<Record<string, readonly string[]>> = {
  Organization: ["name"],
  LocalBusiness: ["name", "address"],
  Product: ["name"],
  Article: ["headline"],
  BlogPosting: ["headline"],
  NewsArticle: ["headline"],
  BreadcrumbList: ["itemListElement"],
  Event: ["name", "startDate", "location"],
  FAQPage: ["mainEntity"],
  VideoObject: ["name", "thumbnailUrl", "uploadDate"],
  Review: ["itemReviewed", "author"],
  WebSite: ["name"],
};

const MAX_ERRORS = 20;
const MAX_DEPTH = 4;
const MAX_ITEMS = 100;

type JsonObject = { [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// "https://schema.org/Product", "schema:Product" → "Product".
function cleanType(value: string): string {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  for (const prefix of [
    "https://schema.org/",
    "http://schema.org/",
    "schema:",
  ]) {
    if (lower.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return trimmed;
}

function typesOf(node: JsonObject): string[] {
  const raw = node["@type"];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .filter((value): value is string => typeof value === "string")
    .map(cleanType)
    .filter(Boolean);
}

function isMissing(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function inspectJsonLd(blocks: readonly string[]): JsonLdResult {
  const types: string[] = [];
  const errors: string[] = [];
  const items: { type: string; missing: string[] }[] = [];
  const addError = (message: string) => {
    if (errors.length < MAX_ERRORS && !errors.includes(message))
      errors.push(message);
  };

  const visit = (value: unknown, depth: number, isRoot: boolean) => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1, isRoot);
      return;
    }
    if (!isObject(value)) return;
    if (isRoot && !("@context" in value)) addError("Missing @context");
    for (const type of typesOf(value)) {
      if (!types.includes(type)) types.push(type);
      if (!Object.hasOwn(REQUIRED_PROPS, type)) continue;
      const required = REQUIRED_PROPS[type] ?? [];
      const missing = required.filter((prop) => isMissing(value[prop]));
      if (items.length < MAX_ITEMS) items.push({ type, missing });
      for (const prop of missing) addError(`${type} is missing ${prop}`);
    }
    // @graph düğümleri kökün @context'ini paylaşır.
    if (Array.isArray(value["@graph"])) {
      for (const entry of value["@graph"]) visit(entry, depth + 1, false);
    }
  };

  blocks.forEach((block, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.trim());
    } catch {
      addError(`Structured data block ${index + 1} is not valid JSON`);
      return;
    }
    visit(parsed, 0, true);
  });

  return { types, errors, items };
}
