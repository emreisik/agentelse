import { appHref } from "@/lib/app-url";

export const SITE_URL = "https://agentelse.com";

export const CONTACT_EMAIL = "hello@agentelse.com";

// Links into the product (a separate deployment on its own domain).
export const SIGN_IN_HREF = appHref("/login");
export const START_HREF = appHref("/register");

export const NAV_LINKS = [
  { href: "/product", label: "Product" },
  { href: "/agencies", label: "For agencies" },
  { href: "/pricing", label: "Pricing" },
  { href: "/security", label: "Security" },
] as const;

export const FOOTER_COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "How it works", href: "/product" },
      { label: "For agencies", href: "/agencies" },
      { label: "Pricing", href: "/pricing" },
      { label: "Security", href: "/security" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Contact", href: "/contact" },
    ],
  },
  // The legal pages live in the product (one current text, the one Meta's App
  // Review reads); this site's /privacy and /terms redirect there.
  {
    title: "Legal",
    links: [
      { label: "Privacy", href: appHref("/privacy") },
      { label: "Terms", href: appHref("/terms") },
      { label: "Data deletion", href: appHref("/data-deletion") },
    ],
  },
] as const;
