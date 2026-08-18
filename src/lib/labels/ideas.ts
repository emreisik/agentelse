import {
  Sparkles,
  Globe2,
  Newspaper,
  Share2,
  Package,
  TrendingUp,
  Handshake,
  Users,
  Megaphone,
  MessagesSquare,
  Cpu,
  Ticket,
  Radio,
  FileText,
  Wrench,
  BarChart3,
} from "lucide-react";
import type {
  AgencyDecisionSubject,
  AgencyDecisionType,
  CouncilRecommendation,
  CouncilType,
  CreativeLens,
  IdeaStatus,
} from "@prisma/client";

import type { EnumMap } from "./types";

export const IDEA_STATUS: EnumMap<IdeaStatus> = {
  RAW: { label: "Ham", tone: "neutral" },
  RESEARCHING: { label: "Araştırılıyor", tone: "active" },
  VALIDATED: { label: "Doğrulandı", tone: "active" },
  CONCEPT: { label: "Konsept", tone: "active" },
  SHORTLISTED: { label: "Kısa Listede", tone: "waiting" },
  APPROVED: { label: "Onaylandı", tone: "positive" },
  PLANNING: { label: "Planlanıyor", tone: "active" },
  ACTIVE: { label: "Yürütülüyor", tone: "active" },
  MEASURING: { label: "Ölçülüyor", tone: "active" },
  LEARNED: { label: "Öğrenildi", tone: "special" },
  ARCHIVED: { label: "Arşivlendi", tone: "neutral" },
  REJECTED: { label: "Reddedildi", tone: "danger" },
};

// Kanban column grouping for the idea lifecycle board.
export const IDEA_BOARD_COLUMNS: Array<{
  key: string;
  label: string;
  statuses: IdeaStatus[];
}> = [
  { key: "kesif", label: "Keşif", statuses: ["RAW", "RESEARCHING", "VALIDATED"] },
  { key: "konsept", label: "Konsept", statuses: ["CONCEPT", "SHORTLISTED"] },
  { key: "onayli", label: "Onaylı", statuses: ["APPROVED", "PLANNING"] },
  { key: "yayinda", label: "Yürütmede", statuses: ["ACTIVE", "MEASURING"] },
  { key: "sonuc", label: "Sonuç", statuses: ["LEARNED", "ARCHIVED", "REJECTED"] },
];

export const CREATIVE_LENS: EnumMap<CreativeLens> = {
  BRAND: { label: "Marka", tone: "active", icon: Sparkles },
  CULTURE: { label: "Kültür", tone: "active", icon: Globe2 },
  PR: { label: "PR", tone: "active", icon: Newspaper },
  SOCIAL: { label: "Sosyal", tone: "active", icon: Share2 },
  PRODUCT: { label: "Ürün", tone: "active", icon: Package },
  GROWTH: { label: "Büyüme", tone: "active", icon: TrendingUp },
  PARTNERSHIP: { label: "Ortaklık", tone: "active", icon: Handshake },
  CREATOR: { label: "Üretici", tone: "active", icon: Users },
  MEDIA: { label: "Medya", tone: "active", icon: Megaphone },
  COMMUNITY: { label: "Topluluk", tone: "active", icon: MessagesSquare },
  TECHNOLOGY: { label: "Teknoloji", tone: "active", icon: Cpu },
  EXPERIENCE: { label: "Deneyim", tone: "active", icon: Ticket },
  OFFLINE: { label: "Geleneksel", tone: "neutral", icon: Radio },
  CONTENT: { label: "İçerik", tone: "active", icon: FileText },
  UTILITY: { label: "Fayda", tone: "active", icon: Wrench },
  DATA: { label: "Veri", tone: "active", icon: BarChart3 },
};

export const COUNCIL_TYPE: EnumMap<CouncilType> = {
  STRATEGY: { label: "Strateji Konseyi", tone: "active" },
  CREATIVE: { label: "Kreatif Konseyi", tone: "active" },
  GROWTH: { label: "Büyüme Konseyi", tone: "active" },
  MEDIA: { label: "Medya Konseyi", tone: "active" },
  RISK: { label: "Risk Konseyi", tone: "danger" },
};

export const COUNCIL_RECOMMENDATION: EnumMap<CouncilRecommendation> = {
  STRONG_APPROVE: { label: "Güçlü Onay", tone: "positive" },
  APPROVE: { label: "Onay", tone: "positive" },
  REVISE: { label: "Revizyon", tone: "waiting" },
  REJECT: { label: "Ret", tone: "danger" },
};

const COUNCIL_DIMENSION_LABELS: Record<string, string> = {
  originality: "Özgünlük",
  brandFit: "Marka Uyumu",
  culturalFit: "Kültürel Uyum",
  potentialImpact: "Potansiyel Etki",
  shareability: "Paylaşılabilirlik",
  mediaPotential: "Medya Potansiyeli",
  feasibility: "Uygulanabilirlik",
  evidence: "Kanıt",
  risk: "Risk",
  goalAlignment: "Hedef Uyumu",
  positioningFit: "Konumlandırma Uyumu",
  differentiation: "Farklılaşma",
  expectedImpact: "Beklenen Etki",
  measurability: "Ölçülebilirlik",
  costEfficiency: "Maliyet Verimliliği",
  speedToLearn: "Öğrenme Hızı",
  newsworthiness: "Haber Değeri",
  channelFit: "Kanal Uyumu",
  audienceReach: "Kitle Erişimi",
  timing: "Zamanlama",
  brandSafety: "Marka Güvenliği",
  legalExposure: "Yasal Risk",
  reputationRisk: "İtibar Riski",
  operationalRisk: "Operasyonel Risk",
  reversibility: "Geri Alınabilirlik",
};

export function councilDimensionLabel(key: string): string {
  return (
    COUNCIL_DIMENSION_LABELS[key] ??
    key.replace(/([A-Z])/g, " $1").toLowerCase()
  );
}

export const AGENCY_DECISION_TYPE: EnumMap<AgencyDecisionType> = {
  REJECT: { label: "Reddet", tone: "danger" },
  BACKLOG: { label: "Bekleme Listesi", tone: "neutral" },
  RESEARCH_MORE: { label: "Daha Fazla Araştır", tone: "active" },
  CREATE_EXPERIMENT: { label: "Deney Oluştur", tone: "active" },
  CREATE_CAMPAIGN: { label: "Kampanya Oluştur", tone: "positive" },
  CREATE_TASK: { label: "Görev Oluştur", tone: "positive" },
  CREATE_MULTI_DEPARTMENT_PLAN: {
    label: "Çok Departmanlı Plan",
    tone: "positive",
  },
};

export const AGENCY_DECISION_SUBJECT: EnumMap<AgencyDecisionSubject> = {
  OPPORTUNITY: { label: "Fırsat", tone: "active" },
  IDEA: { label: "Fikir", tone: "active" },
  HANDOFF: { label: "Devir", tone: "active" },
  TRIGGER: { label: "Tetikleyici", tone: "neutral" },
};
