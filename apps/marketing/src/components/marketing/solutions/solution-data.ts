export type SolutionData = {
  slug: string;
  /** Short audience name, e.g. "Startups". */
  audience: string;
  /** Specific value-prop headline for this audience, under 8 words. */
  headline: string;
  /** 1-2 sentences naming the real problem this audience faces. */
  problem: string;
  /** 2-3 short bullets: concretely how Agentelse addresses the problem. */
  fit: string[];
  /** The one Agentelse capability that matters most for this audience. */
  highlightCapability: {
    label: string;
    description: string;
  };
};

export const SOLUTIONS: SolutionData[] = [
  {
    slug: "startups",
    audience: "Startups",
    headline: "The growth team you can't hire yet.",
    problem:
      "Early on, you can't justify a full growth team, but ad hoc marketing — a freelancer here, a boosted post there — doesn't compound into anything. You need consistent output without a headcount commitment.",
    fit: [
      "One AI department covers research, creative, SEO, social and analytics from day one.",
      "Scales with the company as it grows, with no hiring cycle to keep pace with.",
      "The Start plan runs the full stack for $99/mo, built for exactly this stage.",
    ],
    highlightCapability: {
      label: "The full department, one plan.",
      description:
        "Every specialist — Research, Creative, SEO, Social, Analytics — runs from a single Start subscription. You're not stitching together tools or waiting on a hire to get coverage across the funnel.",
    },
  },
  {
    slug: "saas",
    audience: "SaaS companies",
    headline: "Marketing that keeps up with your product.",
    problem:
      "SaaS marketing has to explain a nuanced product, track competitors who ship changes weekly, and hold up under constant competitive pressure — usually with a team already stretched across ten other things.",
    fit: [
      "Research monitors competitors continuously, not on a quarterly review cycle.",
      "Creative and SEO produce technical, product-accurate content that explains what you actually built.",
      "Analytics ties growth work back to what's shipping, not a generic content calendar.",
    ],
    highlightCapability: {
      label: "Continuous competitive monitoring.",
      description:
        "When a competitor changes their homepage or pricing, Agentelse notices, and Research already has a response strategy ready — often before your team has even seen the change.",
    },
  },
  {
    slug: "ecommerce",
    audience: "Ecommerce",
    headline: "React to demand, not the calendar.",
    problem:
      "Ecommerce runs on a relentless content and campaign cadence, with seasonal spikes that can't slip and margins too thin to waste ad spend on guesses.",
    fit: [
      "Shopify integration gives Agentelse real commerce context: inventory, pricing, order patterns.",
      "Campaign ideas are generated continuously, not batched into a monthly content calendar.",
      "Analytics drives fast creative iteration, so spend follows what's actually converting.",
    ],
    highlightCapability: {
      label: "Signal-triggered campaigns.",
      description:
        "A demand spike, a price change, a stock shift — Agentelse responds to the signal itself, with a campaign ready to launch, instead of waiting for the next scheduled content push.",
    },
  },
  {
    slug: "agencies",
    audience: "Agencies",
    headline: "Every client brand, one executive view.",
    problem:
      "Growth agencies take on more client brands than their headcount can keep pace with. Every new account adds research, content and reporting work that doesn't scale linearly with your team.",
    fit: [
      "Multi-brand architecture gives every client an isolated Brand Brain, departments, integrations and approvals.",
      "You see every client's department activity from one executive layer, not ten separate logins.",
      "The Scale plan covers 10 brands at $699/mo, built for running client work, not just one company.",
    ],
    highlightCapability: {
      label: "One view, every client.",
      description:
        "Each client brand runs its own department stack, with separate research, creative and approvals, but you monitor and approve across all of them from a single account.",
    },
  },
  {
    slug: "multi-brand",
    audience: "Multi-brand companies",
    headline: "One team. Brands that never blur together.",
    problem:
      "Running several brands under one company means each needs its own voice and positioning, but a shared team and shared tools make it easy for brand identities to bleed into each other.",
    fit: [
      "A Workspace → Project → Brand structure keeps every brand's Brand Brain genuinely separate.",
      "Rules, research and learnings for one brand never carry over into another.",
      "One company, several brands, run and reviewed from a single executive view.",
    ],
    highlightCapability: {
      label: "Isolation by design.",
      description:
        "Each brand's identity, rules and history live in its own Brand Brain. The same team can run every brand without shared context ever leaking between them.",
    },
  },
];

export function getSolutionBySlug(slug: string): SolutionData | undefined {
  return SOLUTIONS.find((solution) => solution.slug === slug);
}
