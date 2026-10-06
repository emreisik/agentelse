import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/site";

const PAGES = [
  { path: "", priority: 1 },
  { path: "/product", priority: 0.9 },
  { path: "/agencies", priority: 0.8 },
  { path: "/pricing", priority: 0.8 },
  { path: "/security", priority: 0.6 },
  { path: "/about", priority: 0.5 },
  { path: "/contact", priority: 0.5 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  return PAGES.map(({ path, priority }) => ({
    url: `${SITE_URL}${path}`,
    changeFrequency: "monthly",
    priority,
  }));
}
