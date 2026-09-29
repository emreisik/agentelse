// A project's website is stored as a bare domain ("webhealth.com.tr"): no
// scheme, no "www.", no path. Shared by every place that accepts one.

const DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function normalizeDomain(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/[/?#].*$/, "")
    .toLowerCase();
}

export function isValidDomain(value: string): boolean {
  return DOMAIN_PATTERN.test(normalizeDomain(value));
}
