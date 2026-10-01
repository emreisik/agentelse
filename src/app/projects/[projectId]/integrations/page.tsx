import Link from "next/link";
import { notFound } from "next/navigation";
import {
  BarChart3,
  Plug,
  RefreshCw,
  Search,
  Send,
  type LucideIcon,
} from "lucide-react";
import type { IntegrationCredential } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/dates";
import { isIntegrationConfigured } from "@/lib/env";
import { PURPOSE_ICONS } from "@/features/dashboard/purpose-icons";
import {
  GOOGLE_PROVIDER,
  GOOGLE_SERVICE_LABEL,
  type GoogleAnalyticsMetadata,
  type GoogleSearchConsoleMetadata,
  type GoogleService,
} from "@/server/integrations/google-client";
import {
  META_PROVIDER,
  META_SERVICE_LABEL,
  type MetaAdsMetadata,
  type MetaInstagramMetadata,
  type MetaService,
} from "@/server/integrations/meta-client";
import type { TikTokCredentialMetadata } from "@/server/integrations/tiktok-client";
import type { LinkedInCredentialMetadata } from "@/server/integrations/linkedin-client";
import type { XCredentialMetadata } from "@/server/integrations/x-client";
import {
  disconnectTelegramAction,
  sendTelegramTestMessageAction,
  updateTelegramApproversAction,
} from "@/server/actions/telegram-actions";
import {
  disconnectGoogleAction,
  refreshGoogleListsAction,
  selectGa4PropertyAction,
  selectSearchConsoleSiteAction,
  testGoogleConnectionAction,
} from "@/server/actions/google-actions";
import {
  disconnectMetaAction,
  selectMetaAdAccountAction,
  selectMetaPageAction,
  testMetaConnectionAction,
} from "@/server/actions/meta-actions";
import {
  disconnectTikTokAction,
  testTikTokConnectionAction,
} from "@/server/actions/tiktok-actions";
import {
  disconnectLinkedInAction,
  testLinkedInConnectionAction,
} from "@/server/actions/linkedin-actions";
import {
  disconnectXAction,
  testXConnectionAction,
} from "@/server/actions/x-actions";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { AppShell } from "@/components/layout/app-shell";
import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { EntityDialog } from "@/components/shared/entity-dialog";
import { ModeSwitcher } from "@/components/shared/mode-switcher";
import { SearchableSelect } from "@/components/shared/searchable-select";
import { TelegramConnectForm } from "@/components/integrations/telegram-connect-form";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { buttonVariants } from "@/components/ui/button";
import { isWorksEnabled } from "@/server/works/flag";
import { WorkRepository } from "@/server/repositories/work.repository";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import { singleReturnTarget } from "./works-return";
import { channelOffers } from "@/lib/works/channel-offers";
import { WorkReturnLink, WorkReturnLinks } from "@/components/works/work-return-link";
import { ChannelOfferBanner } from "@/components/works/channel-offer-banner";
import { offersFor } from "@/components/works/channel-offers-for";

// Only connectors backed by a real, working connection (OAuth / Bot API)
// are listed. The old BrowserProfile-based placeholders (Instagram, Meta
// Ads, Google Ads, GA4, Search Console, CRM, Email) were removed from this
// page: they had no real integration behind them — an operator just
// "marked" them connected — and several duplicated real OAuth connectors.
// The BrowserProfile rows themselves still exist where execution needs
// them (e.g. INSTAGRAM for INSTAGRAM_PUBLISH).
const CATEGORY_LIST = [
  { key: "messaging", label: "Messaging" },
  { key: "social", label: "Social Media" },
  { key: "reklam", label: "Advertising" },
  { key: "analitik", label: "Analytics" },
] as const;
type CategoryKey = (typeof CATEGORY_LIST)[number]["key"];

type FilterKey = "tumu" | "enabled" | CategoryKey;
const FILTER_KEYS: readonly FilterKey[] = [
  "tumu",
  "enabled",
  ...CATEGORY_LIST.map((c) => c.key),
];

// The way back to a Work after connecting a channel. Works only; any failure
// renders nothing so the page itself never breaks.
async function renderWorksReturn(projectId: string, from: unknown) {
  try {
    if (!isWorksEnabled()) return null;
    const [fromWork, works, connections, coverage] = await Promise.all([
      typeof from === "string" && from
        ? WorkRepository.get(projectId, from)
        : Promise.resolve(null),
      WorkRepository.listRecent(projectId, 50),
      getChannelConnections(projectId),
      // Slim coverage read (all non-archived Works) decides the open offers.
      WorkRepository.channelCoverage(projectId),
    ]);
    const { back } = channelOffers(connections, works);
    const offers = offersFor(true, connections, coverage);
    const single = singleReturnTarget(fromWork, back);
    if (!single && back.length === 0 && offers.length === 0) return null;
    return (
      <>
        {single ? (
          <WorkReturnLink projectId={projectId} workId={single.id} title={single.title} />
        ) : null}
        <WorkReturnLinks projectId={projectId} links={back} />
        <ChannelOfferBanner projectId={projectId} channels={offers} />
      </>
    );
  } catch {
    return null;
  }
}

export default async function EntegrasyonlarPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;

  const { userId } = await requireUser();
  try {
    await requireProjectAccess(userId, projectId);
  } catch {
    notFound();
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true },
  });
  if (!project) notFound();

  const [
    telegramCredential,
    analyticsCredential,
    searchConsoleCredential,
    instagramCredential,
    metaAdsCredential,
    tiktokCredential,
    linkedinCredential,
    xCredential,
  ] = await Promise.all([
    prisma.integrationCredential.findFirst({
      where: { projectId, provider: "telegram" },
    }),
    prisma.integrationCredential.findFirst({
      where: { projectId, provider: GOOGLE_PROVIDER.analytics },
    }),
    prisma.integrationCredential.findFirst({
      where: { projectId, provider: GOOGLE_PROVIDER.search_console },
    }),
    prisma.integrationCredential.findFirst({
      where: { projectId, provider: META_PROVIDER.instagram },
    }),
    prisma.integrationCredential.findFirst({
      where: { projectId, provider: META_PROVIDER.ads },
    }),
    prisma.integrationCredential.findFirst({
      where: { projectId, provider: "tiktok" },
    }),
    prisma.integrationCredential.findFirst({
      where: { projectId, provider: "linkedin" },
    }),
    prisma.integrationCredential.findFirst({
      where: { projectId, provider: "x" },
    }),
  ]);
  const telegramConnected = telegramCredential?.status === "ACTIVE";

  const filter: FilterKey =
    typeof sp.kategori === "string" &&
    FILTER_KEYS.includes(sp.kategori as FilterKey)
      ? (sp.kategori as FilterKey)
      : "tumu";
  const q = typeof sp.q === "string" ? sp.q.trim().toLowerCase() : "";
  const base = `/projects/${projectId}/integrations`;
  const kategoriParam = filter === "tumu" ? undefined : filter;

  function filterHref(key: FilterKey): string {
    const params = new URLSearchParams();
    if (key !== "tumu") params.set("kategori", key);
    if (q) params.set("q", q);
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }
  const closeHref = filterHref(filter);

  // Every connector collected into one list so category/search filtering
  // applies uniformly.
  const allConnectors: Array<{
    key: string;
    category: CategoryKey;
    label: string;
    connected: boolean;
    node: React.ReactNode;
  }> = [
    {
      key: "telegram",
      category: "messaging",
      label: "Telegram",
      connected: telegramConnected,
      node: (
        <TelegramTile
          key="telegram"
          base={base}
          kategori={kategoriParam}
          credential={telegramCredential}
        />
      ),
    },
    {
      key: GOOGLE_PROVIDER.analytics,
      category: "analitik",
      label: GOOGLE_SERVICE_LABEL.analytics,
      connected: analyticsCredential?.status === "ACTIVE",
      node: (
        <GoogleTile
          key={GOOGLE_PROVIDER.analytics}
          service="analytics"
          base={base}
          kategori={kategoriParam}
          credential={analyticsCredential}
        />
      ),
    },
    {
      key: GOOGLE_PROVIDER.search_console,
      category: "analitik",
      label: GOOGLE_SERVICE_LABEL.search_console,
      connected: searchConsoleCredential?.status === "ACTIVE",
      node: (
        <GoogleTile
          key={GOOGLE_PROVIDER.search_console}
          service="search_console"
          base={base}
          kategori={kategoriParam}
          credential={searchConsoleCredential}
        />
      ),
    },
    {
      key: META_PROVIDER.instagram,
      category: "social",
      label: META_SERVICE_LABEL.instagram,
      connected: instagramCredential?.status === "ACTIVE",
      node: (
        <MetaTile
          key={META_PROVIDER.instagram}
          service="instagram"
          base={base}
          kategori={kategoriParam}
          credential={instagramCredential}
        />
      ),
    },
    {
      key: META_PROVIDER.ads,
      category: "reklam",
      label: META_SERVICE_LABEL.ads,
      connected: metaAdsCredential?.status === "ACTIVE",
      node: (
        <MetaTile
          key={META_PROVIDER.ads}
          service="ads"
          base={base}
          kategori={kategoriParam}
          credential={metaAdsCredential}
        />
      ),
    },
    {
      key: "tiktok",
      category: "social",
      label: "TikTok",
      connected: tiktokCredential?.status === "ACTIVE",
      node: (
        <TikTokTile
          key="tiktok"
          base={base}
          kategori={kategoriParam}
          credential={tiktokCredential}
        />
      ),
    },
    {
      key: "linkedin",
      category: "social",
      label: "LinkedIn",
      connected: linkedinCredential?.status === "ACTIVE",
      node: (
        <LinkedInTile
          key="linkedin"
          base={base}
          kategori={kategoriParam}
          credential={linkedinCredential}
        />
      ),
    },
    {
      key: "x",
      category: "social",
      label: "X",
      connected: xCredential?.status === "ACTIVE",
      node: (
        <XTile
          key="x"
          base={base}
          kategori={kategoriParam}
          credential={xCredential}
        />
      ),
    },
  ];

  const categoryFiltered =
    filter === "tumu"
      ? allConnectors
      : filter === "enabled"
        ? allConnectors.filter((c) => c.connected)
        : allConnectors.filter((c) => c.category === filter);
  const visibleConnectors = q
    ? categoryFiltered.filter((c) => c.label.toLowerCase().includes(q))
    : categoryFiltered;

  const enabledCount = allConnectors.filter((c) => c.connected).length;
  const totalCount = allConnectors.length;
  const categoryCounts = CATEGORY_LIST.map((c) => ({
    ...c,
    count: allConnectors.filter((row) => row.category === c.key).length,
  }));
  const sectionTitle =
    filter === "tumu"
      ? "All Connectors"
      : filter === "enabled"
        ? "Enabled"
        : (CATEGORY_LIST.find((c) => c.key === filter)?.label ?? "Connectors");

  const navRowClass =
    "flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors hover:bg-muted";
  const navRowActiveClass = "bg-muted font-medium text-foreground";
  const navRowInactiveClass = "text-muted-foreground";

  const worksReturn = await renderWorksReturn(projectId, sp.from);

  const openTelegram = sp.integration === "telegram";
  const openGoogleService: GoogleService | null =
    sp.integration === GOOGLE_PROVIDER.analytics
      ? "analytics"
      : sp.integration === GOOGLE_PROVIDER.search_console
        ? "search_console"
        : null;
  const openMetaService: MetaService | null =
    sp.integration === META_PROVIDER.instagram
      ? "instagram"
      : sp.integration === META_PROVIDER.ads
        ? "ads"
        : null;
  const openTikTok = sp.integration === "tiktok";
  const openLinkedIn = sp.integration === "linkedin";
  const openX = sp.integration === "x";
  const googleError =
    typeof sp.googleError === "string" ? sp.googleError : null;
  const metaError = typeof sp.metaError === "string" ? sp.metaError : null;
  const tiktokError =
    typeof sp.tiktokError === "string" ? sp.tiktokError : null;
  const linkedinError =
    typeof sp.linkedinError === "string" ? sp.linkedinError : null;
  const xError = typeof sp.xError === "string" ? sp.xError : null;

  return (
    <AppShell projectId={projectId}>
      <div className="space-y-6 p-6 pb-16">
        <div className="flex gap-8">
          <aside className="w-56 shrink-0 space-y-6">
            <div>
              <h1 className="font-heading text-xl font-semibold tracking-tight">
                Connectors
              </h1>
              <p className="text-xs text-muted-foreground">{project.name}</p>
            </div>

            <form method="GET" action={base}>
              {filter !== "tumu" ? (
                <input type="hidden" name="kategori" value={filter} />
              ) : null}
              <Input
                name="q"
                defaultValue={q}
                placeholder="Search connectors"
                className="h-8 text-xs"
              />
            </form>

            <div className="space-y-0.5">
              <Link
                href={filterHref("tumu")}
                className={cn(
                  navRowClass,
                  filter === "tumu" ? navRowActiveClass : navRowInactiveClass,
                )}
              >
                All
                <span className="text-xs tabular-nums text-muted-foreground">
                  {totalCount}
                </span>
              </Link>
              <Link
                href={filterHref("enabled")}
                className={cn(
                  navRowClass,
                  filter === "enabled"
                    ? navRowActiveClass
                    : navRowInactiveClass,
                )}
              >
                Enabled
                <span className="text-xs tabular-nums text-muted-foreground">
                  {enabledCount}
                </span>
              </Link>
            </div>

            <div className="space-y-0.5">
              <p className="px-2.5 text-[10px] font-semibold tracking-wide text-muted-foreground/70 uppercase">
                Categories
              </p>
              {categoryCounts.map((c) => (
                <Link
                  key={c.key}
                  href={filterHref(c.key)}
                  className={cn(
                    navRowClass,
                    filter === c.key ? navRowActiveClass : navRowInactiveClass,
                  )}
                >
                  {c.label}
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {c.count}
                  </span>
                </Link>
              ))}
            </div>
          </aside>

          <div className="min-w-0 flex-1 space-y-6">
            {worksReturn}
            <p className="max-w-2xl text-xs text-muted-foreground/80">
              Every connector here is a real connection: you sign in with your
              own account (OAuth) or bot token and grant permission directly.
              Google Analytics and Search Console are connected separately, so
              each can use a different Google account.
            </p>

            {visibleConnectors.length === 0 ? (
              <EmptyState
                icon={Plug}
                title="No connectors found"
                hint="Try a different search or category."
              />
            ) : (
              <IntegrationSection title={sectionTitle}>
                {visibleConnectors.map((c) => c.node)}
              </IntegrationSection>
            )}
          </div>
        </div>

        {openTelegram ? (
          <TelegramDialog
            projectId={projectId}
            credential={telegramCredential}
            closeHref={closeHref}
          />
        ) : null}

        {openGoogleService ? (
          <GoogleDialog
            service={openGoogleService}
            projectId={projectId}
            credential={
              openGoogleService === "analytics"
                ? analyticsCredential
                : searchConsoleCredential
            }
            closeHref={closeHref}
            googleError={googleError}
          />
        ) : null}

        {openMetaService ? (
          <MetaDialog
            service={openMetaService}
            projectId={projectId}
            credential={
              openMetaService === "instagram"
                ? instagramCredential
                : metaAdsCredential
            }
            closeHref={closeHref}
            metaError={metaError}
          />
        ) : null}

        {openTikTok ? (
          <TikTokDialog
            projectId={projectId}
            credential={tiktokCredential}
            closeHref={closeHref}
            tiktokError={tiktokError}
          />
        ) : null}

        {openLinkedIn ? (
          <LinkedInDialog
            projectId={projectId}
            credential={linkedinCredential}
            closeHref={closeHref}
            linkedinError={linkedinError}
          />
        ) : null}

        {openX ? (
          <XDialog
            projectId={projectId}
            credential={xCredential}
            closeHref={closeHref}
            xError={xError}
          />
        ) : null}
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------

type ConnectionTone = "positive" | "waiting" | "neutral";

// Shared card for the Integrations page — a neutral (colorless) icon badge,
// status badge on top, title + short description below. A single, clean
// visual language instead of brand-colored boxes; thanks to the grid in
// IntegrationSection, the cards line up side by side.
function IntegrationRow({
  href,
  icon: Icon,
  title,
  subtitle,
  badge,
}: {
  href: string;
  icon: LucideIcon;
  title: string;
  subtitle: string;
  badge: { label: string; tone: ConnectionTone };
}) {
  return (
    <Link
      href={href}
      className="flex flex-col gap-3 rounded-xl border border-border p-3.5 transition-colors hover:bg-muted/50"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
          <Icon className="size-4" strokeWidth={1.75} />
        </span>
        <StatusBadge meta={{ label: badge.label, tone: badge.tone }} />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
      </div>
    </Link>
  );
}

function IntegrationSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        {title}
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {children}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Telegram — not a BrowserProfile; a separate connection model based on
// IntegrationCredential (Bot API token). It's actually validated against
// Telegram during setup (see connectTelegramAction) — no mock/demo path.

function TelegramTile({
  base,
  kategori,
  credential,
}: {
  base: string;
  kategori: string | undefined;
  credential: IntegrationCredential | null;
}) {
  const connected = credential?.status === "ACTIVE";
  const params = new URLSearchParams({ integration: "telegram" });
  if (kategori) params.set("kategori", kategori);

  return (
    <IntegrationRow
      href={`${base}?${params.toString()}`}
      icon={Send}
      title="Telegram"
      subtitle={
        connected
          ? (credential.accountLabel ?? "Connected")
          : credential
            ? "Disconnected"
            : "Connect for approvals and notifications"
      }
      badge={
        connected
          ? { label: "Connected", tone: "positive" }
          : credential
            ? { label: "Disconnected", tone: "waiting" }
            : { label: "Not connected", tone: "neutral" }
      }
    />
  );
}

function TelegramDialog({
  projectId,
  credential,
  closeHref,
}: {
  projectId: string;
  credential: IntegrationCredential | null;
  closeHref: string;
}) {
  const metadata = (credential?.metadata ?? {}) as {
    chatId?: string;
    chatTitle?: string;
    allowedApproverIds?: string[];
  };
  const connected = credential?.status === "ACTIVE";

  return (
    <EntityDialog
      closeHref={closeHref}
      title="Telegram"
      header={
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
            <Send className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">Telegram</p>
            <p className="text-xs text-muted-foreground">
              Send broadcasts to a channel/group
            </p>
          </div>
        </div>
      }
      size="md"
      bodyClassName="space-y-4 overflow-y-auto p-4"
    >
      {credential ? (
        <div className="space-y-2 rounded-lg p-3 ring-1 ring-foreground/10">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-sm font-medium">
              {credential.accountLabel ?? "Telegram bot"}
            </p>
            <StatusBadge
              meta={
                connected
                  ? { label: "Connected", tone: "positive" }
                  : { label: "Not connected", tone: "neutral" }
              }
            />
          </div>
          {metadata.chatTitle ? (
            <p className="text-[11px] text-muted-foreground">
              Target: {metadata.chatTitle}
            </p>
          ) : null}
          {connected ? (
            <ActionForm
              action={updateTelegramApproversAction}
              successMessage="Approvers updated"
              className="space-y-1"
            >
              <input type="hidden" name="projectId" value={projectId} />
              <label className="text-[11px] font-medium text-muted-foreground">
                Telegram user IDs with approval authority
              </label>
              <div className="flex items-center gap-1.5">
                <Input
                  name="allowedApproverIds"
                  placeholder="123456789, 987654321"
                  defaultValue={metadata.allowedApproverIds?.join(", ") ?? ""}
                  className="h-7 text-xs"
                />
                <SubmitButton size="xs" variant="outline">
                  Save
                </SubmitButton>
              </div>
              <p className="text-[10px] text-muted-foreground/70">
                If left empty, approval messages are sent for informational
                purposes only, with no button. You can find your own ID via
                @userinfobot.
              </p>
            </ActionForm>
          ) : null}
          {connected ? (
            <div className="flex items-center justify-end gap-1.5">
              <ActionForm
                action={disconnectTelegramAction}
                successMessage="Disconnected"
              >
                <input type="hidden" name="projectId" value={projectId} />
                <SubmitButton variant="outline" size="xs">
                  Disconnect
                </SubmitButton>
              </ActionForm>
              <ActionForm
                action={sendTelegramTestMessageAction}
                successMessage="Test message sent — check Telegram"
              >
                <input type="hidden" name="projectId" value={projectId} />
                <SubmitButton size="xs">Send Test Message</SubmitButton>
              </ActionForm>
            </div>
          ) : null}
        </div>
      ) : (
        <EmptyState
          icon={Send}
          title="Not connected yet"
          hint="Connect below by entering the bot token and target chat."
          className="py-8"
        />
      )}

      <div className="border-t border-foreground/10 pt-4">
        <TelegramConnectForm
          projectId={projectId}
          hasExistingConnection={credential !== null}
        />
      </div>
    </EntityDialog>
  );
}

// ---------------------------------------------------------------------------
// Google — two separate real OAuth connections based on IntegrationCredential:
// Google Analytics (provider: "google_analytics") and Google Search Console
// (provider: "google_search_console"). Each has its own grant with only its
// own read-only scope, so they can use different Google accounts and be
// disconnected independently.

const GOOGLE_ERROR_MESSAGES: Record<string, string> = {
  denied: "Google permission was denied.",
  not_configured: "This integration hasn't been configured yet.",
  no_refresh_token: "Google didn't return a refresh token, please try again.",
  exchange_failed:
    "Couldn't establish a connection with Google, please try again.",
  state_invalid:
    "The connection request expired or is invalid, please try again.",
  unauthorized: "Your session has expired, please sign in again and retry.",
};

const GOOGLE_SERVICE_UI: Record<
  GoogleService,
  { icon: LucideIcon; description: string; emptyHint: string }
> = {
  analytics: {
    icon: BarChart3,
    description: "Read-only access to GA4 traffic data",
    emptyHint:
      "Connect with your Google account, then select the GA4 property to track.",
  },
  search_console: {
    icon: Search,
    description: "Read-only access to Search Console queries",
    emptyHint:
      "Connect with your Google account, then select the Search Console site to track.",
  },
};

function googleStartHref(projectId: string, service: GoogleService): string {
  return `/api/integrations/google/start?projectId=${projectId}&service=${service}`;
}

// The raw Search Console `siteUrl` looks technical (sc-domain:example.com
// or https://example.com/) — we show a clean domain in the selection list
// and provide the property type (Domain/HTTPS/HTTP) as a hint; since the
// same domain can be separately verified for both http and https, this
// distinction is genuinely meaningful, not just cosmetic.
function formatSearchConsoleSite(siteUrl: string): {
  label: string;
  hint?: string;
} {
  if (siteUrl.startsWith("sc-domain:")) {
    return { label: siteUrl.slice("sc-domain:".length), hint: "Domain" };
  }
  try {
    const url = new URL(siteUrl);
    const path = url.pathname === "/" ? "" : url.pathname;
    return {
      label: `${url.hostname}${path}`,
      hint: url.protocol === "https:" ? "HTTPS" : "HTTP",
    };
  } catch {
    return { label: siteUrl };
  }
}

function GoogleTile({
  service,
  base,
  kategori,
  credential,
}: {
  service: GoogleService;
  base: string;
  kategori: string | undefined;
  credential: IntegrationCredential | null;
}) {
  const connected = credential?.status === "ACTIVE";
  const expired = credential?.status === "EXPIRED";
  const params = new URLSearchParams({ integration: GOOGLE_PROVIDER[service] });
  if (kategori) params.set("kategori", kategori);
  const ui = GOOGLE_SERVICE_UI[service];

  return (
    <IntegrationRow
      href={`${base}?${params.toString()}`}
      icon={ui.icon}
      title={GOOGLE_SERVICE_LABEL[service]}
      subtitle={
        connected
          ? (credential.accountLabel ?? "Connected")
          : expired
            ? "Needs reconnection"
            : ui.description
      }
      badge={
        connected
          ? { label: "Connected", tone: "positive" }
          : expired
            ? { label: "Needs reconnection", tone: "waiting" }
            : { label: "Not connected", tone: "neutral" }
      }
    />
  );
}

function GoogleDialog({
  service,
  projectId,
  credential,
  closeHref,
  googleError,
}: {
  service: GoogleService;
  projectId: string;
  credential: IntegrationCredential | null;
  closeHref: string;
  googleError: string | null;
}) {
  const connected = credential?.status === "ACTIVE";
  const expired = credential?.status === "EXPIRED";
  const configured = isIntegrationConfigured("GOOGLE");
  const title = GOOGLE_SERVICE_LABEL[service];
  const ui = GOOGLE_SERVICE_UI[service];
  const Icon = ui.icon;
  const hiddenFields = { projectId, service };

  return (
    <EntityDialog
      closeHref={closeHref}
      title={title}
      header={
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
            <Icon className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">{title}</p>
            <p className="text-xs text-muted-foreground">{ui.description}</p>
          </div>
        </div>
      }
      size="md"
      bodyClassName="space-y-4 overflow-y-auto p-4"
    >
      {googleError ? (
        <p className="rounded-lg bg-destructive/10 p-2.5 text-xs text-destructive">
          {GOOGLE_ERROR_MESSAGES[googleError] ??
            "Something went wrong, please try again."}
        </p>
      ) : null}

      {credential && (connected || expired) ? (
        <div className="space-y-3 rounded-lg p-3 ring-1 ring-foreground/10">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-sm font-medium">
              {credential.accountLabel ?? "Google account"}
            </p>
            <StatusBadge
              meta={
                connected
                  ? { label: "Connected", tone: "positive" }
                  : { label: "Needs reconnection", tone: "waiting" }
              }
            />
          </div>

          {expired ? (
            // Next <Link>'s RSC-fetch-based soft navigation hits a CORS
            // preflight because this route redirects to Google's OAuth
            // dialog (cross-origin) — a plain <a> does a full page
            // navigation and bypasses this entirely.
            <a
              href={googleStartHref(projectId, service)}
              className={cn(buttonVariants({ size: "xs" }))}
            >
              Reconnect
            </a>
          ) : (
            <>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {service === "analytics"
                      ? "GA4 Property"
                      : "Search Console Site"}
                  </span>
                  <ActionForm
                    action={refreshGoogleListsAction}
                    successMessage="List updated"
                  >
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="service" value={service} />
                    <SubmitButton
                      variant="ghost"
                      size="icon-xs"
                      title="Fetch newly added properties/sites from Google"
                    >
                      <RefreshCw className="size-3.5" />
                    </SubmitButton>
                  </ActionForm>
                </div>
                {service === "analytics" ? (
                  <Ga4PropertySelect
                    metadata={credential.metadata as GoogleAnalyticsMetadata}
                    hiddenFields={hiddenFields}
                  />
                ) : (
                  <SearchConsoleSiteSelect
                    metadata={
                      credential.metadata as GoogleSearchConsoleMetadata
                    }
                    hiddenFields={hiddenFields}
                  />
                )}
              </div>

              <GoogleLastTestResult
                service={service}
                metadata={
                  credential.metadata as
                    | GoogleAnalyticsMetadata
                    | GoogleSearchConsoleMetadata
                }
              />

              <div className="flex items-center justify-end gap-1.5">
                <ActionForm
                  action={disconnectGoogleAction}
                  successMessage="Disconnected"
                >
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="service" value={service} />
                  <SubmitButton variant="outline" size="xs">
                    Disconnect
                  </SubmitButton>
                </ActionForm>
                <ActionForm
                  action={testGoogleConnectionAction}
                  successMessage="Test successful"
                >
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="service" value={service} />
                  <SubmitButton size="xs">Run Test</SubmitButton>
                </ActionForm>
              </div>
            </>
          )}
        </div>
      ) : (
        <EmptyState
          icon={Icon}
          title="Not connected yet"
          hint={ui.emptyHint}
          className="py-8"
        >
          {/* Plain <a>: see the note above "Reconnect" — <Link>'s RSC-fetch
              navigation throws a CORS error on the cross-origin OAuth
              redirect. */}
          <a
            href={googleStartHref(projectId, service)}
            className={cn(
              buttonVariants({ size: "xs" }),
              !configured && "pointer-events-none opacity-50",
            )}
            aria-disabled={!configured}
          >
            Connect with Google
          </a>
        </EmptyState>
      )}
    </EntityDialog>
  );
}

function Ga4PropertySelect({
  metadata,
  hiddenFields,
}: {
  metadata: GoogleAnalyticsMetadata;
  hiddenFields: Record<string, string>;
}) {
  const properties = metadata.ga4Properties ?? [];
  if (properties.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        {metadata.ga4ListError ?? "No accessible property found"}
      </p>
    );
  }
  return (
    <SearchableSelect
      value={metadata.selectedGa4PropertyId ?? ""}
      placeholder="Select a property…"
      searchPlaceholder="Search properties…"
      options={properties.map((p) => ({
        value: p.propertyId,
        label: p.propertyName,
        hint: p.accountName || undefined,
      }))}
      action={selectGa4PropertyAction}
      hiddenFields={hiddenFields}
      fieldName="propertyId"
      successMessage="GA4 property updated"
    />
  );
}

function SearchConsoleSiteSelect({
  metadata,
  hiddenFields,
}: {
  metadata: GoogleSearchConsoleMetadata;
  hiddenFields: Record<string, string>;
}) {
  const sites = metadata.searchConsoleSites ?? [];
  if (sites.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        {metadata.gscListError ?? "No accessible site found"}
      </p>
    );
  }
  return (
    <SearchableSelect
      value={metadata.selectedSearchConsoleSite ?? ""}
      placeholder="Select a site…"
      searchPlaceholder="Search sites…"
      options={sites.map((s) => ({
        value: s.siteUrl,
        ...formatSearchConsoleSite(s.siteUrl),
      }))}
      action={selectSearchConsoleSiteAction}
      hiddenFields={hiddenFields}
      fieldName="siteUrl"
      successMessage="Search Console site updated"
    />
  );
}

function GoogleLastTestResult({
  service,
  metadata,
}: {
  service: GoogleService;
  metadata: GoogleAnalyticsMetadata | GoogleSearchConsoleMetadata;
}) {
  const result = metadata.lastTestResult;
  if (!result) return null;

  let summary: string;
  if (result.error) {
    summary = result.error;
  } else if (service === "analytics") {
    const ga = result as NonNullable<GoogleAnalyticsMetadata["lastTestResult"]>;
    summary = `GA4: ${ga.ga4ActiveUsers ?? 0} users (7d)`;
  } else {
    const gsc = result as NonNullable<
      GoogleSearchConsoleMetadata["lastTestResult"]
    >;
    summary = `${gsc.gscClicks ?? 0} clicks / ${gsc.gscImpressions ?? 0} impressions (7d)`;
  }

  return (
    <p className="text-[11px] text-muted-foreground">
      Last test ({timeAgo(result.testedAt)}): {summary}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Meta — two separate real OAuth connections based on IntegrationCredential:
// Instagram (provider: "instagram", Content Publishing) and Meta Ads
// (provider: "meta_ads", Marketing API). Each has its own grant with only
// the permissions that service needs, so they can use different Facebook
// accounts and be disconnected independently.

const META_ERROR_MESSAGES: Record<string, string> = {
  denied: "Meta permission was denied.",
  not_configured: "This integration hasn't been configured yet.",
  exchange_failed:
    "Couldn't establish a connection with Meta, please try again.",
  state_invalid:
    "The connection request expired or is invalid, please try again.",
  unauthorized: "Your session has expired, please sign in again and retry.",
};

const META_SERVICE_UI: Record<
  MetaService,
  { icon: LucideIcon; description: string; emptyHint: string }
> = {
  instagram: {
    icon: PURPOSE_ICONS.INSTAGRAM.icon,
    description: "Publish posts and stories to Instagram",
    emptyHint:
      "Connect your Facebook account, then choose the Page linked to your Instagram Business account.",
  },
  ads: {
    icon: PURPOSE_ICONS.META_ADS.icon,
    description: "Manage Meta ad campaigns and read performance",
    emptyHint:
      "Connect your Facebook account, then choose your ad account and the Page your ads run as.",
  },
};

function metaStartHref(projectId: string, service: MetaService): string {
  return `/api/integrations/meta/start?projectId=${projectId}&service=${service}`;
}

function MetaTile({
  service,
  base,
  kategori,
  credential,
}: {
  service: MetaService;
  base: string;
  kategori: string | undefined;
  credential: IntegrationCredential | null;
}) {
  const connected = credential?.status === "ACTIVE";
  const expired = credential?.status === "EXPIRED";
  const params = new URLSearchParams({ integration: META_PROVIDER[service] });
  if (kategori) params.set("kategori", kategori);
  const ui = META_SERVICE_UI[service];

  return (
    <IntegrationRow
      href={`${base}?${params.toString()}`}
      icon={ui.icon}
      title={META_SERVICE_LABEL[service]}
      subtitle={
        connected
          ? (credential.accountLabel ?? "Connected")
          : expired
            ? "Needs reconnection"
            : ui.description
      }
      badge={
        connected
          ? { label: "Connected", tone: "positive" }
          : expired
            ? { label: "Needs reconnection", tone: "waiting" }
            : { label: "Not connected", tone: "neutral" }
      }
    />
  );
}

function MetaDialog({
  service,
  projectId,
  credential,
  closeHref,
  metaError,
}: {
  service: MetaService;
  projectId: string;
  credential: IntegrationCredential | null;
  closeHref: string;
  metaError: string | null;
}) {
  const connected = credential?.status === "ACTIVE";
  const expired = credential?.status === "EXPIRED";
  const configured = isIntegrationConfigured("META");
  const title = META_SERVICE_LABEL[service];
  const ui = META_SERVICE_UI[service];
  const Icon = ui.icon;
  const hiddenFields = { projectId, service };
  const metadata = (credential?.metadata ?? {}) as
    | MetaInstagramMetadata
    | MetaAdsMetadata;
  const adsMetadata = metadata as MetaAdsMetadata;

  return (
    <EntityDialog
      closeHref={closeHref}
      title={title}
      header={
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
            <Icon className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">{title}</p>
            <p className="text-xs text-muted-foreground">{ui.description}</p>
          </div>
        </div>
      }
      size="md"
      bodyClassName="space-y-4 overflow-y-auto p-4"
    >
      {metaError ? (
        <p className="rounded-lg bg-destructive/10 p-2.5 text-xs text-destructive">
          {META_ERROR_MESSAGES[metaError] ??
            "Something went wrong, please try again."}
        </p>
      ) : null}

      {credential && (connected || expired) ? (
        <div className="space-y-3 rounded-lg p-3 ring-1 ring-foreground/10">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-sm font-medium">
              {credential.accountLabel ?? "Meta account"}
            </p>
            <StatusBadge
              meta={
                connected
                  ? { label: "Connected", tone: "positive" }
                  : { label: "Needs reconnect", tone: "waiting" }
              }
            />
          </div>

          {expired ? (
            // Plain <a>: see the note in the Google block — <Link>'s RSC-fetch
            // navigation triggers a CORS error against Meta's (cross-origin)
            // OAuth dialog.
            <a
              href={metaStartHref(projectId, service)}
              className={cn(buttonVariants({ size: "xs" }))}
            >
              Reconnect
            </a>
          ) : (
            <>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    {service === "instagram"
                      ? "Facebook Page (Instagram)"
                      : "Facebook Page (ads run as)"}
                  </span>
                  {(metadata.pages ?? []).length > 0 ? (
                    <ModeSwitcher
                      value={metadata.selectedPageId ?? ""}
                      options={metadata.pages.map((p) => ({
                        value: p.pageId,
                        label: p.instagramUsername
                          ? `${p.pageName} (@${p.instagramUsername})`
                          : p.pageName,
                      }))}
                      action={selectMetaPageAction}
                      hiddenFields={hiddenFields}
                      fieldName="pageId"
                      successMessage="Page updated"
                    />
                  ) : (
                    <span className="text-[11px] text-muted-foreground">
                      {metadata.pagesListError ?? "No accessible Page found"}
                    </span>
                  )}
                </div>
                {service === "ads" ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted-foreground">
                      Ad Account
                    </span>
                    {(adsMetadata.adAccounts ?? []).length > 0 ? (
                      <ModeSwitcher
                        value={adsMetadata.selectedAdAccountId ?? ""}
                        options={adsMetadata.adAccounts.map((a) => ({
                          value: a.adAccountId,
                          label: a.adAccountName,
                        }))}
                        action={selectMetaAdAccountAction}
                        hiddenFields={hiddenFields}
                        fieldName="adAccountId"
                        successMessage="Ad account updated"
                      />
                    ) : (
                      <span className="text-[11px] text-muted-foreground">
                        {adsMetadata.adAccountsListError ??
                          "No accessible ad account found"}
                      </span>
                    )}
                  </div>
                ) : null}
              </div>

              <MetaLastTestResult service={service} metadata={metadata} />

              <div className="flex items-center justify-end gap-1.5">
                <ActionForm
                  action={disconnectMetaAction}
                  successMessage="Disconnected"
                >
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="service" value={service} />
                  <SubmitButton variant="outline" size="xs">
                    Disconnect
                  </SubmitButton>
                </ActionForm>
                <ActionForm
                  action={testMetaConnectionAction}
                  successMessage="Test successful"
                >
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="service" value={service} />
                  <SubmitButton size="xs">Test</SubmitButton>
                </ActionForm>
              </div>
            </>
          )}
        </div>
      ) : (
        <EmptyState
          icon={Icon}
          title="Not connected yet"
          hint={ui.emptyHint}
          className="py-8"
        >
          {/* Plain <a>: see the note in the Google block. */}
          <a
            href={metaStartHref(projectId, service)}
            className={cn(
              buttonVariants({ size: "xs" }),
              !configured && "pointer-events-none opacity-50",
            )}
            aria-disabled={!configured}
          >
            Connect with Meta
          </a>
        </EmptyState>
      )}
    </EntityDialog>
  );
}

function MetaLastTestResult({
  service,
  metadata,
}: {
  service: MetaService;
  metadata: MetaInstagramMetadata | MetaAdsMetadata;
}) {
  const result = metadata.lastTestResult;
  if (!result) return null;

  let summary: string;
  if (result.error) {
    summary = result.error;
  } else if (service === "instagram") {
    const ig = result as NonNullable<MetaInstagramMetadata["lastTestResult"]>;
    summary = ig.igUsername ? `IG: @${ig.igUsername}` : "OK";
  } else {
    const ads = result as NonNullable<MetaAdsMetadata["lastTestResult"]>;
    summary = `Spend (7d): ${ads.adAccountSpend ?? 0}`;
  }

  return (
    <p className="text-[11px] text-muted-foreground">
      Last test ({timeAgo(result.testedAt)}): {summary}
    </p>
  );
}

// ---------------------------------------------------------------------------
// TikTok / LinkedIn / X — the same real, IntegrationCredential-based OAuth
// pattern as Google/Meta (see src/server/integrations/{tiktok,linkedin,x}-
// client.ts). They replace the old BrowserProfile-based TIKTOK/LINKEDIN/X
// purposes (see the note in LEGACY_PURPOSE_CATEGORY) — their BrowserProfilePurpose
// counterpart still exists in execution-policy.ts for the OpenClaw
// fallback, but it's no longer shown as a separate placeholder tile on
// this page.

const TIKTOK_ERROR_MESSAGES: Record<string, string> = {
  denied: "TikTok permission was denied.",
  not_configured: "This integration hasn't been configured yet.",
  exchange_failed: "Couldn't connect to TikTok, please try again.",
  state_invalid:
    "The connection request expired or is invalid, please try again.",
  unauthorized: "Your session has expired, please sign in again.",
};

function TikTokTile({
  base,
  kategori,
  credential,
}: {
  base: string;
  kategori: string | undefined;
  credential: IntegrationCredential | null;
}) {
  const connected = credential?.status === "ACTIVE";
  const expired = credential?.status === "EXPIRED";
  const params = new URLSearchParams({ integration: "tiktok" });
  if (kategori) params.set("kategori", kategori);

  return (
    <IntegrationRow
      href={`${base}?${params.toString()}`}
      icon={PURPOSE_ICONS.TIKTOK.icon}
      title="TikTok"
      subtitle={
        connected
          ? (credential.accountLabel ?? "Connected")
          : expired
            ? "Needs reconnecting"
            : "Video publishing via Content Posting API"
      }
      badge={
        connected
          ? { label: "Connected", tone: "positive" }
          : expired
            ? { label: "Needs reconnecting", tone: "waiting" }
            : { label: "Not connected", tone: "neutral" }
      }
    />
  );
}

function TikTokDialog({
  projectId,
  credential,
  closeHref,
  tiktokError,
}: {
  projectId: string;
  credential: IntegrationCredential | null;
  closeHref: string;
  tiktokError: string | null;
}) {
  const metadata = (credential?.metadata ?? {}) as TikTokCredentialMetadata;
  const connected = credential?.status === "ACTIVE";
  const expired = credential?.status === "EXPIRED";
  const configured = isIntegrationConfigured("TIKTOK");

  return (
    <EntityDialog
      closeHref={closeHref}
      title="TikTok"
      header={
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
            <PURPOSE_ICONS.TIKTOK.icon className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">TikTok</p>
            <p className="text-xs text-muted-foreground">
              Access for video publishing via Content Posting API
            </p>
          </div>
        </div>
      }
      size="md"
      bodyClassName="space-y-4 overflow-y-auto p-4"
    >
      {tiktokError ? (
        <p className="rounded-lg bg-destructive/10 p-2.5 text-xs text-destructive">
          {TIKTOK_ERROR_MESSAGES[tiktokError] ??
            "Something went wrong, please try again."}
        </p>
      ) : null}

      <p className="rounded-lg bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
        While this app is unaudited by TikTok, published videos are forced to
        private (self-only) visibility. Public visibility requires TikTok&apos;s
        client audit process.
      </p>

      {credential && (connected || expired) ? (
        <div className="space-y-3 rounded-lg p-3 ring-1 ring-foreground/10">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-sm font-medium">
              {credential.accountLabel ?? "TikTok account"}
            </p>
            <StatusBadge
              meta={
                connected
                  ? { label: "Connected", tone: "positive" }
                  : { label: "Needs reconnecting", tone: "waiting" }
              }
            />
          </div>

          {expired ? (
            <a
              href={`/api/integrations/tiktok/start?projectId=${projectId}`}
              className={cn(buttonVariants({ size: "xs" }))}
            >
              Reconnect
            </a>
          ) : (
            <>
              {metadata.lastTestResult ? (
                <p className="text-[11px] text-muted-foreground">
                  Last test ({timeAgo(metadata.lastTestResult.testedAt)}):{" "}
                  {metadata.lastTestResult.error ??
                    metadata.lastTestResult.displayName ??
                    "OK"}
                </p>
              ) : null}

              <div className="flex items-center justify-end gap-1.5">
                <ActionForm
                  action={disconnectTikTokAction}
                  successMessage="Disconnected"
                >
                  <input type="hidden" name="projectId" value={projectId} />
                  <SubmitButton variant="outline" size="xs">
                    Disconnect
                  </SubmitButton>
                </ActionForm>
                <ActionForm
                  action={testTikTokConnectionAction}
                  successMessage="Test successful"
                >
                  <input type="hidden" name="projectId" value={projectId} />
                  <SubmitButton size="xs">Test</SubmitButton>
                </ActionForm>
              </div>
            </>
          )}
        </div>
      ) : (
        <EmptyState
          icon={PURPOSE_ICONS.TIKTOK.icon}
          title="Not connected yet"
          hint="Connect with your TikTok account to enable video publishing."
          className="py-8"
        >
          <a
            href={`/api/integrations/tiktok/start?projectId=${projectId}`}
            className={cn(
              buttonVariants({ size: "xs" }),
              !configured && "pointer-events-none opacity-50",
            )}
            aria-disabled={!configured}
          >
            Connect with TikTok
          </a>
        </EmptyState>
      )}
    </EntityDialog>
  );
}

// ---------------------------------------------------------------------------

const LINKEDIN_ERROR_MESSAGES: Record<string, string> = {
  denied: "LinkedIn permission was denied.",
  not_configured: "This integration hasn't been configured yet.",
  exchange_failed: "Couldn't connect to LinkedIn, please try again.",
  state_invalid:
    "The connection request expired or is invalid, please try again.",
  unauthorized: "Your session has expired, please sign in again.",
};

function LinkedInTile({
  base,
  kategori,
  credential,
}: {
  base: string;
  kategori: string | undefined;
  credential: IntegrationCredential | null;
}) {
  const connected = credential?.status === "ACTIVE";
  const expired = credential?.status === "EXPIRED";
  const params = new URLSearchParams({ integration: "linkedin" });
  if (kategori) params.set("kategori", kategori);

  return (
    <IntegrationRow
      href={`${base}?${params.toString()}`}
      icon={PURPOSE_ICONS.LINKEDIN.icon}
      title="LinkedIn"
      subtitle={
        connected
          ? (credential.accountLabel ?? "Connected")
          : expired
            ? "Needs reconnecting"
            : "Personal profile post publishing"
      }
      badge={
        connected
          ? { label: "Connected", tone: "positive" }
          : expired
            ? { label: "Needs reconnecting", tone: "waiting" }
            : { label: "Not connected", tone: "neutral" }
      }
    />
  );
}

function LinkedInDialog({
  projectId,
  credential,
  closeHref,
  linkedinError,
}: {
  projectId: string;
  credential: IntegrationCredential | null;
  closeHref: string;
  linkedinError: string | null;
}) {
  const metadata = (credential?.metadata ?? {}) as LinkedInCredentialMetadata;
  const connected = credential?.status === "ACTIVE";
  const expired = credential?.status === "EXPIRED";
  const configured = isIntegrationConfigured("LINKEDIN");

  return (
    <EntityDialog
      closeHref={closeHref}
      title="LinkedIn"
      header={
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
            <PURPOSE_ICONS.LINKEDIN.icon className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">LinkedIn</p>
            <p className="text-xs text-muted-foreground">
              Access for personal profile post publishing
            </p>
          </div>
        </div>
      }
      size="md"
      bodyClassName="space-y-4 overflow-y-auto p-4"
    >
      {linkedinError ? (
        <p className="rounded-lg bg-destructive/10 p-2.5 text-xs text-destructive">
          {LINKEDIN_ERROR_MESSAGES[linkedinError] ??
            "Something went wrong, please try again."}
        </p>
      ) : null}

      {credential && (connected || expired) ? (
        <div className="space-y-3 rounded-lg p-3 ring-1 ring-foreground/10">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-sm font-medium">
              {credential.accountLabel ?? "LinkedIn account"}
            </p>
            <StatusBadge
              meta={
                connected
                  ? { label: "Connected", tone: "positive" }
                  : { label: "Needs reconnecting", tone: "waiting" }
              }
            />
          </div>

          {!metadata.hasRefreshToken ? (
            <p className="text-[11px] text-muted-foreground">
              No refresh token on this connection — LinkedIn access tokens
              expire after ~60 days, you&apos;ll need to reconnect then.
            </p>
          ) : null}

          {expired ? (
            <a
              href={`/api/integrations/linkedin/start?projectId=${projectId}`}
              className={cn(buttonVariants({ size: "xs" }))}
            >
              Reconnect
            </a>
          ) : (
            <>
              {metadata.lastTestResult ? (
                <p className="text-[11px] text-muted-foreground">
                  Last test ({timeAgo(metadata.lastTestResult.testedAt)}):{" "}
                  {metadata.lastTestResult.error ??
                    metadata.lastTestResult.displayName ??
                    "OK"}
                </p>
              ) : null}

              <div className="flex items-center justify-end gap-1.5">
                <ActionForm
                  action={disconnectLinkedInAction}
                  successMessage="Disconnected"
                >
                  <input type="hidden" name="projectId" value={projectId} />
                  <SubmitButton variant="outline" size="xs">
                    Disconnect
                  </SubmitButton>
                </ActionForm>
                <ActionForm
                  action={testLinkedInConnectionAction}
                  successMessage="Test successful"
                >
                  <input type="hidden" name="projectId" value={projectId} />
                  <SubmitButton size="xs">Test</SubmitButton>
                </ActionForm>
              </div>
            </>
          )}
        </div>
      ) : (
        <EmptyState
          icon={PURPOSE_ICONS.LINKEDIN.icon}
          title="Not connected yet"
          hint="Connect with your LinkedIn account to enable post publishing."
          className="py-8"
        >
          <a
            href={`/api/integrations/linkedin/start?projectId=${projectId}`}
            className={cn(
              buttonVariants({ size: "xs" }),
              !configured && "pointer-events-none opacity-50",
            )}
            aria-disabled={!configured}
          >
            Connect with LinkedIn
          </a>
        </EmptyState>
      )}
    </EntityDialog>
  );
}

// ---------------------------------------------------------------------------

const X_ERROR_MESSAGES: Record<string, string> = {
  denied: "X permission was denied.",
  not_configured: "This integration hasn't been configured yet.",
  exchange_failed: "Couldn't connect to X, please try again.",
  state_invalid:
    "The connection request expired or is invalid, please try again.",
  unauthorized: "Your session has expired, please sign in again.",
};

function XTile({
  base,
  kategori,
  credential,
}: {
  base: string;
  kategori: string | undefined;
  credential: IntegrationCredential | null;
}) {
  const connected = credential?.status === "ACTIVE";
  const expired = credential?.status === "EXPIRED";
  const params = new URLSearchParams({ integration: "x" });
  if (kategori) params.set("kategori", kategori);

  return (
    <IntegrationRow
      href={`${base}?${params.toString()}`}
      icon={PURPOSE_ICONS.X.icon}
      title="X"
      subtitle={
        connected
          ? (credential.accountLabel ?? "Connected")
          : expired
            ? "Needs reconnecting"
            : "Post publishing (pay-per-use)"
      }
      badge={
        connected
          ? { label: "Connected", tone: "positive" }
          : expired
            ? { label: "Needs reconnecting", tone: "waiting" }
            : { label: "Not connected", tone: "neutral" }
      }
    />
  );
}

function XDialog({
  projectId,
  credential,
  closeHref,
  xError,
}: {
  projectId: string;
  credential: IntegrationCredential | null;
  closeHref: string;
  xError: string | null;
}) {
  const metadata = (credential?.metadata ?? {}) as XCredentialMetadata;
  const connected = credential?.status === "ACTIVE";
  const expired = credential?.status === "EXPIRED";
  const configured = isIntegrationConfigured("X");

  return (
    <EntityDialog
      closeHref={closeHref}
      title="X"
      header={
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
            <PURPOSE_ICONS.X.icon className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">X</p>
            <p className="text-xs text-muted-foreground">
              Access for post publishing
            </p>
          </div>
        </div>
      }
      size="md"
      bodyClassName="space-y-4 overflow-y-auto p-4"
    >
      {xError ? (
        <p className="rounded-lg bg-destructive/10 p-2.5 text-xs text-destructive">
          {X_ERROR_MESSAGES[xError] ??
            "Something went wrong, please try again."}
        </p>
      ) : null}

      <p className="rounded-lg bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
        X removed its free API tier for new developers — each post created
        through this connection has a real, pay-per-use cost on X&apos;s side.
      </p>

      {credential && (connected || expired) ? (
        <div className="space-y-3 rounded-lg p-3 ring-1 ring-foreground/10">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-sm font-medium">
              {credential.accountLabel ?? "X account"}
            </p>
            <StatusBadge
              meta={
                connected
                  ? { label: "Connected", tone: "positive" }
                  : { label: "Needs reconnecting", tone: "waiting" }
              }
            />
          </div>

          {expired ? (
            <a
              href={`/api/integrations/x/start?projectId=${projectId}`}
              className={cn(buttonVariants({ size: "xs" }))}
            >
              Reconnect
            </a>
          ) : (
            <>
              {metadata.lastTestResult ? (
                <p className="text-[11px] text-muted-foreground">
                  Last test ({timeAgo(metadata.lastTestResult.testedAt)}):{" "}
                  {metadata.lastTestResult.error
                    ? metadata.lastTestResult.error
                    : metadata.lastTestResult.username
                      ? `@${metadata.lastTestResult.username}`
                      : "OK"}
                </p>
              ) : null}

              <div className="flex items-center justify-end gap-1.5">
                <ActionForm
                  action={disconnectXAction}
                  successMessage="Disconnected"
                >
                  <input type="hidden" name="projectId" value={projectId} />
                  <SubmitButton variant="outline" size="xs">
                    Disconnect
                  </SubmitButton>
                </ActionForm>
                <ActionForm
                  action={testXConnectionAction}
                  successMessage="Test successful"
                >
                  <input type="hidden" name="projectId" value={projectId} />
                  <SubmitButton size="xs">Test</SubmitButton>
                </ActionForm>
              </div>
            </>
          )}
        </div>
      ) : (
        <EmptyState
          icon={PURPOSE_ICONS.X.icon}
          title="Not connected yet"
          hint="Connect with your X account to enable post publishing."
          className="py-8"
        >
          <a
            href={`/api/integrations/x/start?projectId=${projectId}`}
            className={cn(
              buttonVariants({ size: "xs" }),
              !configured && "pointer-events-none opacity-50",
            )}
            aria-disabled={!configured}
          >
            Connect with X
          </a>
        </EmptyState>
      )}
    </EntityDialog>
  );
}
