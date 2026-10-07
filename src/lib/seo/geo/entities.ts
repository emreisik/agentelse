import { tokenizeHtml } from "@/lib/seo/html-audit";

import type { OrgFacts } from "./types";

// Ana sayfadaki JSON-LD'den kurum olguları (SC-F8 GEO5, GEO6, GEO11). Saf.
// Bloklar tokenizeHtml ile çıkarılır; ayrıştırılamayan blok sessizce atlanır.

export const JSONLD_MAX_BLOCKS = 20;
export const JSONLD_MAX_BLOCK_BYTES = 100_000;
const SAME_AS_MAX = 20;
const NAME_MAX = 200;
const TYPES_MAX = 10;
const MAX_DEPTH = 4;

// Organization ve Google'ın işletme alt türleri (sabit liste).
const ORG_TYPES: ReadonlySet<string> = new Set([
  "Organization",
  "Corporation",
  "LocalBusiness",
  "NGO",
  "OnlineBusiness",
  "OnlineStore",
  "EducationalOrganization",
  "CollegeOrUniversity",
  "School",
  "GovernmentOrganization",
  "MedicalOrganization",
  "MedicalClinic",
  "Hospital",
  "Dentist",
  "Physician",
  "Pharmacy",
  "SportsOrganization",
  "SportsTeam",
  "NewsMediaOrganization",
  "PerformingGroup",
  "Airline",
  "Library",
  "ResearchOrganization",
  "ProfessionalService",
  "LegalService",
  "Attorney",
  "AccountingService",
  "FinancialService",
  "BankOrCreditUnion",
  "InsuranceAgency",
  "RealEstateAgent",
  "TravelAgency",
  "AutomotiveBusiness",
  "AutoDealer",
  "AutoRepair",
  "Store",
  "Restaurant",
  "FoodEstablishment",
  "CafeOrCoffeeShop",
  "BarOrPub",
  "Bakery",
  "Hotel",
  "LodgingBusiness",
  "HealthAndBeautyBusiness",
  "BeautySalon",
  "HairSalon",
  "DaySpa",
  "HealthClub",
  "GymOrFitnessCenter",
  "HomeAndConstructionBusiness",
  "Electrician",
  "Plumber",
  "RoofingContractor",
  "MovingCompany",
  "EntertainmentBusiness",
  "ChildCare",
  "EmploymentAgency",
  "Notary",
  "Florist",
  "ShoppingCenter",
  "TouristInformationCenter",
]);

type JsonObject = { [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// <script type="application/ld+json"> blokları, en çok 20, her biri ≤ 100 KB.
export function extractJsonLdBlocks(html: string): string[] {
  const blocks: string[] = [];
  const tokens = tokenizeHtml(html);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.type !== "open" || token.name !== "script") continue;
    const type = (token.attrs.type ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/ld+json") continue;
    const next = tokens[index + 1];
    if (!next || next.type !== "raw" || next.name !== "script") continue;
    const text = next.text.trim();
    if (!text || text.length > JSONLD_MAX_BLOCK_BYTES) continue;
    blocks.push(text);
    if (blocks.length >= JSONLD_MAX_BLOCKS) break;
  }
  return blocks;
}

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

function textOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, NAME_MAX) : null;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" || !parsed.hostname) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function sameAsOf(node: JsonObject): string[] {
  const raw = node.sameAs;
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const entry of list) {
    const url = httpsUrl(entry);
    if (url) out.push(url);
  }
  return out;
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function organizationFacts(blocks: readonly string[]): OrgFacts {
  const types: string[] = [];
  const sameAs: string[] = [];
  let name: string | null = null;
  let hasLogo = false;
  let present = false;

  const visit = (value: unknown, depth: number) => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (!isObject(value)) return;
    const found = typesOf(value).filter((type) => ORG_TYPES.has(type));
    if (found.length > 0) {
      present = true;
      for (const type of found) {
        if (types.length < TYPES_MAX && !types.includes(type)) types.push(type);
      }
      if (name === null) name = textOf(value.name);
      if (hasValue(value.logo) || hasValue(value.image)) hasLogo = true;
      for (const url of sameAsOf(value)) {
        if (sameAs.length < SAME_AS_MAX && !sameAs.includes(url)) {
          sameAs.push(url);
        }
      }
    }
    for (const child of Object.values(value)) {
      if (typeof child === "object" && child !== null) visit(child, depth + 1);
    }
  };

  for (const block of blocks) {
    try {
      visit(JSON.parse(block) as unknown, 0);
    } catch {
      // Bozuk JSON-LD yok sayılır.
    }
  }
  return { present, types, name, sameAs, hasLogo };
}

// Hukuki ek ve dolgu sözcükleri eşleşmeyi bozmasın.
const FILLER = new Set([
  "inc",
  "llc",
  "ltd",
  "gmbh",
  "co",
  "corp",
  "company",
  "the",
  "and",
  "ve",
  "sa",
  "sas",
  "ag",
  "bv",
  "srl",
]);

function brandTokens(value: string): Set<string> {
  const tokens = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !FILLER.has(token));
  return new Set(tokens);
}

// Normalleştirilmiş sözcük örtüşmesi ≥ 0.5 (küçük kümeye göre).
export function brandMatches(a: string, b: string): boolean {
  const left = brandTokens(a);
  const right = brandTokens(b);
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size) >= 0.5;
}
