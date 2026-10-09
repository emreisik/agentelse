import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { CapabilityKey } from "@prisma/client";

import { AgentelseError } from "@/server/security/errors";

import type { UsageMeter } from "./usage-meter";

// Kullanım kapsamı: bir ücretli dış çağrının KİME ve HANGİ işe ait olduğu.
// Giriş noktaları (worker işi, ReasoningService.run, sunucu eylemi, cron adımı)
// kapsamı bir kez kurar; alt seviye istemciler (openai-client, görsel, fal, ...)
// gerçek kullanımı bu kapsamla yazar (usage-recorder.ts). Böylece art-director,
// copywriter, execution sağlayıcıları ve ileride eklenecek her çağrı çağıran
// tarafta değişiklik gerektirmeden ölçülür.
//
// Kapsamsız çağrı atılmaz: "unattributed" olarak yazılır ve raporda ayrıca
// sayılır — eksik bir giriş noktasını böyle buluruz.

export type UsageModule =
  "SOCIAL" | "ADS" | "ANALYTICS" | "SEO" | "CHAT" | "OTHER";

export type UsageScope = {
  workspaceId: string;
  projectId?: string;
  userId?: string;
  module?: UsageModule;
  // reasoning | execution | chat | action | cron | embeddings ...
  source?: string;
  // ReasoningDef.purpose ya da capability anahtarı.
  purpose?: string;
  // Aynı işin çağrılarını toplar; verilmezse yeni üretilir.
  operationId: string;
  // Bu operasyonun gerçek maliyet sayacı (operation.ts kurar; recordUsage her
  // ücretli çağrıyı buraya da ekler). İç içe kapsamlar dıştakini miras alır, ama
  // YALNIZ aynı workspace'te: başka bir workspace'e geçen kapsam sayacı bırakır.
  meter?: UsageMeter;
};

const storage = new AsyncLocalStorage<UsageScope>();

export function getUsageScope(): UsageScope | undefined {
  return storage.getStore();
}

// Arka plan işareti (Faz 3C): zamanlayıcı tick'inin adımları gibi sistemin KENDİ
// başlattığı akışlar bununla çalışır; içeride açılan ücretli işlemler (motor çağrıları,
// hafta planlayıcı) varsayılan olarak "sistem başlattı" sayılır ve plan hakkının
// arka plan payına tabidir (plans.ts BACKGROUND_SHARE_PCT). İşaretsiz her akış
// kullanıcıdır ve payla hiç karşılaşmaz: eksik bir işaret kimseyi engellemez.
const background = new AsyncLocalStorage<true>();

export function runAsBackground<T>(fn: () => T): T {
  return background.run(true, fn);
}

export function isBackground(): boolean {
  return background.getStore() === true;
}

// Görevi kim yarattıysa o başlatmıştır: kullanıcının kendisi ise kullanıcı, sistem ya da
// yapay zekâ (otonom döngü, öneri) ise sistem.
export function initiatorOfActor(createdByType: string): "user" | "system" {
  return createdByType === "USER" ? "user" : "system";
}

// Görev başına azami maliyet ("her göreve maksimum bütçe"): operasyonun sayacı
// tavanı aştıysa SONRAKİ ücretli çağrı başlamaz (aşan çağrı yapılmıştır, ücreti
// sayaçta). Her ücretli istemci çağrıdan önce bunu çağırır. Tavan yalnız
// faturalama açıkken konur (job-billing.ts); kapalıyken sayaçta tavan yoktur ve
// burası hiçbir şey yapmaz. Hata BUDGET_EXCEEDED'dır: bütçe duruşunu tanıyan
// tüm tüketiciler (iş: kalıcı hata, motor: ertele) zaten bunu işler.
export function assertTaskRoom(): void {
  const meter = storage.getStore()?.meter;
  if (meter?.exceeded) {
    throw new AgentelseError(
      "BUDGET_EXCEEDED",
      "This task reached its cost limit",
      {
        meta: { limit: "taskCeiling" },
      },
    );
  }
}

export type UsageScopeInput = Omit<UsageScope, "operationId"> & {
  operationId?: string;
};

// Kapsamı kurar. İçteki çağrı dıştakinin operationId'sini miras alır (bir iş
// içindeki ReasoningService çağrıları aynı işe yazılır); açıkça verilen alanlar
// dıştakini ezer.
export function runWithUsageScope<T>(scope: UsageScopeInput, fn: () => T): T {
  const parent = storage.getStore();
  const merged: UsageScope = {
    ...parent,
    ...stripUndefined(scope),
    workspaceId: scope.workspaceId,
    operationId: scope.operationId ?? parent?.operationId ?? randomUUID(),
  };
  // Tenant izolasyonu: sayaç kendi workspace'inin dışında hiçbir şey toplamaz.
  if (merged.meter && merged.meter.workspaceId !== merged.workspaceId) {
    delete merged.meter;
  }
  return storage.run(merged, fn);
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

// Yetenek anahtarından ürün modülü. Tam (exhaustive) tablo: şemaya yeni bir
// CapabilityKey eklenip buraya yazılmazsa derleme hata verir, böylece bir
// yeteneğin maliyeti sessizce "OTHER"a düşmez.
const CAPABILITY_MODULE: Record<CapabilityKey, UsageModule> = {
  BRAND_DISCOVERY: "OTHER",
  WEB_RESEARCH: "OTHER",
  WEB_BROWSING: "OTHER",
  DATA_EXTRACTION: "OTHER",
  SCREENSHOT_CAPTURE: "OTHER",
  COMPETITOR_RESEARCH: "OTHER",
  COMPETITOR_MONITORING: "OTHER",
  COMPETITOR_CHANGE_DETECTION: "OTHER",
  MARKET_RESEARCH: "OTHER",
  TREND_RESEARCH: "OTHER",
  CUSTOMER_INTELLIGENCE: "OTHER",
  SEO_RESEARCH: "SEO",
  SEO_ANALYSIS: "SEO",
  ASO_ANALYSIS: "SEO",
  SOCIAL_RESEARCH: "SOCIAL",
  SOCIAL_ACCOUNT_SETUP: "SOCIAL",
  SOCIAL_PROFILE_AUDIT: "SOCIAL",
  CREATE_SOCIAL_CREATIVE: "SOCIAL",
  CREATE_AD_CREATIVE: "ADS",
  CREATE_COPY: "SOCIAL",
  CREATE_CAPTION: "SOCIAL",
  CREATE_CAMPAIGN_BRIEF: "ADS",
  CREATE_CONTENT_PLAN: "SOCIAL",
  GENERATE_IDEAS: "SOCIAL",
  INSTAGRAM_PUBLISH: "SOCIAL",
  TIKTOK_PUBLISH: "SOCIAL",
  LINKEDIN_PUBLISH: "SOCIAL",
  X_PUBLISH: "SOCIAL",
  FACEBOOK_PUBLISH: "SOCIAL",
  META_ADS_ANALYSIS: "ADS",
  META_CAMPAIGN_CREATE: "ADS",
  META_CAMPAIGN_UPDATE: "ADS",
  META_ADSET_CREATE: "ADS",
  META_ADSET_UPDATE: "ADS",
  META_AD_CREATE: "ADS",
  META_AD_UPDATE: "ADS",
  META_SAFETY_ACTION: "ADS",
  META_LAUNCH: "ADS",
  GOOGLE_ADS_ANALYSIS: "ADS",
  GOOGLE_ADS_CAMPAIGN_CREATE: "ADS",
  ANALYTICS_ANALYSIS: "ANALYTICS",
  ANALYTICS_EDIT: "ANALYTICS",
  CRM_ANALYSIS: "OTHER",
  EMAIL_DRAFT: "OTHER",
  EMAIL_SEND: "OTHER",
  CLAIM_VALIDATION: "OTHER",
  BRAND_SAFETY: "OTHER",
  REPORTING: "ANALYTICS",
  VERIFY_EXTERNAL_ACTION: "OTHER",
  PRODUCT_RESEARCH: "OTHER",
  MEDIA_RESEARCH: "OTHER",
  CULTURAL_RESEARCH: "OTHER",
  CREATOR_RESEARCH: "SOCIAL",
  PARTNERSHIP_RESEARCH: "OTHER",
  ADVERTISING_RESEARCH: "ADS",
  REVIEW_RESEARCH: "OTHER",
  TECHNOLOGY_RESEARCH: "OTHER",
  SIGNAL_SCAN: "OTHER",
  MEASUREMENT_CHECK: "ANALYTICS",
  WEBSITE_UPDATE: "OTHER",
  PR_OUTREACH: "OTHER",
};

// Sağlayıcı çağrısı yapan amaçtan/yetenekten ürün modülü. Yetenek anahtarları
// (BÜYÜK_HARF) tablodan, ReasoningDef/eylem purpose adları (küçük harf, noktalı)
// önekten sınıflanır. Raporda gruplamak içindir; ayrıntı purpose'tadır.
export function moduleOf(purposeOrCapability: string | undefined): UsageModule {
  if (!purposeOrCapability) return "OTHER";
  if (Object.hasOwn(CAPABILITY_MODULE, purposeOrCapability)) {
    return CAPABILITY_MODULE[purposeOrCapability as CapabilityKey];
  }
  const key = purposeOrCapability.toLowerCase();
  if (key.startsWith("chat")) return "CHAT";
  // "idea.seo" idea.* kuralından ÖNCE: SEO fikri SEO maliyetidir.
  if (key.startsWith("seo") || key.startsWith("gsc") || key === "idea.seo") {
    return "SEO";
  }
  if (
    key.startsWith("ga.") ||
    key.startsWith("ga_") ||
    key.startsWith("analytics")
  ) {
    return "ANALYTICS";
  }
  if (key.startsWith("ads") || key.startsWith("meta-ads")) return "ADS";
  if (
    key.startsWith("idea") ||
    key.startsWith("plan.") ||
    key.startsWith("image") ||
    key.startsWith("creative") ||
    key.startsWith("logo") ||
    key.startsWith("week-planner") ||
    key.startsWith("content.") ||
    key.startsWith("brand.media") ||
    key.startsWith("brand.poststyle")
  ) {
    return "SOCIAL";
  }
  return "OTHER";
}
