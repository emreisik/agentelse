import {
  Sparkles,
  Globe2,
  HeartHandshake,
  Swords,
  Palette,
  Brush,
  PenTool,
  Share2,
  Search,
  Gauge,
  BarChart3,
  TrendingUp,
  Newspaper,
  Users,
  Handshake,
  Repeat,
  MonitorSmartphone,
  CalendarDays,
  Radio,
} from "lucide-react";
import type {
  AgencyTriggerStatus,
  AgencyTriggerType,
  CapabilityKey,
  DepartmentKey,
  DepartmentMode,
  MeasurementCheckStatus,
  MeasurementPlanStatus,
  ProjectGoalStatus,
  WorkHandoffStatus,
  WorkPlanStatus,
  WorkPlanType,
} from "@prisma/client";

import type { EnumMap } from "./types";

export const DEPARTMENT_KEY: EnumMap<DepartmentKey> = {
  BRAND_STRATEGY: {
    label: "Brand Strategy Team",
    tone: "active",
    icon: Sparkles,
  },
  MARKET_INTELLIGENCE: {
    label: "Market Intelligence Team",
    tone: "active",
    icon: Globe2,
  },
  CUSTOMER_INTELLIGENCE: {
    label: "Customer Intelligence Team",
    tone: "active",
    icon: HeartHandshake,
  },
  COMPETITOR_INTELLIGENCE: {
    label: "Competitor Intelligence Team",
    tone: "active",
    icon: Swords,
  },
  CREATIVE: { label: "Creative Team", tone: "active", icon: Palette },
  ART_DIRECTION: { label: "Art Direction Team", tone: "active", icon: Brush },
  COPY_CONTENT: { label: "Copy & Content Team", tone: "active", icon: PenTool },
  SOCIAL_MEDIA: { label: "Social Media Team", tone: "active", icon: Share2 },
  SEO: { label: "SEO Team", tone: "active", icon: Search },
  PERFORMANCE_MARKETING: {
    label: "Performance Marketing Team",
    tone: "active",
    icon: Gauge,
  },
  DATA_ANALYTICS: {
    label: "Data & Analytics Team",
    tone: "active",
    icon: BarChart3,
  },
  GROWTH: { label: "Growth Team", tone: "active", icon: TrendingUp },
  PR_MEDIA: { label: "PR & Media Team", tone: "active", icon: Newspaper },
  INFLUENCER_CREATOR: {
    label: "Influencer & Creator Team",
    tone: "active",
    icon: Users,
  },
  PARTNERSHIPS: { label: "Partnerships Team", tone: "active", icon: Handshake },
  CRM_LIFECYCLE: {
    label: "CRM & Lifecycle Team",
    tone: "active",
    icon: Repeat,
  },
  WEB_PRODUCT: {
    label: "Web & Product Team",
    tone: "active",
    icon: MonitorSmartphone,
  },
  EVENTS: { label: "Events Team", tone: "neutral", icon: CalendarDays },
  OFFLINE_MEDIA: { label: "Offline Media Team", tone: "neutral", icon: Radio },
};

export const ALL_DEPARTMENT_KEYS_UI = Object.keys(
  DEPARTMENT_KEY,
) as DepartmentKey[];

// Departman "takım rengi" kimliği — StatusTone'dan bağımsız ayrı bir görsel
// kanal (bkz. StatusBadge accentColor). 19 departman, kolorblind-güvenli
// olarak doğrulanmış 4 kategorik aileye gruplanır; departmanın tam kimliğini
// her zaman ikon + "X Team" etiketi taşır, renk yalnızca hızlı görsel tarama
// içindir.
export const DEPARTMENT_COLOR: Record<DepartmentKey, string> = {
  BRAND_STRATEGY: "var(--dept-strategy)",
  PARTNERSHIPS: "var(--dept-strategy)",
  PR_MEDIA: "var(--dept-strategy)",
  EVENTS: "var(--dept-strategy)",
  OFFLINE_MEDIA: "var(--dept-strategy)",

  MARKET_INTELLIGENCE: "var(--dept-intel)",
  CUSTOMER_INTELLIGENCE: "var(--dept-intel)",
  COMPETITOR_INTELLIGENCE: "var(--dept-intel)",

  CREATIVE: "var(--dept-creative)",
  ART_DIRECTION: "var(--dept-creative)",
  COPY_CONTENT: "var(--dept-creative)",
  SOCIAL_MEDIA: "var(--dept-creative)",
  INFLUENCER_CREATOR: "var(--dept-creative)",

  SEO: "var(--dept-growth)",
  PERFORMANCE_MARKETING: "var(--dept-growth)",
  DATA_ANALYTICS: "var(--dept-growth)",
  GROWTH: "var(--dept-growth)",
  CRM_LIFECYCLE: "var(--dept-growth)",
  WEB_PRODUCT: "var(--dept-growth)",
};

export const DEPARTMENT_MODE: EnumMap<DepartmentMode> = {
  OFF: { label: "Kapalı", tone: "neutral" },
  LISTEN: { label: "Dinle", tone: "neutral" },
  SUGGEST: { label: "Öner", tone: "active" },
  PREPARE: { label: "Hazırla", tone: "waiting" },
  EXECUTE: { label: "Uygula", tone: "positive" },
};

export const DEPARTMENT_MODE_HINT: Record<DepartmentMode, string> = {
  OFF: "Hiç çalışmaz",
  LISTEN: "Yalnızca sinyal toplar",
  SUGGEST: "Sinyal toplar, fırsat ve fikir önerir",
  PREPARE: "İşi hazırlar, onay bekler",
  EXECUTE: "Politika izin verdiği ölçüde işi tamamlar",
};

export const WORK_PLAN_TYPE: EnumMap<WorkPlanType> = {
  SINGLE_TASK: { label: "Tek Görev", tone: "neutral" },
  EXPERIMENT: { label: "Deney", tone: "active" },
  CAMPAIGN: { label: "Kampanya", tone: "positive" },
  MULTI_DEPARTMENT: { label: "Çok Departmanlı", tone: "positive" },
};

export const WORK_PLAN_STATUS: EnumMap<WorkPlanStatus> = {
  DRAFT: { label: "Taslak", tone: "neutral" },
  AWAITING_APPROVAL: { label: "Onay Bekliyor", tone: "waiting" },
  APPROVED: { label: "Onaylandı", tone: "positive" },
  IN_PROGRESS: { label: "Yürütülüyor", tone: "active" },
  COMPLETED: { label: "Tamamlandı", tone: "positive" },
  CANCELLED: { label: "İptal Edildi", tone: "neutral" },
  FAILED: { label: "Başarısız", tone: "danger" },
};

// İşler → Planlar kanban sütunları — TASK_BOARD_COLUMNS'un (core.ts) plan
// yaşam döngüsü karşılığı.
export const WORK_PLAN_BOARD_COLUMNS: Array<{
  key: string;
  label: string;
  statuses: WorkPlanStatus[];
}> = [
  {
    key: "hazirlaniyor",
    label: "Hazırlanıyor",
    statuses: ["DRAFT", "AWAITING_APPROVAL"],
  },
  { key: "onaylandi", label: "Onaylandı", statuses: ["APPROVED"] },
  { key: "yurutuluyor", label: "Yürütülüyor", statuses: ["IN_PROGRESS"] },
  { key: "tamamlandi", label: "Tamamlandı", statuses: ["COMPLETED"] },
  { key: "sorunlu", label: "Sorunlu", statuses: ["CANCELLED", "FAILED"] },
];

export const WORK_HANDOFF_STATUS: EnumMap<WorkHandoffStatus> = {
  PROPOSED: { label: "Önerildi", tone: "waiting" },
  ACCEPTED: { label: "Kabul Edildi", tone: "active" },
  TASK_CREATED: { label: "Görev Oluşturuldu", tone: "active" },
  COMPLETED: { label: "Tamamlandı", tone: "positive" },
  REJECTED: { label: "Reddedildi", tone: "danger" },
  EXPIRED: { label: "Süresi Doldu", tone: "neutral" },
};

// İşler → Devirler kanban sütunları.
export const WORK_HANDOFF_BOARD_COLUMNS: Array<{
  key: string;
  label: string;
  statuses: WorkHandoffStatus[];
}> = [
  { key: "onerildi", label: "Önerildi", statuses: ["PROPOSED"] },
  { key: "kabul", label: "Kabul Edildi", statuses: ["ACCEPTED"] },
  { key: "gorev", label: "Görev Oluşturuldu", statuses: ["TASK_CREATED"] },
  { key: "tamamlandi", label: "Tamamlandı", statuses: ["COMPLETED"] },
  { key: "sorunlu", label: "Sorunlu", statuses: ["REJECTED", "EXPIRED"] },
];

export const PROJECT_GOAL_STATUS: EnumMap<ProjectGoalStatus> = {
  PROPOSED: { label: "Önerildi", tone: "waiting" },
  APPROVED: { label: "Onaylandı", tone: "positive" },
  ACTIVE: { label: "Aktif", tone: "positive" },
  PAUSED: { label: "Duraklatıldı", tone: "neutral" },
  ACHIEVED: { label: "Başarıldı", tone: "special" },
  REJECTED: { label: "Reddedildi", tone: "danger" },
  ARCHIVED: { label: "Arşivlendi", tone: "neutral" },
};

export const MEASUREMENT_PLAN_STATUS: EnumMap<MeasurementPlanStatus> = {
  ACTIVE: { label: "Aktif", tone: "active" },
  COMPLETED: { label: "Tamamlandı", tone: "positive" },
  CANCELLED: { label: "İptal Edildi", tone: "neutral" },
};

// İşler → Ölçümler kanban sütunları — sadece 3 durum var, diğer İşler
// panolarıyla aynı sistemin en küçük hali.
export const MEASUREMENT_PLAN_BOARD_COLUMNS: Array<{
  key: string;
  label: string;
  statuses: MeasurementPlanStatus[];
}> = [
  { key: "aktif", label: "Aktif", statuses: ["ACTIVE"] },
  { key: "tamamlandi", label: "Tamamlandı", statuses: ["COMPLETED"] },
  { key: "iptal", label: "İptal", statuses: ["CANCELLED"] },
];

export const MEASUREMENT_CHECK_STATUS: EnumMap<MeasurementCheckStatus> = {
  PENDING: { label: "Bekliyor", tone: "neutral" },
  SCHEDULED: { label: "Zamanlandı", tone: "waiting" },
  RUNNING: { label: "Çalışıyor", tone: "active" },
  COMPLETED: { label: "Tamamlandı", tone: "positive" },
  FAILED: { label: "Başarısız", tone: "danger" },
  SKIPPED: { label: "Atlandı", tone: "neutral" },
};

export const AGENCY_TRIGGER_TYPE: EnumMap<AgencyTriggerType> = {
  SCHEDULE: { label: "Zamanlama", tone: "neutral" },
  USER_COMMAND: { label: "Kullanıcı Komutu", tone: "active" },
  NEW_SIGNAL: { label: "Yeni Sinyal", tone: "active" },
  NEW_EVIDENCE: { label: "Yeni Kanıt", tone: "active" },
  COMPETITOR_CHANGE: { label: "Rakip Değişikliği", tone: "active" },
  SEO_CHANGE: { label: "SEO Değişikliği", tone: "active" },
  MARKET_CHANGE: { label: "Pazar Değişikliği", tone: "active" },
  MEDIA_CHANGE: { label: "Medya Değişikliği", tone: "active" },
  TREND_CHANGE: { label: "Trend Değişikliği", tone: "active" },
  PERFORMANCE_CHANGE: { label: "Performans Değişikliği", tone: "active" },
  TASK_COMPLETED: { label: "Görev Tamamlandı", tone: "positive" },
  CAMPAIGN_COMPLETED: { label: "Kampanya Tamamlandı", tone: "positive" },
  FOLLOW_UP_DUE: { label: "Takip Zamanı", tone: "waiting" },
  PROJECT_GOAL_CHANGED: { label: "Hedef Değişti", tone: "active" },
};

export const AGENCY_TRIGGER_STATUS: EnumMap<AgencyTriggerStatus> = {
  PENDING: { label: "Bekliyor", tone: "neutral" },
  PROCESSING: { label: "İşleniyor", tone: "active" },
  PROCESSED: { label: "İşlendi", tone: "positive" },
  FAILED: { label: "Başarısız", tone: "danger" },
  SKIPPED: { label: "Atlandı", tone: "neutral" },
};

// "publish-result" kartında ("INSTAGRAM_PUBLISH" yerine) okunabilir platform
// adı göstermek için — execution-service.ts VE task.repository.ts'in ikisi
// de kullanıyor (aralarında dairesel import olmaması için burada, nötr bir
// dosyada tutuluyor).
export const PLATFORM_LABEL: Partial<Record<CapabilityKey, string>> = {
  INSTAGRAM_PUBLISH: "Instagram",
  TIKTOK_PUBLISH: "TikTok",
  LINKEDIN_PUBLISH: "LinkedIn",
  X_PUBLISH: "X",
};
