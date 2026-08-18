import type { Metadata } from "next";

import { requireUserOrRedirect } from "@/server/security/tenant-context";

export const metadata: Metadata = {
  title: "HubTeam.ai",
};

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireUserOrRedirect();
  return children;
}
