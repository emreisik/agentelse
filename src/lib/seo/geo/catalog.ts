import type { GeoCheckId, GeoStatus } from "./types";

// SC-F8 GEO/AEO kontrol kataloğu (docs/ai-search-visibility.md): sabit
// İngilizce başlık, neden önemli ve ne yapılmalı metinleri ile puan ağırlıkları.
// Eşikler (yüzde 20 soru başlığı, 2 sameAs alan adı, 600 kelime, 5 sayfa FAQ
// kuralı) sezgiseldir ve değişebilir (doğrulanmalı). Metinler hiçbir AI
// motorunun siteyi alıntılayacağını vaat etmez.

export type GeoCheckDef = {
  title: string;
  why: string;
  how: string;
  weight: number;
  scored: boolean;
};

export const GEO_CHECKS: Record<GeoCheckId, GeoCheckDef> = {
  GEO1: {
    title: "llms.txt file",
    why: "llms.txt is an optional, emerging convention: a short plain-text guide that tells AI tools what your site is about and which pages matter most.",
    how: "Create a file named llms.txt at the root of your site with a title line, a one-line summary and links to your key pages.",
    weight: 5,
    scored: true,
  },
  GEO2: {
    title: "AI search crawlers",
    why: "These crawlers fetch pages so AI assistants can answer questions with them. When they are blocked, your pages cannot be used in those answers.",
    how: "Check the rules in your robots.txt for the crawlers listed as blocked. If blocking them is your decision, choose I decided this.",
    weight: 20,
    scored: true,
  },
  GEO3: {
    title: "AI training crawlers",
    why: "These crawlers collect pages to train AI models. Allowing or blocking them is a business decision.",
    how: "Allowing or blocking training is your decision; Agentelse only reports it.",
    weight: 0,
    scored: false,
  },
  GEO4: {
    title: "Content in the page HTML",
    why: "Many AI crawlers read the HTML exactly as your server sends it and do not run scripts. Text that only appears after scripts run can be missed.",
    how: "Make sure your main text is in the HTML your server sends, for example with server-side rendering or static pages.",
    weight: 10,
    scored: true,
  },
  GEO5: {
    title: "Organization markup on the homepage",
    why: "Organization markup (schema.org JSON-LD) states in a machine-readable way who you are, which helps AI tools tell your business apart from similar names.",
    how: "Add Organization (or LocalBusiness) JSON-LD to your homepage with your name, logo and official profile links.",
    weight: 12,
    scored: true,
  },
  GEO6: {
    title: "Links to your official profiles",
    why: "The sameAs property points to your official profiles. It helps AI tools connect the pages that belong to the same business.",
    how: "Add the https addresses of your official profiles (for example your social pages and business listings) to sameAs in your Organization markup.",
    weight: 10,
    scored: true,
  },
  GEO7: {
    title: "FAQ or how-to markup",
    why: "Google no longer shows FAQ rich results for most sites, but the markup still helps machines read questions and answers on a page.",
    how: "If a page really answers common questions, mark them up with FAQPage (or HowTo for step-by-step guides).",
    weight: 8,
    scored: true,
  },
  GEO8: {
    title: "Question-style headings",
    why: "People ask AI assistants questions. Headings phrased as the question make it easy to find and quote the answer below them.",
    how: "Turn some section headings into the questions your customers ask and answer each one directly under the heading.",
    weight: 12,
    scored: true,
  },
  GEO9: {
    title: "Snippet controls",
    why: "Pages marked nosnippet or max-snippet:0 tell search and AI tools not to show or quote any text from them.",
    how: "Remove nosnippet or max-snippet:0 from pages you want quoted. If you set it on purpose, choose I decided this.",
    weight: 10,
    scored: true,
  },
  GEO10: {
    title: "Page structure",
    why: "Long pages without subheadings are hard to quote from. Clear sections let AI tools pick the passage that answers a question.",
    how: "Split long pages into sections with descriptive subheadings (H2).",
    weight: 8,
    scored: true,
  },
  GEO11: {
    title: "Consistent brand name",
    why: "When your markup, homepage title and brand name differ, AI tools may treat them as different businesses.",
    how: "Use the same business name in your Organization markup, your homepage title and your brand settings.",
    weight: 5,
    scored: true,
  },
};

export const GEO_STATUS_LABEL: Record<GeoStatus, string> = {
  PASS: "Good",
  WARN: "Needs attention",
  INFO: "For your information",
  NA: "Not checked",
  ACK: "You decided",
};

export const GEO_TRAINING_NOTE =
  "Allowing or blocking training is your decision; Agentelse only reports it.";

export const GEO_LLMS_INSTRUCTION =
  "Create a file named llms.txt at the root of your site with this text. Agentelse does not change your site for this.";

// "Check again" en az bu kadar aralıkla (docs/ai-search-visibility.md).
export const GEO_MANUAL_GAP_MS = 6 * 3_600_000;
