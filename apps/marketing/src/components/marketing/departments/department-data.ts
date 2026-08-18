export type DepartmentSlug =
  "research" | "creative" | "seo" | "social" | "analytics";

export type DepartmentData = {
  slug: DepartmentSlug;
  name: string;
  tagline: string;
  description: string;
  capabilities: string[];
  exampleOutput: {
    label: string;
    description: string;
  };
  /** Other department names it commonly coordinates with. Not every name
   * here has a dedicated page (e.g. Opportunity Engine) — the UI decides
   * whether to link based on what's in DEPARTMENTS below. */
  worksWith: string[];
};

// The 5 departments with dedicated pages. Agency Director, Idea Foundry and
// Opportunity Engine exist in the product but don't get pages in this pass —
// see the /departments index for how they're mentioned instead.
export const DEPARTMENTS: DepartmentData[] = [
  {
    slug: "research",
    name: "Research",
    tagline: "Understands your market before you have to ask.",
    description:
      "Research continuously monitors competitors, markets and customers, and reads the signals worth acting on. What it finds becomes part of the Brand Brain and turns into Opportunities the rest of the system can work from.",
    capabilities: [
      "Tracks competitor moves, pricing and positioning on an ongoing basis",
      "Builds and maintains market and customer intelligence",
      "Surfaces signals worth acting on, not just raw data",
      "Feeds findings into the Brand Brain so every department shares one picture",
    ],
    exampleOutput: {
      label: "Competitor positioning report",
      description:
        "A structured breakdown of how three competitors are positioning a new feature, with the gaps and openings it creates for your brand.",
    },
    worksWith: ["Opportunity Engine", "Analytics"],
  },
  {
    slug: "creative",
    name: "Creative",
    tagline: "Turns an approved strategy into work you can publish.",
    description:
      "Creative takes an approved direction and produces the campaigns, concepts and content that carry it — copy and visuals grounded in your Brand Brain's identity and tone, packaged ready for review.",
    capabilities: [
      "Generates on-brand copy and visual concepts from an approved brief",
      "Adapts a single concept across formats and channels",
      "Keeps every asset consistent with Brand Brain's identity and tone",
      "Packages assets ready to review, not raw drafts",
    ],
    exampleOutput: {
      label: "Campaign concept package",
      description:
        "A ready-to-review set of headline copy, supporting variants and visual direction for one approved campaign brief.",
    },
    worksWith: ["Social", "SEO"],
  },
  {
    slug: "seo",
    name: "SEO",
    tagline: "Finds what to rank for, then writes the brief.",
    description:
      "SEO reads real Search Console and Analytics data to find search opportunities worth pursuing, prioritizes them, and turns the result into a content brief someone can act on — not a list of keywords.",
    capabilities: [
      "Prioritizes opportunities using real Search Console and Analytics data",
      "Turns keyword and content gaps into ranked opportunities",
      "Produces content briefs Creative can execute directly",
      "Tracks how published content performs after it ships",
    ],
    exampleOutput: {
      label: "Content brief",
      description:
        "A content brief covering 14 ranked keyword opportunities, each with search intent, priority and a recommended angle.",
    },
    worksWith: ["Creative", "Analytics"],
  },
  {
    slug: "social",
    name: "Social",
    tagline: "Plans the calendar, formats the post, waits for your yes.",
    description:
      "Social plans and coordinates activity across platforms — building content calendars, formatting each post for its channel, and queuing everything for approval before anything publishes.",
    capabilities: [
      "Builds content calendars across channels",
      "Formats each post for its platform's conventions",
      "Queues posts for approval before anything goes live",
      "Coordinates timing with Creative and wider campaign activity",
    ],
    exampleOutput: {
      label: "Weekly content calendar",
      description:
        "A platform-formatted queue of posts for the week ahead, each one staged and waiting in the approval queue.",
    },
    worksWith: ["Creative", "Analytics"],
  },
  {
    slug: "analytics",
    name: "Analytics",
    tagline: "Explains what happened and what to do next.",
    description:
      "Analytics measures results against your goals and explains what's actually working. Its findings become BrandLearning, feeding back into future Research, SEO and Social decisions instead of sitting in a report.",
    capabilities: [
      "Measures campaign and content performance against goals",
      "Explains which results are meaningful, not just what moved",
      "Turns findings into BrandLearning that feeds back into future decisions",
      "Flags what should happen next, not just what already happened",
    ],
    exampleOutput: {
      label: "Performance review",
      description:
        "A monthly review of what moved the needle across channels, with the specific findings fed back into the Brand Brain for future decisions.",
    },
    worksWith: ["Research", "SEO", "Social"],
  },
];

export function getDepartment(slug: string): DepartmentData | undefined {
  return DEPARTMENTS.find((department) => department.slug === slug);
}

// The rest of the system — real departments, no dedicated page yet. Listed
// alongside DEPARTMENTS anywhere the site shows the full picture (e.g. the
// header's Departments menu), linking back to the /departments index.
export const OTHER_DEPARTMENTS: { name: string; tagline: string }[] = [
  {
    name: "Agency Director",
    tagline: "Coordinates priorities and approvals across every department.",
  },
  {
    name: "Idea Foundry",
    tagline: "Continuously develops the opportunities the system acts on.",
  },
  {
    name: "Opportunity Engine",
    tagline: "Combines signals into ranked opportunities.",
  },
];
