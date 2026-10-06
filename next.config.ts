import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next's default Server Action body cap is 1MB — createMetaAdSetWithAdAction
  // (src/server/actions/meta-ads-actions.ts) accepts a multipart FormData
  // upload up to a single ~50MB video + 8MB thumbnail, or a carousel of up
  // to 10 images at 8MB each (~80MB) — both would be rejected by Next's
  // framework-level limit before the action's own size/type checks ever ran.
  experimental: {
    serverActions: {
      bodySizeLimit: "100mb",
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          // The product (agentelse.ai) stays out of search results: the
          // public site is agentelse.com. A header rather than robots.txt so
          // crawlers still fetch the pages and see it (a Disallow would hide
          // the noindex and leave linked URLs in the index).
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
