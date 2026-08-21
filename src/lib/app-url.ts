import { getEnv } from "@/lib/env";

// Never derive a redirect's origin from `request.url` in a route handler —
// behind a reverse proxy that doesn't forward the original Host header, it
// resolves to the server's internal bind address (e.g. http://localhost:8080)
// instead of the public domain, so the browser gets redirected somewhere it
// can't reach. This is the same source of truth already used to build the
// OAuth redirect_uri sent to each provider (see server/integrations/*-client.ts).
export function appUrl(path: string): URL {
  return new URL(path, getEnv().NEXT_PUBLIC_APP_URL);
}
