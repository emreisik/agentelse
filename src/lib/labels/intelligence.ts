import {
  Swords,
  Rocket,
  Cpu,
  Search,
  TrendingUp,
  Megaphone,
  Newspaper,
  Users,
  Handshake,
  CalendarDays,
  Radio,
  HeartHandshake,
  Globe2,
  Palette,
  Gauge,
  CircleDot,
} from "lucide-react";
import type {
  BrandConstitutionStatus,
  FactClassification,
  FindingSourceType,
  InsightStatus,
  OpportunityStatus,
  SetupStage,
  SetupStageStatus,
  SignalCategory,
  SignalIntensity,
  SignalStatus,
} from "@prisma/client";

import type { EnumMap } from "./types";

// Mirrors SETUP_STAGE_ORDER in setup-state.repository.ts as a pure UI
// constant (labels layer must not import server-only modules).
export const SETUP_STAGE_ORDER_UI: SetupStage[] = [
  "INTAKE",
  "DEEP_DISCOVERY",
  "BRAND_CONSTITUTION",
  "SIGNAL_PROFILE",
  "BASELINE_AUDITS",
  "GOAL_GENERATION",
  "AGENCY_CONFIGURATION",
  "AUTONOMY_CONFIGURATION",
  "INITIAL_OPPORTUNITIES",
  "INITIAL_IDEA_PORTFOLIO",
  "INITIAL_WORK_PLAN",
  "PROJECT_ACTIVATION",
];

export const SETUP_STAGE: EnumMap<SetupStage> = {
  INTAKE: { label: "Alım", tone: "neutral" },
  DEEP_DISCOVERY: { label: "Derin Keşif", tone: "active" },
  BRAND_CONSTITUTION: { label: "Marka Anayasası", tone: "active" },
  SIGNAL_PROFILE: { label: "Sinyal Profili", tone: "active" },
  BASELINE_AUDITS: { label: "Temel Denetimler", tone: "active" },
  GOAL_GENERATION: { label: "Hedef Üretimi", tone: "active" },
  AGENCY_CONFIGURATION: { label: "Ajans Yapılandırması", tone: "active" },
  AUTONOMY_CONFIGURATION: { label: "Otonomi Yapılandırması", tone: "active" },
  INITIAL_OPPORTUNITIES: { label: "İlk Fırsatlar", tone: "active" },
  INITIAL_IDEA_PORTFOLIO: { label: "İlk Fikir Portföyü", tone: "active" },
  INITIAL_WORK_PLAN: { label: "İlk İş Planı", tone: "active" },
  PROJECT_ACTIVATION: { label: "Proje Aktivasyonu", tone: "positive" },
};

// Short explainer per stage, shown under the stepper labels.
export const SETUP_STAGE_HINTS: Record<SetupStage, string> = {
  INTAKE: "Marka bilgileri alınır ve altyapı hazırlanır",
  DEEP_DISCOVERY: "15 paralel araştırma görevi markayı derinlemesine inceler",
  BRAND_CONSTITUTION: "Bulgulardan versiyonlu marka anayasası sentezlenir",
  SIGNAL_PROFILE: "16 sinyal kategorisinin izleme yoğunluğu belirlenir",
  BASELINE_AUDITS: "Her departman için mevcut durum denetimi yapılır",
  GOAL_GENERATION: "Araştırmadan proje hedefleri önerilir",
  AGENCY_CONFIGURATION: "19 departmanın çalışma modu yapılandırılır",
  AUTONOMY_CONFIGURATION: "Günlük limitler ve otonomi politikası ayarlanır",
  INITIAL_OPPORTUNITIES: "İlk içgörüler fırsatlara dönüştürülür",
  INITIAL_IDEA_PORTFOLIO: "Fırsatlardan çok-mercekli fikirler üretilir",
  INITIAL_WORK_PLAN: "Onaylı fikirler iş planlarına dönüştürülür",
  PROJECT_ACTIVATION: "Proje aktifleşir, sürekli döngü başlar",
};

export const SETUP_STAGE_STATUS: EnumMap<SetupStageStatus> = {
  PENDING: { label: "Bekliyor", tone: "neutral" },
  RUNNING: { label: "Çalışıyor", tone: "active" },
  WAITING_CLIENT: { label: "Kararınız Bekleniyor", tone: "waiting" },
  COMPLETED: { label: "Tamamlandı", tone: "positive" },
  FAILED: { label: "Başarısız", tone: "danger" },
  SKIPPED: { label: "Atlandı", tone: "neutral" },
};

export const SIGNAL_CATEGORY: EnumMap<SignalCategory> = {
  COMPETITOR: { label: "Rakip", tone: "active", icon: Swords },
  PRODUCT_LAUNCH: { label: "Ürün Lansmanı", tone: "active", icon: Rocket },
  TECHNOLOGY: { label: "Teknoloji", tone: "active", icon: Cpu },
  SEO: { label: "SEO", tone: "active", icon: Search },
  SOCIAL_TREND: { label: "Sosyal Trend", tone: "active", icon: TrendingUp },
  PAID_ADVERTISING: { label: "Ücretli Reklam", tone: "active", icon: Megaphone },
  MEDIA: { label: "Medya", tone: "active", icon: Newspaper },
  CREATOR: { label: "Üretici", tone: "active", icon: Users },
  PARTNERSHIP: { label: "Ortaklık", tone: "active", icon: Handshake },
  EVENT: { label: "Etkinlik", tone: "active", icon: CalendarDays },
  OFFLINE: { label: "Geleneksel", tone: "neutral", icon: Radio },
  CUSTOMER: { label: "Müşteri", tone: "active", icon: HeartHandshake },
  MARKET: { label: "Pazar", tone: "active", icon: Globe2 },
  CULTURE: { label: "Kültür", tone: "active", icon: Palette },
  PERFORMANCE: { label: "Performans", tone: "active", icon: Gauge },
  OTHER: { label: "Diğer", tone: "neutral", icon: CircleDot },
};

export const SIGNAL_INTENSITY: EnumMap<SignalIntensity> = {
  VERY_HIGH: { label: "Çok Yüksek", tone: "danger" },
  HIGH: { label: "Yüksek", tone: "waiting" },
  MEDIUM: { label: "Orta", tone: "active" },
  LOW: { label: "Düşük", tone: "neutral" },
  OFF: { label: "Kapalı", tone: "neutral" },
};

export const SIGNAL_INTENSITY_HINT: Record<SignalIntensity, string> = {
  VERY_HIGH: "4 saatte bir tarama",
  HIGH: "12 saatte bir tarama",
  MEDIUM: "24 saatte bir tarama",
  LOW: "72 saatte bir tarama",
  OFF: "Tarama yapılmaz",
};

export const SIGNAL_STATUS: EnumMap<SignalStatus> = {
  NEW: { label: "Yeni", tone: "neutral" },
  SCORED: { label: "Skorlandı", tone: "active" },
  PROMOTED: { label: "Yükseltildi", tone: "positive" },
  DISCARDED: { label: "Elendi", tone: "neutral" },
  DUPLICATE: { label: "Mükerrer", tone: "special" },
};

export const FACT_CLASSIFICATION: EnumMap<FactClassification> = {
  VERIFIED_FACT: { label: "Doğrulanmış Gerçek", tone: "positive" },
  LIKELY_FACT: { label: "Olası Gerçek", tone: "active" },
  ASSUMPTION: { label: "Varsayım", tone: "waiting" },
  CONTRADICTION: { label: "Çelişki", tone: "danger" },
  UNKNOWN: { label: "Bilinmiyor", tone: "neutral" },
  RECOMMENDATION: { label: "Öneri", tone: "special" },
};

export const FINDING_SOURCE_TYPE: EnumMap<FindingSourceType> = {
  RESEARCH_TASK: { label: "Araştırma Görevi", tone: "active" },
  SIGNAL: { label: "Sinyal", tone: "active" },
  AUDIT: { label: "Denetim", tone: "neutral" },
  CLIENT_INPUT: { label: "Müşteri Girdisi", tone: "special" },
  LEARNING: { label: "Öğrenim", tone: "positive" },
};

export const INSIGHT_STATUS: EnumMap<InsightStatus> = {
  NEW: { label: "Yeni", tone: "neutral" },
  EVALUATED: { label: "Değerlendirildi", tone: "active" },
  PROMOTED: { label: "Fırsata Dönüştü", tone: "positive" },
  ARCHIVED: { label: "Arşivlendi", tone: "neutral" },
};

export const OPPORTUNITY_STATUS: EnumMap<OpportunityStatus> = {
  NEW: { label: "Yeni", tone: "neutral" },
  REVIEWING: { label: "İnceleniyor", tone: "active" },
  EVALUATED: { label: "Değerlendirildi", tone: "active" },
  ACCEPTED: { label: "Kabul Edildi", tone: "positive" },
  DISMISSED: { label: "Yoksayıldı", tone: "neutral" },
  CONVERTED_TO_TASK: { label: "Göreve Dönüştü", tone: "special" },
  CONVERTED_TO_IDEA: { label: "Fikre Dönüştü", tone: "special" },
  EXPIRED: { label: "Süresi Doldu", tone: "neutral" },
  DUPLICATE: { label: "Mükerrer", tone: "special" },
};

export const CONSTITUTION_STATUS: EnumMap<BrandConstitutionStatus> = {
  DRAFT: { label: "Taslak", tone: "neutral" },
  ACTIVE: { label: "Aktif", tone: "positive" },
  SUPERSEDED: { label: "Eski Sürüm", tone: "neutral" },
};

// The 22 BrandConstitution payload sections, in display order.
export const CONSTITUTION_SECTIONS: Array<{ key: string; label: string }> = [
  { key: "identity", label: "Kimlik" },
  { key: "businessModel", label: "İş Modeli" },
  { key: "products", label: "Ürünler" },
  { key: "markets", label: "Pazarlar" },
  { key: "audiences", label: "Hedef Kitleler" },
  { key: "positioning", label: "Konumlandırma" },
  { key: "valueProposition", label: "Değer Önerisi" },
  { key: "personality", label: "Marka Kişiliği" },
  { key: "toneOfVoice", label: "Ses Tonu" },
  { key: "visualIdentity", label: "Görsel Kimlik" },
  { key: "logoAssetIds", label: "Logo Varlıkları" },
  { key: "approvedClaims", label: "Onaylı İddialar" },
  { key: "forbiddenClaims", label: "Yasaklı İddialar" },
  { key: "negativeBrief", label: "Negatif Brief" },
  { key: "customerProblems", label: "Müşteri Problemleri" },
  { key: "customerObjections", label: "Müşteri İtirazları" },
  { key: "competitors", label: "Rakipler" },
  { key: "differentiators", label: "Farklılaştırıcılar" },
  { key: "legalRestrictions", label: "Yasal Kısıtlar" },
  { key: "knownFacts", label: "Bilinen Gerçekler" },
  { key: "assumptions", label: "Varsayımlar" },
  { key: "openQuestions", label: "Açık Sorular" },
];
