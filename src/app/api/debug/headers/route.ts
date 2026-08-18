import { NextResponse } from "next/server";

// Temporary diagnostic route to inspect what Railway's edge actually
// forwards for the agentelse.ai custom domain vs the *.up.railway.app
// subdomain. Remove once the proxy.ts origin-detection bug is confirmed
// fixed.
export async function GET(request: Request) {
  return NextResponse.json({
    url: request.url,
    headers: Object.fromEntries(request.headers.entries()),
  });
}
