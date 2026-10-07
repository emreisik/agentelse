import { isValidDomain, normalizeDomain } from "@/lib/domain";

// Ayarlar > Publishing > "Link tracking" kartının metinleri.
export const LINK_TRACKING_COPY = {
  title: "Link tracking",
  toggle: "Add tracking (UTM) to links",
  toggleHint:
    "Agentelse adds standard tracking tags (UTM) to the links it puts in your ads and your bio link, so Google Analytics can show what they bring to your website. Links between pages of your own site never get tags, and tags you already added are kept.",
  managersOnly: "Only workspace owners and admins can change this.",
  bioTitle: "Instagram bio link",
  bioHint:
    'Paste this link into your Instagram bio. Visits through it appear under "From Agentelse" on the Website page.',
  bioCreate: "Create bio link",
  bioUpdate: "Update link",
  bioNoDomain: "Add your website in the project settings to create a bio link.",
  bioOff: "Turn on link tracking to create a bio link.",
  notOwnSite: "Use a page on your own website (https://…).",
  invalidUrl: "Enter a full link starting with https://.",
  saved: "Link tracking updated",
  bioSaved: "Bio link saved",
} as const;

// Bio linkinin varsayılan hedefi: projenin ana sayfası.
export function bioDefaultUrl(domain: string | null): string | null {
  if (!domain) return null;
  const normalized = normalizeDomain(domain);
  return isValidDomain(normalized) ? `https://${normalized}/` : null;
}
