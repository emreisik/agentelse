import type { BrowserProfilePurpose } from "@prisma/client";
import {
  AtSign,
  BadgeDollarSign,
  Globe,
  Image,
  LineChart,
  Mail,
  Megaphone,
  Search,
  Share2,
  Users,
  Video,
  type LucideIcon,
} from "lucide-react";

// lucide-react ships generic icons only (no brand marks), so these are
// representative stand-ins for each integration, not literal platform logos.
export const PURPOSE_ICONS: Record<
  BrowserProfilePurpose,
  { label: string; icon: LucideIcon }
> = {
  PUBLIC_RESEARCH: { label: "Public Research", icon: Globe },
  INSTAGRAM: { label: "Instagram", icon: Image },
  TIKTOK: { label: "TikTok", icon: Video },
  META_ADS: { label: "Meta Ads", icon: Megaphone },
  GOOGLE_ADS: { label: "Google Ads", icon: BadgeDollarSign },
  GA4: { label: "GA4", icon: LineChart },
  SEARCH_CONSOLE: { label: "Search Console", icon: Search },
  LINKEDIN: { label: "LinkedIn", icon: Share2 },
  X: { label: "X", icon: AtSign },
  CRM: { label: "CRM", icon: Users },
  EMAIL: { label: "Email", icon: Mail },
  GENERAL: { label: "General", icon: Globe },
};
