import Link from "next/link";
import { notFound } from "next/navigation";
import { Building2, Megaphone } from "lucide-react";

import { AdsFlags } from "@/lib/ads/flags";
import { formatMoney } from "@/lib/ads/money";
import { timeAgo } from "@/lib/dates";
import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { loadAgencyOverview } from "@/server/ads/agency-overview";
import { AdsConnections } from "@/server/ads/connections";
import {
  assignAdsAccountAction,
  disconnectAdsConnectionAction,
} from "@/server/actions/ads-connection-actions";
import { businessLoginConfigured } from "@/server/integrations/meta/business-login";
import {
  requireUser,
  requireWorkspaceMembership,
} from "@/server/security/tenant-context";
import { AppShell } from "@/components/layout/app-shell";
import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Ajans görünümü (docs/meta-ads-plan.md F8, META_ADS_AGENCY): müşterilerin
// bütün reklam hesapları tek listede, Facebook Login for Business bağlantıları
// ve hesapların projelere atanması.

const ERRORS: Record<string, string> = {
  not_admin: "Only a workspace owner or admin can connect a business.",
  not_configured:
    "Facebook Login for Business isn't set up yet (META_FLFB_CONFIG_ID).",
  denied: "Meta didn't give access. Try again and allow every permission.",
  invalid_state: "That sign-in link expired. Try again.",
  connect_failed: "Couldn't finish connecting. Try again in a minute.",
};

const AUTONOMY_LABEL: Record<string, string> = {
  SUGGEST: "Suggest only",
  GUARDED: "Guarded auto",
  FULL: "Full auto",
};

function healthTone(status: string): string {
  if (status === "OK") return "bg-emerald-500";
  if (status === "UNKNOWN") return "bg-muted-foreground/40";
  return "bg-destructive";
}

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm sm:w-auto";

export default async function AdsAccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!AdsFlags.agency()) notFound();
  const params = await searchParams;
  const { userId } = await requireUser();
  const { workspaceId } = await requireWorkspaceMembership(userId);
  const now = new Date();
  const [overview, projects, member] = await Promise.all([
    loadAgencyOverview(workspaceId, now),
    prisma.project.findMany({
      where: { workspaceId, status: { not: "CLOSED" } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    }),
  ]);
  const isAdmin = member?.role === "OWNER" || member?.role === "ADMIN";
  const assigned = new Set(
    overview.accounts
      .filter((a) => a.projects.length > 0)
      .map((a) => a.externalId),
  );
  // Bağlantı başına atanmamış hesaplar ve Sayfalar (Meta okuması, P1).
  const pending = await Promise.all(
    overview.connections
      .filter((connection) => connection.status === "ACTIVE" && isAdmin)
      .map(async (connection) => {
        try {
          const [accounts, pages] = await Promise.all([
            AdsConnections.accounts(connection),
            AdsConnections.pages(connection).catch(() => []),
          ]);
          return {
            connection,
            accounts: accounts.filter(
              (account) => !assigned.has(account.adAccountId),
            ),
            pages,
            error: null as string | null,
          };
        } catch (error) {
          return {
            connection,
            accounts: [],
            pages: [],
            error:
              error instanceof Error
                ? error.message
                : "Couldn't read this connection.",
          };
        }
      }),
  );
  const errorKey =
    typeof params.metaBusinessError === "string"
      ? params.metaBusinessError
      : null;

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-heading text-2xl font-semibold tracking-tight">
              Ad accounts
            </h1>
            <p className="text-sm text-muted-foreground">
              Every client&apos;s Meta ad account in one place.
            </p>
          </div>
          {isAdmin && businessLoginConfigured() ? (
            <a
              href="/api/integrations/meta-business/start"
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Building2 className="size-4" />
              Connect a business
            </a>
          ) : null}
        </div>

        {params.metaBusinessConnected ? (
          <p
            role="status"
            className="rounded-lg border bg-card px-3 py-2 text-sm"
          >
            Business connected. Assign its ad accounts to projects below.
          </p>
        ) : null}
        {errorKey ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {ERRORS[errorKey] ?? "Something went wrong. Try again."}
          </p>
        ) : null}

        {overview.connections.length > 0 ? (
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-base">Connected businesses</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {overview.connections.map((connection) => (
                <div
                  key={connection.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <p className="font-medium">
                      {connection.name ?? "Meta business"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {connection.status !== "ACTIVE"
                        ? "Expired: connect it again"
                        : connection.expiresAt
                          ? `Login expires in ${Math.max(
                              0,
                              Math.ceil(
                                (connection.expiresAt.getTime() - now.getTime()) /
                                  86_400_000,
                              ),
                            )} days`
                          : "Business login, doesn't expire"}
                      {connection.clientBusinessId
                        ? ` · Business ${connection.clientBusinessId}`
                        : ""}
                    </p>
                  </div>
                  {isAdmin ? (
                    <ActionForm
                      action={disconnectAdsConnectionAction}
                      successMessage="Disconnected"
                    >
                      <input
                        type="hidden"
                        name="connectionId"
                        value={connection.id}
                      />
                      <SubmitButton size="sm" variant="outline">
                        Disconnect
                      </SubmitButton>
                    </ActionForm>
                  ) : null}
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        {pending.some((row) => row.accounts.length > 0 || row.error) ? (
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-base">Not in a project yet</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {pending.map((row) =>
                row.error ? (
                  <p
                    key={row.connection.id}
                    className="text-sm text-destructive"
                  >
                    {row.connection.name ?? "Meta business"}: {row.error}
                  </p>
                ) : (
                  row.accounts.map((account) => (
                    <ActionForm
                      key={`${row.connection.id}:${account.adAccountId}`}
                      action={assignAdsAccountAction}
                      successMessage="Ad account assigned"
                      className="flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
                    >
                      <input
                        type="hidden"
                        name="connectionId"
                        value={row.connection.id}
                      />
                      <input
                        type="hidden"
                        name="adAccountId"
                        value={account.adAccountId}
                      />
                      <div className="min-w-0">
                        <p className="font-medium">{account.adAccountName}</p>
                        <p className="text-xs text-muted-foreground">
                          {account.adAccountId}
                          {account.currency ? ` · ${account.currency}` : ""}
                        </p>
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <select
                          name="projectId"
                          required
                          defaultValue=""
                          className={selectClass}
                          aria-label="Project"
                        >
                          <option value="" disabled>
                            Project…
                          </option>
                          {projects.map((project) => (
                            <option key={project.id} value={project.id}>
                              {project.name}
                            </option>
                          ))}
                        </select>
                        <select
                          name="pageId"
                          defaultValue=""
                          className={selectClass}
                          aria-label="Facebook Page"
                        >
                          <option value="">Page (pick later)</option>
                          {row.pages.map((page) => (
                            <option key={page.pageId} value={page.pageId}>
                              {page.pageName}
                            </option>
                          ))}
                        </select>
                        <SubmitButton size="sm">Assign</SubmitButton>
                      </div>
                    </ActionForm>
                  ))
                ),
              )}
            </CardContent>
          </Card>
        ) : null}

        <Card size="sm">
          <CardHeader className="flex flex-row items-center gap-2 space-y-0">
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10">
              <Megaphone className="size-4 text-primary" />
            </span>
            <CardTitle className="text-base">
              All ad accounts ({overview.accounts.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {overview.accounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No ad accounts yet. Connect Meta Ads in a project, or connect a
                business above.
              </p>
            ) : (
              overview.accounts.map((account) => (
                <div
                  key={account.id}
                  className="rounded-lg border px-3 py-2 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          healthTone(account.healthStatus),
                        )}
                      />
                      <span className="truncate font-medium">
                        {account.name ?? account.externalId}
                      </span>
                      {account.connectionId ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          Business
                        </span>
                      ) : null}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {account.lastInsightsAt
                        ? `Updated ${timeAgo(account.lastInsightsAt)}`
                        : "Not updated yet"}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      7 days:{" "}
                      <span className="text-foreground">
                        {formatMoney(account.spend7dMinor, account.currency)}
                      </span>
                    </span>
                    <span>{account.runningCampaigns} running</span>
                    {account.critical > 0 ? (
                      <span className="text-destructive">
                        {account.critical} critical
                      </span>
                    ) : null}
                    {account.warn > 0 ? (
                      <span className="text-amber-600 dark:text-amber-400">
                        {account.warn} to check
                      </span>
                    ) : null}
                    {account.healthStatus !== "OK" && account.healthReason ? (
                      <span>{account.healthReason}</span>
                    ) : null}
                    {account.webhookStatus === "SUBSCRIBED" ? (
                      <span>Real-time alerts on</span>
                    ) : null}
                  </div>
                  {account.projects.length > 0 ? (
                    <div className="mt-1 flex flex-wrap gap-2 text-xs">
                      {account.projects.map((project) => (
                        <Link
                          key={project.id}
                          href={`/projects/${project.id}/ads`}
                          className="rounded-md bg-muted px-2 py-0.5 hover:bg-muted/70"
                        >
                          {project.name} ·{" "}
                          {AUTONOMY_LABEL[project.autonomy] ?? project.autonomy}
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
