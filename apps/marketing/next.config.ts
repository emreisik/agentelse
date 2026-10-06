import type { NextConfig } from "next";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://agentelse.ai";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // The old "departments" and "solutions" story was replaced by one
      // product tour.
      { source: "/departments", destination: "/product", permanent: true },
      {
        source: "/departments/:slug",
        destination: "/product",
        permanent: true,
      },
      { source: "/solutions", destination: "/product", permanent: true },
      { source: "/solutions/:slug", destination: "/product", permanent: true },
      // The legal pages live in the product, so there is one current text.
      {
        source: "/privacy",
        destination: `${APP_URL}/privacy`,
        permanent: false,
      },
      { source: "/terms", destination: `${APP_URL}/terms`, permanent: false },
      {
        source: "/data-deletion",
        destination: `${APP_URL}/data-deletion`,
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
