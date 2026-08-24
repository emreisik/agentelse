import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { isPublicPath } from "@/lib/public-paths";

export const proxy = auth((req) => {
  const { pathname } = req.nextUrl;
  const isPublic = isPublicPath(pathname);

  if (!req.auth && !isPublic) {
    // Railway's edge terminates custom domains (agentelse.ai) separately from
    // its own *.up.railway.app subdomain and doesn't forward the original
    // Host to the container the same way for both — req.nextUrl.origin came
    // back as http://localhost:3000 for the custom domain. X-Forwarded-Host/
    // Proto carry the real edge-facing host in both cases, so prefer those.
    const forwardedHost = req.headers.get("x-forwarded-host");
    const origin = forwardedHost
      ? `${req.headers.get("x-forwarded-proto") ?? "https"}://${forwardedHost}`
      : req.nextUrl.origin;

    const loginUrl = new URL("/login", origin);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export const config = {
  // Excludes framework internals AND static files served straight out of
  // /public (logos, icons, etc.) — without the extension exclusion, an
  // unauthenticated request for e.g. /logo.png got redirected to /login
  // (a 307, not the image), breaking every public image on signed-out
  // pages like /login and /register.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|css|js|woff|woff2|ttf)$).*)",
  ],
};
