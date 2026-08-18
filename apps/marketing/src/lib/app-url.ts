const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://agentelse.io";

// Marketing (agentelse.com) and the app (agentelse.io) are separate
// deployments — any link into the product has to be an absolute URL, not a
// relative Next.js <Link>. No shared session/SSO yet; this is a plain
// cross-origin navigation.
export function appHref(path: string): string {
  return `${APP_URL}${path}`;
}
