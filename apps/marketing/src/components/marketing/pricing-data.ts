import { appHref } from "@/lib/app-url";

export type PricingTier = {
  id: "start" | "growth" | "scale" | "enterprise";
  name: string;
  price: string;
  priceSuffix?: string;
  description: string;
  features: string[];
  usageUnitLabel?: string;
  highlighted?: boolean;
  badge?: string;
  cta: { label: string; href: string };
};

// Single source of truth for tier copy — shared verbatim by the homepage's
// compact pricing section and the full /pricing page so they can never
// drift out of sync.
export const PRICING_TIERS: PricingTier[] = [
  {
    id: "start",
    name: "Start",
    price: "$99",
    priceSuffix: "/month",
    description: "For companies building their first AI growth team.",
    features: [
      "1 brand",
      "Core AI departments",
      "3 competitors",
      "Brand Brain",
      "GA4 + Search Console",
      "500 AI Operations",
    ],
    cta: { label: "Start free", href: appHref("/login?callbackUrl=/dashboard") },
  },
  {
    id: "growth",
    name: "Growth",
    price: "$299",
    priceSuffix: "/month",
    description:
      "For growing companies that want a complete AI Growth Department.",
    features: [
      "3 brands",
      "All departments",
      "10 competitors",
      "Daily monitoring",
      "Approval workflows",
      "Advanced integrations",
      "2,500 AI Operations",
    ],
    highlighted: true,
    badge: "Most popular",
    cta: { label: "Build your AI team", href: appHref("/login?callbackUrl=/dashboard") },
  },
  {
    id: "scale",
    name: "Scale",
    price: "$699",
    priceSuffix: "/month",
    description: "For agencies and multi-brand organizations.",
    features: [
      "10 brands",
      "Multiple AI teams",
      "30 competitor monitors",
      "Advanced workflows",
      "API access",
      "Browser agents",
      "10,000 AI Operations",
      "Priority execution",
    ],
    cta: { label: "Start scaling", href: appHref("/login?callbackUrl=/dashboard") },
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "Custom",
    description: "For organizations deploying Agentelse at scale.",
    features: [
      "Custom brands",
      "Custom departments",
      "SSO",
      "RBAC",
      "Audit logs",
      "Enterprise security",
      "Custom integrations",
      "SLA",
      "Dedicated onboarding",
    ],
    cta: { label: "Contact sales", href: "/contact" },
  },
];
