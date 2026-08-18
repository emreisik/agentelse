import { NextResponse } from "next/server";

// Temporary diagnostic route to inspect what Railway's edge actually
// forwards for the agentelse.ai custom domain vs the *.up.railway.app
// subdomain. Remove once the proxy.ts origin-detection bug is confirmed
// fixed. Gated to non-production so it can't be used for anonymous
// infra/header reconnaissance against the live site.
export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }
  return NextResponse.json({
    url: request.url,
    headers: Object.fromEntries(request.headers.entries()),
  });
}
